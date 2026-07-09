import type { DataAdapter } from "obsidian";
import type { MinimalModelConfig } from "./llm-provider";
import { createEmbeddings } from "./text-embedding";
import { sha256 } from "../utils/hash";
import { truncate } from "../utils/string-truncate";
import { logger } from "../utils/logger";

const log = logger("[Embedder]");
import { isAbortError } from "../utils/abortable-request";
import {
	getEntryByteSize,
	FLAG_ACTIVE,
	FLAG_TOMBSTONE,
	serializeChunk,
	deserializeChunk,
	readManifest,
	writeManifest,
	type EmbedderManifest,
	type ChunkMeta,
	type HashIndexEntry,
	type ChunkEntry,
} from "./embedder-cache-io";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Runtime status of the embedding service.
 *
 * - `unused`: The embedder has not been invoked in the current session, so its
 *   availability is unknown.
 * - `unavailable`: The last invocation failed (e.g. network error, auth error,
 *   misconfiguration). Callers will fall back to full tool sets.
 * - `ok`: The most recent invocation succeeded.
 *
 * This is a runtime-only value and is intentionally NOT persisted.
 */
export type EmbedderStatus = 'unused' | 'unavailable' | 'ok';

/** Legacy v1 on-disk cache file schema (kept for migration). */
interface EmbedderCacheFileV1 {
	version: 1;
	signature: string;
	entries: Record<string, number[]>;
}

export interface EmbedderOptions {
	/**
	 * Optional initial provider configuration. If omitted, {@link Embedder.updateConfig}
	 * MUST be called at least once before {@link Embedder.embed}.
	 * This allows the embedder to be constructed at plugin startup, before the
	 * user has selected an active embedding profile.
	 */
	config?: MinimalModelConfig;
	/** Vault adapter used for sandboxed file I/O. */
	adapter: DataAdapter;
	/** Absolute (vault-relative) path to the cache JSON file (v1) or base name (v2). */
	cacheFilePath: string;
	/**
	 * Maximum number of cached entries before LRU eviction kicks in.
	 * Use 0 to disable eviction. Default: 1000.
	 */
	maxEntries?: number;
	/**
	 * Debounce interval (ms) for persisting the cache to disk after mutations.
	 * Default: 2000. Use 0 to disable auto-persist (manual flush only).
	 */
	flushDebounceMs?: number;
	/**
	 * Number of entries per chunk file. Default: 100.
	 * Smaller values reduce write amplification but increase file count.
	 */
	chunkCapacity?: number;
}

// ─────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────

interface PendingAddition {
	hashHex: string;
	vector: number[];
	chunkIndex: number;
}

// ─────────────────────────────────────────────
// Embedder
// ─────────────────────────────────────────────

/**
 * Wraps {@link createEmbeddings} with a persistent, fingerprint-scoped cache.
 *
 * Cache data is stored in a chunked binary format:
 * - `embedding-manifest.json` — lightweight index with LRU order and
 *   hash→(chunk, offset) mapping.
 * - `embedding-chunk-NNN.bin` — fixed-capacity binary files holding
 *   embedding vectors.
 *
 * - Cache key per entry: sha256(text).
 * - Cache-wide fingerprint: sha256(type | baseURL | model). When the fingerprint
 *   of the current config differs from the one stored on disk, the cache is
 *   discarded and rebuilt lazily.
 * - LRU order is tracked by re-insertion into the underlying Map; when the
 *   number of entries exceeds {@link EmbedderOptions.maxEntries}, the oldest
 *   entries are evicted (marked as tombstones in their chunks).
 * - Writes are debounced. Only dirty chunks and the manifest are rewritten.
 */
export class Embedder {
	private readonly adapter: DataAdapter;
	private readonly cacheFilePath: string;
	private readonly maxEntries: number;
	private readonly flushDebounceMs: number;
	private readonly chunkCapacity: number;

	private config: MinimalModelConfig | null;
	/** sha256(type | baseURL | model); computed lazily and memoized. */
	private signature: string | null = null;

	/** In-memory cache. Iteration order = insertion order = LRU recency. */
	private readonly entries: Map<string, number[]> = new Map();

	/** True once {@link load} has completed (successfully or not). */
	private loaded = false;
	/** In-flight load promise to deduplicate concurrent callers. */
	private loadPromise: Promise<void> | null = null;

