import type { DataAdapter } from "obsidian";
import type { MinimalModelConfig } from "./llm-provider";
import { createEmbeddings } from "./text-embedding";
import { sha256 } from "../utils/hash";
import { truncate } from "../utils/string-truncate";

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

/** On-disk cache file schema. */
interface EmbedderCacheFile {
    /** Schema version, bump when format changes in an incompatible way. */
    version: 1;
    /**
     * Cache fingerprint derived from (type | baseURL | model).
     * When the fingerprint of the runtime config no longer matches, the entire
     * cache is discarded on load.
     */
    signature: string;
    /** Map from sha256(text) to the embedding vector. */
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
    /** Absolute (vault-relative) path to the cache JSON file. */
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
}

// ─────────────────────────────────────────────
// Embedder
// ─────────────────────────────────────────────

/**
 * Wraps {@link createEmbeddings} with a persistent, fingerprint-scoped cache.
 *
 * - Cache key per entry: sha256(text).
 * - Cache-wide fingerprint: sha256(type | baseURL | model). When the fingerprint
 *   of the current config differs from the one stored on disk, the cache is
 *   discarded and rebuilt lazily.
 * - LRU order is tracked by re-insertion into the underlying Map; when the
 *   number of entries exceeds {@link EmbedderOptions.maxEntries}, the oldest
 *   entries are evicted.
 * - Writes are debounced to avoid serializing the whole table on every call.
 */
export class Embedder {
    private readonly adapter: DataAdapter;
    private readonly cacheFilePath: string;
    private readonly maxEntries: number;
    private readonly flushDebounceMs: number;

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
        this.config = opts.config ?? null;
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Ensure the on-disk cache has been loaded into memory. Safe to call
     * multiple times; subsequent calls are no-ops.
     *
     * If the persisted signature does not match the current config, the cache
     * is treated as empty (the stale file will be overwritten on next flush).
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
            } else {
                missIndices.push(i);
                missTexts.push(texts[i]!);
            }
        }

        const hitCount = texts.length - missTexts.length;
        console.debug(
            `Embedder: embed() received ${texts.length} text(s), cache hit=${hitCount}, miss=${missTexts.length}`,
        );

        // Count total tokens (all texts, including cache hits).
        // Sum per-text estimates in case the embeddings model charges
        // on a per-request basis with per-text minimums.
        for (const t of texts) {
            this._totalTokenCount += Embedder.estimateTokens(t);
        }

        if (missTexts.length > 0) {
            if (signal?.aborted) {
                throw new DOMException("Aborted", "AbortError");
            }
            let fresh: number[][];
            try {
                // Forward signal so the underlying provider HTTP call(s)
                // can be cancelled mid-flight, not just checked
                // before/after. Without this the (cache-miss) embedding
                // round-trip blocks the abort response by its full
                // duration even when the surrounding turn has already
                // been cancelled by the user.
                fresh = await createEmbeddings(this.config, missTexts, signal);
            } catch (err) {
                // Do not mark the service as unavailable for user-initiated aborts.
                if (!(err instanceof DOMException && err.name === 'AbortError')) {
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
            }
            this.evictIfNeeded();
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
     * the on-disk file.
     */
    async updateConfig(config: MinimalModelConfig): Promise<void> {
        const prevSig = this.config ? await this.getSignature() : null;
        this.config = config;
        this.signature = null;
        const nextSig = await this.getSignature();
        if (prevSig !== null && prevSig !== nextSig) {
            // Config genuinely changed (not the first-time assignment);
            // discard the in-memory cache so we don't keep stale vectors.
            this.entries.clear();
            this.markDirty();
        }
    }

    /** Clear the cache (in-memory and on disk on next flush). */
    clear(): void {
        if (this.entries.size === 0 && !this.dirty) return;
        this.entries.clear();
        this._apiTokenCount = 0;
        this._totalTokenCount = 0;
        this.markDirty();
    }

    /** Persist pending changes to disk immediately. No-op if not dirty. */
    async flush(): Promise<void> {
        if (this.flushTimer) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (!this.dirty) {
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

    private async doLoad(): Promise<void> {
        try {
            if (!this.config) {
                // Nothing to compare signatures against; defer loading until a
                // config is supplied (the next embed() call will re-enter).
                this.loaded = false;
                return;
            }
            if (!(await this.adapter.exists(this.cacheFilePath))) {
                return;
            }
            const content = await this.adapter.read(this.cacheFilePath);
            const parsed = JSON.parse(content) as Partial<EmbedderCacheFile>;
            if (!parsed || parsed.version !== 1 || typeof parsed.signature !== "string" || !parsed.entries) {
                return;
            }
            const currentSig = await this.getSignature();
            if (parsed.signature !== currentSig) {
                // Fingerprint mismatch: discard the whole cache.
                return;
            }
            for (const [key, vec] of Object.entries(parsed.entries)) {
                if (Array.isArray(vec)) {
                    this.entries.set(key, vec);
                }
            }
            // Respect maxEntries even on load, in case the persisted file is larger
            // than the current limit (e.g. the user lowered the cap).
            this.evictIfNeeded();
        } catch (err) {
            console.warn("Embedder: failed to load cache, starting empty", err);
            this.entries.clear();
        }
    }

    private evictIfNeeded(): void {
        if (this.maxEntries <= 0) return;
        while (this.entries.size > this.maxEntries) {
            const next = this.entries.keys().next();
            if (next.done) break;
            this.entries.delete(next.value);
        }
    }

    private markDirty(): void {
        this.dirty = true;
        if (this.flushDebounceMs <= 0) return;
        if (this.flushTimer) return;
        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            // Fire-and-forget; errors are logged inside doFlush.
            void this.doFlush();
        }, this.flushDebounceMs);
    }

    private async doFlush(): Promise<void> {
        // Serialize overlapping flushes: chain onto the in-flight one.
        if (this.flushPromise) {
            await this.flushPromise;
        }
        if (!this.dirty) return;
        this.flushPromise = this.writeCacheFile().finally(() => {
            this.flushPromise = null;
        });
        return this.flushPromise;
    }

    private async writeCacheFile(): Promise<void> {
        try {
            if (!this.config) {
                // Can't compute a signature without a config; defer.
                return;
            }
            const signature = await this.getSignature();
            const payload: EmbedderCacheFile = {
                version: 1,
                signature,
                entries: Object.fromEntries(this.entries),
            };
            // Mark clean before write so concurrent mutations during serialization
            // are not lost (they will re-set `dirty` via markDirty()).
            this.dirty = false;
            await this.adapter.write(this.cacheFilePath, JSON.stringify(payload));
        } catch (err) {
            // Writing failed; keep dirty so a later flush can retry.
            this.dirty = true;
            console.error("Embedder: failed to write cache file", err);
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
