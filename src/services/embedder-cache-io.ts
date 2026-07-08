// ─────────────────────────────────────────────
// Binary chunk I/O for embedding cache (scheme B)
// ─────────────────────────────────────────────

/** Size of chunk binary header in bytes: activeCount(u32) + totalSlots(u32) */
export const CHUNK_HEADER_BYTES = 8;

/** Per-entry fixed overhead: flags(u8) + hash(32 bytes) + dim(u32) = 37 bytes */
const ENTRY_FIXED_OVERHEAD = 1 + 32 + 4;

/** Calculate total byte size of a single entry for a given embedding dimension. */
export function getEntryByteSize(dim: number): number {
	return ENTRY_FIXED_OVERHEAD + dim * 4;
}

/** Convert a hex string (lowercase, even length) to raw bytes. */
export function hexToBytes(hex: string): Uint8Array {
	const len = hex.length / 2;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/** Convert raw bytes to a lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Flags ────────────────────────────────────────────────────────────────

export const FLAG_ACTIVE = 0x00;
export const FLAG_TOMBSTONE = 0x01;

// ── Entry types ──────────────────────────────────────────────────────────

export interface ChunkEntry {
	hashHex: string;
	vector: number[];
	flags: number; // FLAG_ACTIVE or FLAG_TOMBSTONE
}

export interface ChunkReadResult {
	entries: ChunkEntry[];
	activeCount: number;
}

// ── Manifest types ───────────────────────────────────────────────────────

export interface HashIndexEntry {
	chunk: number;
	/** Byte offset from the start of the entries section (after the 8-byte header). */
	offset: number;
}

export interface ChunkMeta {
	file: string;
	active: number;
	total: number;
}

/** A single entry in the LRU-ordered manifest array. Array index = LRU order. */
export interface LRUEntry {
	hash: string;
	chunk: number;
	offset: number;
}

export interface EmbedderManifest {
	version: 2;
	signature: string;
	chunkCapacity: number;
	/** Entries ordered by LRU recency (oldest first, newest last). */
	lruEntries: LRUEntry[];
	chunks: ChunkMeta[];
}

// ── Serialization ───────────────────────────────────────────────────────

/**
 * Serialize an ordered list of entries into a chunk binary ArrayBuffer.
 * Entries may include tombstones ({@link FLAG_TOMBSTONE}).
 * All entries must have the same embedding dimension.
 */
export function serializeChunk(entries: ChunkEntry[]): ArrayBuffer {
	if (entries.length === 0) {
		const buf = new ArrayBuffer(CHUNK_HEADER_BYTES);
		const view = new DataView(buf);
		view.setUint32(0, 0, true);
		view.setUint32(4, 0, true);
		return buf;
	}

	const dim = entries[0]!.vector.length;
	const entrySize = getEntryByteSize(dim);
	const buf = new ArrayBuffer(CHUNK_HEADER_BYTES + entries.length * entrySize);
	const view = new DataView(buf);
	const bytes = new Uint8Array(buf);

	const activeCount = entries.filter(e => e.flags === FLAG_ACTIVE).length;
	view.setUint32(0, activeCount, true);
	view.setUint32(4, entries.length, true);

	let offset = CHUNK_HEADER_BYTES;
	for (const entry of entries) {
		bytes[offset] = entry.flags; offset += 1;
		bytes.set(hexToBytes(entry.hashHex), offset); offset += 32;
		view.setUint32(offset, dim, true); offset += 4;
		for (let i = 0; i < dim; i++) {
			view.setFloat32(offset + i * 4, entry.vector[i]!, true);
		}
		offset += dim * 4;
	}

	return buf;
}

/**
 * Deserialize a chunk binary ArrayBuffer into a list of entries.
 * Entries with {@link FLAG_TOMBSTONE} are included in the list but not
 * counted in {@link ChunkReadResult.activeCount}.
 */
export function deserializeChunk(buffer: ArrayBuffer): ChunkReadResult {
	if (buffer.byteLength < CHUNK_HEADER_BYTES) {
		return { entries: [], activeCount: 0 };
	}

	const view = new DataView(buffer);
	const bytes = new Uint8Array(buffer);

	const totalSlots = view.getUint32(4, true);

	if (totalSlots === 0) {
		return { entries: [], activeCount: 0 };
	}

	// Determine entry size from the dim field of the first entry.
	const probeOffset = CHUNK_HEADER_BYTES + 1 + 32; // skip flags + hash
	if (probeOffset + 4 > buffer.byteLength) {
		return { entries: [], activeCount: 0 };
	}
	const dim = view.getUint32(probeOffset, true);
	const entrySize = getEntryByteSize(dim);

	const entries: ChunkEntry[] = [];
	let offset = CHUNK_HEADER_BYTES;
	let actualActive = 0;

	for (let i = 0; i < totalSlots; i++) {
		if (offset + entrySize > buffer.byteLength) break;

		const flags = bytes[offset]!; offset += 1;
		const hashBytes = bytes.slice(offset, offset + 32);
		const hashHex = bytesToHex(hashBytes);
		offset += 32;
		const entryDim = view.getUint32(offset, true); offset += 4;
		const vector: number[] = [];
		for (let j = 0; j < entryDim; j++) {
			vector.push(view.getFloat32(offset + j * 4, true));
		}
		offset += entryDim * 4;

		entries.push({ hashHex, vector, flags });
		if (flags === FLAG_ACTIVE) actualActive++;
	}

	// Trust our counted active over the stored header value (defensive).
	return { entries, activeCount: actualActive };
}

// ── Manifest helpers ─────────────────────────────────────────────────────

/** Minimal adapter interface needed by manifest read/write. */
export interface ManifestAdapter {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

/**
 * Read and parse the manifest JSON file.
 * Returns `null` if the file doesn't exist or is structurally invalid.
 */
export async function readManifest(
	adapter: ManifestAdapter,
	manifestPath: string,
): Promise<EmbedderManifest | null> {
	try {
		if (!(await adapter.exists(manifestPath))) return null;
		const content = await adapter.read(manifestPath);
		const raw: unknown = JSON.parse(content) as unknown;
		if (!isEmbedderManifest(raw)) return null;
		return raw;
	} catch {
		return null;
	}
}

/** Type guard for {@link EmbedderManifest}. */
function isEmbedderManifest(value: unknown): value is EmbedderManifest {
	if (typeof value !== 'object' || value === null) return false;
	const m = value as Record<string, unknown>;
	return (
		m.version === 2 &&
		typeof m.signature === 'string' &&
		typeof m.chunkCapacity === 'number' &&
		Array.isArray(m.lruEntries) &&
		Array.isArray(m.chunks)
	);
}

/**
 * Write the manifest JSON file.
 */
export async function writeManifest(
	adapter: ManifestAdapter,
	manifestPath: string,
	manifest: EmbedderManifest,
): Promise<void> {
	await adapter.write(manifestPath, JSON.stringify(manifest));
}