	/** True when in-memory state has diverged from the on-disk file. */
	private dirty = false;
	/** Pending debounced flush timer. */
	private flushTimer: number | null = null;
	/** In-flight flush promise, for serializing writes. */
	private flushPromise: Promise<void> | null = null;

	// ── Chunked-cache state ──────────────────────────────────────────────

	/** List of chunk file names (vault-relative), newest last. */
	private chunkFiles: string[] = [];
	/**
	 * Map from hash(hex) → (chunk index, byte offset within entries section).
	 * Updated on load, addition, eviction, and compaction.
	 */
	private hashIndex: Map<string, HashIndexEntry> = new Map();
	/**
	 * Entries evicted since the last flush. Keyed by hash, value is the
	 * chunk+offset needed to write the tombstone flag.
	 */
	private pendingTombstones: Map<string, { chunk: number; offset: number }> = new Map();
	/** Entries added since the last flush. */
	private pendingAdditions: PendingAddition[] = [];
	/**
	 * Running count: total entries on disk in the latest chunk at the end
	 * of the last flush. Used together with {@link latestChunkPendingAdds}
	 * to decide when to create a new chunk.
	 */
	private latestChunkTotalOnDisk = 0;
	/** Number of pending additions targeting the latest chunk. */
	private latestChunkPendingAdds = 0;

	/** Whether the manifest needs rewriting. */
	private manifestDirty = false;
	/** Set of chunk indices that need rewriting. */
	private dirtyChunks: Set<number> = new Set();

	// ── Path helpers ─────────────────────────────────────────────────────

	private get cacheDir(): string {
		const lastSlash = this.cacheFilePath.lastIndexOf('/');
		return lastSlash >= 0 ? this.cacheFilePath.substring(0, lastSlash) : '.';
	}

	private get manifestPath(): string {
		return `${this.cacheDir}/embedding-manifest.json`;
	}

	private chunkFilePath(chunkIdx: number): string {
		return `${this.cacheDir}/embedding-chunk-${String(chunkIdx).padStart(3, '0')}.bin`;
	}

	// ── Runtime status ───────────────────────────────────────────────────

	/**
	 * Runtime status of the embedding service. Updated by {@link embed} based
	 * on the outcome of the most recent provider invocation. Not persisted.
	 */
	private _status: EmbedderStatus = 'unused';
	/**
	 * Short, human-readable reason for the most recent {@link _status} being
	 * `'unavailable'`. Cleared once the service returns to `'ok'`. Not
	 * persisted; intended to be surfaced in UI tooltips so users understand
	 * why embedding stopped working.
	 */
	private _lastErrorMessage: string | null = null;

	/**
	 * Estimated cumulative token count for texts that were actually sent
	 * to the embedding API (cache misses). Session-only; not persisted.
	 * Token counts are approximate (char-based heuristic) and labelled as
	 * estimated in the UI.
	 */
	private _apiTokenCount = 0;
	/**
	 * Estimated cumulative token count for ALL texts that entered
	 * {@link embed} (including cache hits). Session-only; not persisted.
	 */
	private _totalTokenCount = 0;

	constructor(opts: EmbedderOptions) {
		this.adapter = opts.adapter;
		this.cacheFilePath = opts.cacheFilePath;
		this.maxEntries = opts.maxEntries ?? 1000;
		this.flushDebounceMs = opts.flushDebounceMs ?? 2000;
		this.chunkCapacity = opts.chunkCapacity ?? 100;
		this.config = opts.config ?? null;
	}

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * Ensure the on-disk cache has been loaded into memory. Safe to call
	 * multiple times; subsequent calls are no-ops.
	 *
	 * If the persisted signature does not match the current config, the cache
	 * is treated as empty (the stale files will be overwritten on next flush).
	 */
	load(): Promise<void> {
		if (this.loaded) return Promise.resolve();
		if (this.loadPromise) return this.loadPromise;
		this.loadPromise = this.doLoad().finally(() => {
			this.loaded = true;
			this.loadPromise = null;
		});
		return this.loadPromise;
	}

	/**
	 * Embed a batch of texts, using the cache for hits and making a single
	 * batched API call for misses. Returns vectors in the same order as input.
	 */
	async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
		if (texts.length === 0) return [];
		if (!this.config) {
			throw new Error(
				"Embedder: no embedding config set. Call updateConfig() before embed().",
			);
		}

		await this.load();

		// Resolve per-text keys in parallel.
		const keys = await Promise.all(texts.map(t => sha256(t)));

		const result: (number[] | null)[] = new Array<number[] | null>(texts.length).fill(null);
		const missIndices: number[] = [];
		const missTexts: string[] = [];

		for (let i = 0; i < texts.length; i++) {
			const key = keys[i]!;
			const hit = this.entries.get(key);
			if (hit) {
				// Refresh LRU recency by re-inserting.
				this.entries.delete(key);
				this.entries.set(key, hit);
				result[i] = hit;
				// LRU order changed in Map → manifest needs rewrite.
				this.manifestDirty = true;
			} else {
				missIndices.push(i);
				missTexts.push(texts[i]!);
			}
		}

		const hitCount = texts.length - missTexts.length;
		log.debug(
			`Embedder: embed() received ${texts.length} text(s), cache hit=${hitCount}, miss=${missTexts.length}`,
		);

		// Count total tokens (all texts, including cache hits).
		for (const t of texts) {
			this._totalTokenCount += Embedder.estimateTokens(t);
		}

		if (missTexts.length > 0) {
			if (signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			let fresh: number[][];
			try {
				fresh = await createEmbeddings(this.config, missTexts, signal);
			} catch (err) {
				if (!isAbortError(err)) {
					this._status = 'unavailable';
					this._lastErrorMessage = Embedder.normalizeErrorMessage(err);
				}
				throw err;
			}
			if (fresh.length !== missTexts.length) {
				this._status = 'unavailable';
				const msg = `provider returned ${fresh.length} vectors for ${missTexts.length} inputs`;
				this._lastErrorMessage = msg;
				throw new Error(`Embedder: ${msg}`);
			}
			for (let j = 0; j < missIndices.length; j++) {
				const idx = missIndices[j]!;
				const vec = fresh[j]!;
				const key = keys[idx]!;

				this.entries.set(key, vec);
				result[idx] = vec;

				// Assign to a chunk and track the offset.
				const chunkIdx = this.findTargetChunk();
				const dim = vec.length;
				const entrySize = getEntryByteSize(dim);
				// Offset must account for entries already on disk in this chunk.
				const offset = (this.latestChunkTotalOnDisk + this.latestChunkPendingAdds) * entrySize;
				this.hashIndex.set(key, { chunk: chunkIdx, offset });
				this.latestChunkPendingAdds++;
				this.dirtyChunks.add(chunkIdx);
				this.pendingAdditions.push({ hashHex: key, vector: vec, chunkIndex: chunkIdx });
			}
			this.evictIfNeeded();
			this.manifestDirty = true;
			this.markDirty();
		} else if (hitCount > 0 && this.manifestDirty) {
			// Cache-only hits still need the LRU order persisted.
			this.markDirty();
		}

		// Count API tokens for cache misses that were sent to the provider.
		for (const t of missTexts) {
			this._apiTokenCount += Embedder.estimateTokens(t);
		}

		this._status = 'ok';
		this._lastErrorMessage = null;
		return result as number[][];
	}

	/** Convenience single-text wrapper around {@link embed}. */
	async embedOne(text: string, signal?: AbortSignal): Promise<number[]> {
		const [vec] = await this.embed([text], signal);
		return vec!;
	}

	/**
	 * Update the provider configuration. If the fingerprint changes, the
	 * in-memory cache is cleared immediately and the next flush will overwrite
	 * the on-disk files.
	 */
	async updateConfig(config: MinimalModelConfig): Promise<void> {
		const prevSig = this.config ? await this.getSignature() : null;
		this.config = config;
		this.signature = null;
		const nextSig = await this.getSignature();
		if (prevSig !== null && prevSig !== nextSig) {
			this.entries.clear();
			this.hashIndex.clear();
			this.pendingTombstones.clear();
			this.pendingAdditions = [];
			this.chunkFiles = [];
			this.latestChunkTotalOnDisk = 0;
			this.latestChunkPendingAdds = 0;
			this.dirtyChunks.clear();
			this.manifestDirty = true;
			this.markDirty();
		}
	}

	/** Clear the cache (in-memory and on disk on next flush). */
	clear(): void {
		if (this.entries.size === 0 && !this.manifestDirty && this.dirtyChunks.size === 0) return;
		this.entries.clear();
		this.hashIndex.clear();
		this.pendingTombstones.clear();
		this.pendingAdditions = [];
		this.chunkFiles = [];
		this.latestChunkTotalOnDisk = 0;
		this.latestChunkPendingAdds = 0;
		this._apiTokenCount = 0;
		this._totalTokenCount = 0;
		this.manifestDirty = true;
		// Mark all existing chunks for deletion — writeCacheFile will handle cleanup.
		this.markDirty();
	}

	/** Persist pending changes to disk immediately. No-op if not dirty. */
	async flush(): Promise<void> {
		if (this.flushTimer) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (!this.manifestDirty && this.dirtyChunks.size === 0) {
			// Still await any in-flight write to provide a strong barrier.
			if (this.flushPromise) await this.flushPromise;
			return;
		}
		return this.doFlush();
	}

	/** Current in-memory entry count (mostly for diagnostics/tests). */
	size(): number {
		return this.entries.size;
	}

	/** Current runtime status of the embedding service (not persisted). */
	get status(): EmbedderStatus {
		return this._status;
	}

	/**
	 * Short, human-readable reason for the most recent failure, or `null`
	 * when the service is not in an error state. Not persisted.
	 */
	get lastErrorMessage(): string | null {
		return this._lastErrorMessage;
	}

	/**
	 * Estimated cumulative token count for texts actually sent to the
	 * embedding API (cache misses). Session-only; reset on dispose.
	 */
	get apiTokenCount(): number {
		return this._apiTokenCount;
	}

	/**
	 * Estimated cumulative token count for ALL texts that have passed
	 * through {@link embed} (including cache hits). Session-only.
	 */
	get totalTokenCount(): number {
		return this._totalTokenCount;
	}

	// ── Internal helpers ────────────────────────────────────────────────────

	/**
	 * Estimate the token count of a text using a character-based heuristic.
	 *
	 * Approximation (no tokenizer dependency):
	 *   - CJK characters (U+4E00–U+9FFF, U+3400–U+4DBF, U+F900–U+FAFF,
	 *     U+3000–U+303F, U+FF00–U+FFEF): ~0.66 tokens per char (≈1.5 chars/token)
	 *   - Other characters: ~0.25 tokens per char (≈4 chars/token)
	 *
	 * This is intentionally lightweight. Accuracy is ±20–30 % depending on
	 * language mix; the UI labels the result as estimated.
	 */
	static estimateTokens(text: string): number {
		if (!text) return 0;
		let cjk = 0;
		let other = 0;
		for (let i = 0; i < text.length; i++) {
			const cp = text.charCodeAt(i);
			if (
				(cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK Unified Ideographs
				(cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Unified Ideographs Extension A
				(cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
				(cp >= 0x3000 && cp <= 0x303F) ||   // CJK Symbols and Punctuation
				(cp >= 0xFF00 && cp <= 0xFFEF)       // Halfwidth and Fullwidth Forms
			) {
				cjk++;
			} else {
				other++;
			}
		}
		// CJK: ~1.5 chars/token  →  ~0.67 tokens/char
		// Other: ~4 chars/token   →  ~0.25 tokens/char
		return Math.max(1, Math.round(cjk * 0.67 + other * 0.25));
	}

	/**
	 * Convert an arbitrary thrown value into a short, single-line message
	 * suitable for a UI tooltip. Collapses whitespace and truncates overly
	 * long messages (e.g. embedded response bodies or stack traces).
	 */
	private static normalizeErrorMessage(err: unknown): string {
		const raw = err instanceof Error ? err.message : String(err);
		const trimmed = raw.replace(/\s+/g, ' ').trim();
		if (!trimmed) return 'Unknown error';
		return truncate(trimmed, 200);
	}

	private async getSignature(): Promise<string> {
		if (this.signature !== null) return this.signature;
		if (!this.config) {
			throw new Error("Embedder: getSignature() called before config was set");
		}
		const raw = `${this.config.type}|${this.config.baseURL}|${this.config.model}`;
		this.signature = await sha256(raw);
		return this.signature;
	}

	// ── Loading ─────────────────────────────────────────────────────────

	private async doLoad(): Promise<void> {
		try {
			if (!this.config) {
				this.loaded = false;
				return;
			}

			// 1. Try the v2 manifest first.
			const manifest = await readManifest(this.adapter, this.manifestPath);
			if (manifest) {
				await this.loadFromManifest(manifest);
				return;
			}

			// 2. Fall back to v1 JSON → populate entries, will migrate on next flush.
			await this.loadFromV1();
		} catch (err) {
			console.warn("Embedder: failed to load cache, starting empty", err);
			this.entries.clear();
			this.hashIndex.clear();
		}
	}

	/** Load cache from a v2 manifest + chunk files. */
	private async loadFromManifest(manifest: EmbedderManifest): Promise<void> {
		const currentSig = await this.getSignature();
		if (manifest.signature !== currentSig) {
			// Fingerprint mismatch: discard the whole cache.
			return;
		}

		// Build chunk files list.
		this.chunkFiles = manifest.chunks.map(c => c.file);
		this.latestChunkTotalOnDisk = 0;
		this.latestChunkPendingAdds = 0;

		// Load each chunk and populate entries + hashIndex.
		const entriesByHash = new Map<string, number[]>();

		for (let ci = 0; ci < manifest.chunks.length; ci++) {
			const filePath = this.chunkFilePath(ci);
			try {
				if (!(await this.adapter.exists(filePath))) continue;
				const buf = await this.adapter.readBinary(filePath);
				const { entries: chunkEntries } = deserializeChunk(buf);
				for (const entry of chunkEntries) {
					if (entry.flags === FLAG_ACTIVE) {
						entriesByHash.set(entry.hashHex, entry.vector);
					}
				}
			} catch (err) {
				console.warn(`Embedder: failed to read chunk ${ci}, skipping`, err);
			}
		}

		// Rebuild entries Map and hashIndex from the combined LRU array.
		// Array order = LRU recency (oldest first, newest last).
		let loadedCount = 0;
		for (const entry of manifest.lruEntries) {
			const vec = entriesByHash.get(entry.hash);
			if (vec) {
				this.entries.set(entry.hash, vec);
				this.hashIndex.set(entry.hash, { chunk: entry.chunk, offset: entry.offset });
				loadedCount++;
			}
		}

		// If some entries from the manifest couldn't be found in any chunk
		// (e.g. chunk file was deleted or corrupted), warn and mark dirty so
		// the manifest is repaired on the next flush.
		if (loadedCount < manifest.lruEntries.length) {
			const dropped = manifest.lruEntries.length - loadedCount;
			console.warn(
				`Embedder: ${dropped} cache entr${dropped === 1 ? 'y' : 'ies'} referenced in manifest ` +
				`but missing from chunk files. Manifest will be repaired on next flush.`,
			);
			this.manifestDirty = true;
			this.markDirty();
		}

		// Track the latest chunk's on-disk total for findTargetChunk.
		if (manifest.chunks.length > 0) {
			const lastMeta = manifest.chunks[manifest.chunks.length - 1]!;
			this.latestChunkTotalOnDisk = lastMeta.total;
		}

		this.evictIfNeeded();
	}

	/** Load from legacy v1 JSON format. Marks dirty so the next flush migrates. */
	private async loadFromV1(): Promise<void> {
		if (!(await this.adapter.exists(this.cacheFilePath))) {
			return;
		}

		const content = await this.adapter.read(this.cacheFilePath);
		const parsed = JSON.parse(content) as Partial<EmbedderCacheFileV1>;
		if (!parsed || parsed.version !== 1 || typeof parsed.signature !== 'string' || !parsed.entries) {
			return;
		}

		const currentSig = await this.getSignature();
		if (parsed.signature !== currentSig) {
			return;
		}

		// Populate entries Map from v1 data (preserving JSON key order = LRU order).
		for (const [key, vec] of Object.entries(parsed.entries)) {
			if (Array.isArray(vec)) {
				this.entries.set(key, vec);
			}
		}

		// Initialize chunking in-memory state from the loaded entries.
		this.initChunkingFromEntries();
		this.evictIfNeeded();
	}

	/**
	 * Build hashIndex, chunkFiles, and per-chunk counters from the current
	 * entries Map. Called once after loading from v1 format.
	 */
	private initChunkingFromEntries(): void {
		this.hashIndex.clear();
		this.chunkFiles = [];
		this.pendingAdditions = [];
		this.latestChunkTotalOnDisk = 0;
		this.latestChunkPendingAdds = 0;
		this.dirtyChunks.clear();

		if (this.entries.size === 0) return;

		// get the first embedding vector to determine dimension
		let dim = 0;
		for (const vec of this.entries.values()) {
			dim = vec.length;
			break;
		}
		if (dim === 0) return;
		const entrySize = getEntryByteSize(dim);
		let chunkIdx = 0;
		let slotInChunk = 0;
		let file: string | undefined;

		for (const [hash, vec] of this.entries) {
			if (slotInChunk >= this.chunkCapacity) {
				chunkIdx++;
				slotInChunk = 0;
				file = undefined;
			}

			if (!file) {
				file = `embedding-chunk-${String(chunkIdx).padStart(3, '0')}.bin`;
				this.chunkFiles.push(file);
			}

			this.hashIndex.set(hash, { chunk: chunkIdx, offset: slotInChunk * entrySize });
			this.pendingAdditions.push({ hashHex: hash, vector: vec, chunkIndex: chunkIdx });
			this.dirtyChunks.add(chunkIdx);
			slotInChunk++;
		}

		this.latestChunkTotalOnDisk = 0; // All chunks are pending initial write.
		this.latestChunkPendingAdds = slotInChunk;
		this.manifestDirty = true;
		this.dirty = true; // Ensure flush happens to migrate.
	}

	// ── Eviction ────────────────────────────────────────────────────────

	private evictIfNeeded(): void {
		if (this.maxEntries <= 0) return;
		while (this.entries.size > this.maxEntries) {
			const next = this.entries.keys().next();
			if (next.done) break;
			const hash = next.value;
			this.entries.delete(hash);

			// If this entry was just added (not yet flushed), remove it from
			// pending additions so we don't write it to disk only to tombstone it.
			const addIdx = this.pendingAdditions.findIndex(a => a.hashHex === hash);
			if (addIdx >= 0) {
				this.pendingAdditions.splice(addIdx, 1);
				this.latestChunkPendingAdds = Math.max(0, this.latestChunkPendingAdds - 1);
			}

			const idx = this.hashIndex.get(hash);
			if (idx) {
				this.pendingTombstones.set(hash, { chunk: idx.chunk, offset: idx.offset });
				this.hashIndex.delete(hash);
				this.dirtyChunks.add(idx.chunk);
			}

			this.manifestDirty = true;
		}
	}

	// ── Chunk management ────────────────────────────────────────────────

	/**
	 * Find or create a chunk for new entries.
	 * Always targets the latest chunk; creates a new one if it's at capacity.
	 */
	private findTargetChunk(): number {
		const total = this.latestChunkTotalOnDisk + this.latestChunkPendingAdds;
		if (this.chunkFiles.length === 0 || total >= this.chunkCapacity) {
			// Create a new chunk.
			const idx = this.chunkFiles.length;
			const file = `embedding-chunk-${String(idx).padStart(3, '0')}.bin`;
			this.chunkFiles.push(file);
			this.latestChunkTotalOnDisk = 0;
			this.latestChunkPendingAdds = 0;
			this.dirtyChunks.add(idx);
			return idx;
		}
		return this.chunkFiles.length - 1;
	}

	// ── Flush / persistence ─────────────────────────────────────────────

	private markDirty(): void {
		this.dirty = true;
		if (this.flushDebounceMs <= 0) return;
		if (this.flushTimer) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.doFlush();
		}, this.flushDebounceMs);
	}

	private async doFlush(): Promise<void> {
		if (this.flushPromise) {
			await this.flushPromise;
		}
		if (!this.manifestDirty && this.dirtyChunks.size === 0) return;
		this.flushPromise = this.writeCacheFile().finally(() => {
			this.flushPromise = null;
		});
		return this.flushPromise;
	}

	private async writeCacheFile(): Promise<void> {
		// Snapshot the set of chunks to write BEFORE clearing dirty flags.
		// Must be declared outside try so the catch block can re-mark them.
		let dirtySet = new Set<number>();
		try {
			if (!this.config) return;

			const signature = await this.getSignature();

			// Build the manifest from current in-memory state.
			const manifest = this.buildManifest(signature);

			// Clear dirty flags right before writes so concurrent mutations
			// during serialization are captured for the next flush cycle.
			this.manifestDirty = false;
			dirtySet = new Set(this.dirtyChunks);
			this.dirtyChunks.clear();
			this.dirty = false;

			// Write manifest first (small, fast).
			await writeManifest(this.adapter, this.manifestPath, manifest);

			// Process each dirty chunk: apply tombstones, append additions, compact if needed.
			const updatedLatestTotal = await this.processDirtyChunks(dirtySet);

			if (updatedLatestTotal !== null) {
				this.latestChunkTotalOnDisk = updatedLatestTotal;
				this.latestChunkPendingAdds = 0;
			}

			// Clear pending buffers.
			this.pendingTombstones.clear();
			this.pendingAdditions = [];

			// Remove any chunk files for chunks no longer referenced.
			await this.cleanupOrphanChunks(manifest);

			// Delete legacy v1 JSON if it still exists.
			if (await this.adapter.exists(this.cacheFilePath)) {
				try {
					await this.adapter.remove(this.cacheFilePath);
				} catch {
					// Best-effort; stale file is harmless.
				}
			}
		} catch (err) {
			// Writing failed; re-mark everything for retry.
			this.manifestDirty = true;
			this.dirty = true;
			for (const ci of dirtySet) {
				this.dirtyChunks.add(ci);
			}
			console.error("Embedder: failed to write cache files", err);
		}
	}

	/**
	 * Process all dirty chunks: read, apply tombstones, append additions,
	 * compact if threshold exceeded, write back.
	 *
	 * @returns The new `total` value for the latest chunk after writing,
	 * or `null` if the latest chunk was not among the dirty set.
	 */
	private async processDirtyChunks(dirtySet: Set<number>): Promise<number | null> {
		const latestIdx = this.chunkFiles.length - 1;
		let latestTotal: number | null = null;

		// Pre-compute the set of evicted hashes so we can skip add-then-evict entries.
		const evictedHashes = new Set(this.pendingTombstones.keys());

		for (const chunkIdx of dirtySet) {
			const filePath = this.chunkFilePath(chunkIdx);

			// 1. Read existing chunk (if any).
			let entries: ChunkEntry[] = [];
			let dim = 0;
			const exists = await this.adapter.exists(filePath);
			if (exists) {
				try {
					const buf = await this.adapter.readBinary(filePath);
					const result = deserializeChunk(buf);
					entries = result.entries;
					if (entries.length > 0) {
						dim = entries[0]!.vector.length;
					}
				} catch (err) {
					console.warn(`Embedder: failed to read chunk ${chunkIdx}, treating as empty`, err);
				}
			}

			// 2. Collect pending tombstones and additions for this chunk.
			const chunkTombstones: number[] = [];
			for (const [, info] of this.pendingTombstones) {
				if (info.chunk === chunkIdx) {
					chunkTombstones.push(info.offset);
				}
			}

			const chunkAdditions = this.pendingAdditions.filter(
				a => a.chunkIndex === chunkIdx && !evictedHashes.has(a.hashHex),
			);

			// Determine dim from additions if chunk was empty.
			if (dim === 0 && chunkAdditions.length > 0) {
				dim = chunkAdditions[0]!.vector.length;
			}

			if (dim === 0) {
				// Empty chunk with no additions — nothing to write.
				// If this is the latest chunk, reset its tracking.
				if (chunkIdx === latestIdx) {
					latestTotal = 0;
				}
				continue;
			}

			const entrySize = getEntryByteSize(dim);

			// 3. Apply tombstones in-place.
			for (const off of chunkTombstones) {
				const entryIdx = Math.floor(off / entrySize);
				if (entryIdx >= 0 && entryIdx < entries.length) {
					entries[entryIdx]!.flags = FLAG_TOMBSTONE;
				}
			}

			// 4. Append additions.
			for (const add of chunkAdditions) {
				entries.push({
					hashHex: add.hashHex,
					vector: add.vector,
					flags: FLAG_ACTIVE,
				});
			}

			// 5. Determine if compaction is needed.
			const activeCount = entries.filter(e => e.flags === FLAG_ACTIVE).length;
			const totalSlots = entries.length;
			const needsCompact =
				totalSlots > 0 && activeCount > 0 && (activeCount / totalSlots) < 0.7;

			if (needsCompact) {
				// Compact: remove tombstones, rewrite sequentially.
				const compacted = entries.filter(e => e.flags === FLAG_ACTIVE);

				// Update hashIndex offsets for all surviving entries in this chunk.
				for (let i = 0; i < compacted.length; i++) {
					const entry = compacted[i]!;
					const existing = this.hashIndex.get(entry.hashHex);
					if (existing && existing.chunk === chunkIdx) {
						existing.offset = i * entrySize;
					}
				}

				const buf = serializeChunk(compacted);
				await this.adapter.writeBinary(filePath, buf);

				if (chunkIdx === latestIdx) {
					latestTotal = compacted.length;
				}
			} else {
				const buf = serializeChunk(entries);
				await this.adapter.writeBinary(filePath, buf);

				if (chunkIdx === latestIdx) {
					latestTotal = totalSlots;
				}
			}
		}

		return latestTotal;
	}

	/** Build the manifest from the current in-memory state. */
	private buildManifest(signature: string): EmbedderManifest {
		// Build combined LRU array from Map iteration order (oldest first).
		// Each entry pairs the hash with its chunk+offset so the manifest is
		// self-contained — no separate hash index needed on disk.
		const lruEntries: { hash: string; chunk: number; offset: number }[] = [];
		for (const hash of this.entries.keys()) {
			const idx = this.hashIndex.get(hash);
			if (idx) {
				lruEntries.push({ hash, chunk: idx.chunk, offset: idx.offset });
			}
		}

		// Build chunk metadata from current state.
		const chunkMetaList: ChunkMeta[] = this.chunkFiles.map((file, ci) => {
			// Count active entries in this chunk from hashIndex.
			let active = 0;
			let total = 0;
			for (const [, idx] of this.hashIndex) {
				if (idx.chunk === ci) {
					active++;
				}
			}
			// Estimate total: on-disk total (for non-latest) or
			// on-disk + pending (for latest).
			if (ci === this.chunkFiles.length - 1) {
				total = this.latestChunkTotalOnDisk + this.latestChunkPendingAdds;
			} else {
				total = active; // conservative: assume no tombstones for non-latest
			}
			return { file, active, total };
		});

		return {
			version: 2,
			signature,
			chunkCapacity: this.chunkCapacity,
			lruEntries,
			chunks: chunkMetaList,
		};
	}

	/**
	 * Remove chunk files that are no longer referenced by the manifest.
	 * This handles the case where all entries in a chunk were evicted and
	 * the chunk was compacted to zero entries, or when the entire cache is
	 * cleared.
	 */
	private async cleanupOrphanChunks(manifest: EmbedderManifest): Promise<void> {
		const referencedFiles = new Set(manifest.chunks.map(c => c.file));

		// Remove chunk files within the known range that are no longer referenced.
		for (let ci = 0; ci < this.chunkFiles.length; ci++) {
			const file = this.chunkFiles[ci];
			if (file && !referencedFiles.has(file)) {
				await this.removeChunkFile(ci);
			}
		}

		// Also scan beyond chunkFiles.length for leftover files from a
		// previous clear() that reset the in-memory list but left old
		// chunk files on disk.
		let ci = this.chunkFiles.length;
		while (await this.adapter.exists(this.chunkFilePath(ci))) {
			await this.removeChunkFile(ci);
			ci++;
		}
	}

	/** Best-effort removal of a single chunk file. */
	private async removeChunkFile(ci: number): Promise<void> {
		try {
			await this.adapter.remove(this.chunkFilePath(ci));
		} catch {
			// Best-effort cleanup.
		}
	}
}

// ─────────────────────────────────────────────
// Global singleton
// ─────────────────────────────────────────────

/**
 * Process-wide shared {@link Embedder} instance.
 *
 * Rationale: embedding cache has value only when re-used across all ChatStream
 * instances (main agent, sub-agents, etc.). Keeping a single instance also
 * avoids concurrent writers racing on the same cache file.
 */
let globalEmbedder: Embedder | null = null;

/**
 * Initialize the global {@link Embedder} singleton. Should be called once
 * during plugin `onload`. Calling it again will replace the previous instance
 * (after flushing it) — useful for hot-reload scenarios.
 */
export async function initGlobalEmbedder(opts: EmbedderOptions): Promise<Embedder> {
	if (globalEmbedder) {
		try {
			await globalEmbedder.flush();
		} catch (err) {
			console.warn("Embedder: flush during re-init failed", err);
		}
	}
	globalEmbedder = new Embedder(opts);
	return globalEmbedder;
}

/**
 * Returns the global {@link Embedder} singleton, or `null` if
 * {@link initGlobalEmbedder} has not been called yet.
 */
export function getGlobalEmbedder(): Embedder | null {
	return globalEmbedder;
}

/**
 * Flush and dispose the global embedder. Intended for plugin `onunload`.
 */
export async function disposeGlobalEmbedder(): Promise<void> {
	if (!globalEmbedder) return;
	try {
		await globalEmbedder.flush();
	} catch (err) {
		console.warn("Embedder: flush during dispose failed", err);
	}
	globalEmbedder = null;
}
