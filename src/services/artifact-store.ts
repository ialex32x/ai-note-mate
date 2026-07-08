// ─────────────────────────────────────────────
// Artifact store (per-session, in-memory + optional disk persistence)
// ─────────────────────────────────────────────
//
// Pure data structure backing the delegate-envelope artifact mechanism
// described in `docs/delegate-envelope-artifact-plan.md` (§1.3, §1.4, §1.6)
// and the persistence extension in `docs/artifact-cache-persistence-plan.md`.
//
// Responsibilities:
//   - Hold sub-agent return values that are too large to inline in the
//     `delegate_task` envelope but small enough to be worth keeping
//     recoverable via `recall_artifact`.
//   - Enforce a total-byte cap with LRU-by-last-access eviction.
//   - Enforce an optional per-entry size cap (caller is expected to also
//     gate on this before calling `put` — two layers of defence,
//     intentionally redundant; see plan §1.3 vs §1.6).
//   - Enforce a TTL since last access.
//   - Leave a *tombstone* for every entry that leaves the live set, so
//     `recall_artifact` can answer "this existed but is gone, here's why"
//     instead of an indistinguishable false-negative.
//   - (Optional) Persist entries to disk via Obsidian's DataAdapter so
//     artifacts survive plugin reload / Obsidian restart.
//
// Non-responsibilities (deliberately):
//   - No DOM. No `setInterval`. No `register*` hooks.
//     Eviction runs lazily on `put` / `get` / `liveKeys`. Justification:
//     setInterval-driven timers behave poorly on mobile under sleep/wake
//     (plan §6); a lazy sweep gives identical observable behaviour because
//     callers can only observe state through these same accessors.
//   - No knowledge of `JSON.stringify` or the envelope shape. The caller
//     measures the serialized byte size and passes it in. This keeps the
//     store reusable and avoids double-encoding on the hot path
//     (`buildDelegatePayload` already serializes once).
//   - No async surface on the public contract. The contract is sync.
//     File I/O is fire-and-forget; callers never await it.
//     Concurrent calls are not a concern because all reachable call
//     sites run on the JS main thread.
//
// Lifecycle ownership is `SessionRuntime`'s (plan §1.3 "Mounting") — not
// the plugin's, not `AgentOrchestrator`'s. Background sessions get their
// own instance. `clear()` is called at session end and converts every
// live entry into a `session_end` tombstone before dropping the map.

import type { DataAdapter } from "obsidian";
import { generateId } from "../utils/id-utils";

/** Reason an entry is no longer recoverable. */
export type EvictionReason = "lru" | "ttl" | "session_end" | "too_large_for_store";

/** Default knobs. Settings-tunable values are passed via constructor. */
export const ARTIFACT_STORE_DEFAULTS = {
    /** 1 MB total cap across all live entries. */
    totalBytesCap: 1024 * 1024,
    /** 128 KB per-entry cap. Caller is expected to gate on this too. */
    singleArtifactCap: 128 * 1024,
    /** 30 minutes since last access. `0` disables TTL. */
    ttlMs: 30 * 60 * 1000,
} as const;

/** Options accepted by {@link ArtifactStore}. All optional. */
export interface ArtifactStoreOptions {
    /** Total byte budget for live entries. Default {@link ARTIFACT_STORE_DEFAULTS.totalBytesCap}. */
    totalBytesCap?: number;
    /** Reject any single `put` whose declared size exceeds this. Default {@link ARTIFACT_STORE_DEFAULTS.singleArtifactCap}. */
    singleArtifactCap?: number;
    /** Time-to-live since last access, in ms. `0` disables. Default {@link ARTIFACT_STORE_DEFAULTS.ttlMs}. */
    ttlMs?: number;
    /** Time source. Defaults to `Date.now`. Tests inject a mock clock. */
    now?: () => number;
    /**
     * Obsidian DataAdapter for file I/O. When provided together with
     * `artifactsDir`, entries are persisted to disk so they survive
     * plugin reload and Obsidian restart. Omit for in-memory-only mode
     * (tests, legacy sessions).
     */
    adapter?: DataAdapter;
    /**
     * Vault-relative directory for artifact files. Required when
     * `adapter` is provided. Format: `sessions/<sessionId>/artifacts/`.
     */
    artifactsDir?: string;
}

/** Result of {@link ArtifactStore.put}. */
export type PutResult =
    | { stored: true; key: string; evicted: ReadonlyArray<EvictionRecord> }
    | { stored: false; reason: "too_large_for_store"; size: number };

/** Result of {@link ArtifactStore.get}. Mirrors the `recall_artifact` tool's response shape (plan §1.4). */
export type GetResult =
    | { found: true; value: unknown; size: number }
    | { found: false; evicted: true; reason: EvictionReason; size: number }
    | { found: false; evicted: false };

/** What was kicked out by a single mutation. Returned to the caller so eviction can be logged / surfaced. */
export interface EvictionRecord {
    key: string;
    reason: EvictionReason;
    size: number;
}

/** Snapshot for tests and future debug UI. Not part of the recall contract. */
export interface ArtifactStoreStats {
    liveCount: number;
    liveBytes: number;
    /** Number of entries tracked in the disk index (evicted entries with disk files, or tombstone entries in memory-only mode). */
    diskIndexCount: number;
}

/** Internal: a live entry. */
interface LiveEntry {
    value: unknown;
    size: number;
    /** Wall-clock timestamp from injected `now()` at the last put/get. */
    lastAccess: number;
}

/**
 * Internal: a disk-index entry marking a key whose value is either on
 * disk (persistence mode) or has been evicted with a known reason
 * (memory-only mode). The `reason` field is present for LRU/TTL evictions
 * and `session_end` tombstones; absent for pure disk-index entries
 * created during startup recovery.
 */
interface DiskIndexEntry {
    size: number;
    reason?: EvictionReason;
}

export class ArtifactStore {
    private readonly totalBytesCap: number;
    private readonly singleArtifactCap: number;
    private readonly ttlMs: number;
    private readonly now: () => number;

    /** Optional: Obsidian DataAdapter for disk persistence. */
    private readonly adapter?: DataAdapter;
    /** Optional: vault-relative directory for artifact files. */
    private readonly artifactsDir?: string;

    /**
     * Live entries. Iteration order is insertion order (the JS `Map`
     * guarantee). We re-insert on access to keep LRU order trivially:
     * eldest = first key in iteration. See {@link touch}.
     */
    private readonly live = new Map<string, LiveEntry>();

    /**
     * Disk index: tracks keys whose values exist on disk (persistence
     * mode) or have been evicted with a known reason (memory-only mode).
     * Same key space as `live` — a key cannot be both live and in the
     * disk index. Unbounded (no FIFO cap) because the number of entries
     * is naturally limited by sub-agent call count (persistence-plan §2.3).
     */
    private readonly diskIndex = new Map<string, DiskIndexEntry>();

    /** Running sum of `live[k].size` for O(1) cap checks. */
    private liveBytes = 0;

    constructor(opts: ArtifactStoreOptions = {}) {
        this.totalBytesCap = opts.totalBytesCap ?? ARTIFACT_STORE_DEFAULTS.totalBytesCap;
        this.singleArtifactCap = opts.singleArtifactCap ?? ARTIFACT_STORE_DEFAULTS.singleArtifactCap;
        this.ttlMs = opts.ttlMs ?? ARTIFACT_STORE_DEFAULTS.ttlMs;
        this.now = opts.now ?? Date.now;
        this.adapter = opts.adapter;
        this.artifactsDir = opts.artifactsDir;

        // Fire-and-forget: recover any previously persisted artifact
        // files during construction. get() won't be called until the
        // first chat turn runs, so async recovery is safe.
        if (this.adapter && this.artifactsDir) {
            void this.recoverFromDisk();
        }
    }

    /**
     * Insert a value into the store. A unique key is generated
     * internally via {@link generateId} so callers never need to
     * manage or namespace keys.
     *
     * `size` is the caller-measured serialized byte size — we do not
     * measure ourselves because the orchestrator has already
     * serialized once to decide which branch to take (plan §1.6).
     *
     * Returns `{ stored: false }` if the value alone exceeds the
     * per-entry cap; nothing is mutated in that case (no tombstone
     * either — the caller writes a `too_large_for_store` marker on
     * the envelope, not in the store; plan §1.6 last bullet).
     *
     * If accepted, may LRU-evict zero or more existing entries to
     * make room under {@link totalBytesCap}; each such eviction is
     * recorded as a tombstone and returned in the result for caller
     * logging.
     *
     * On success the return value includes the auto-generated `key`
     * that callers should use to construct artifact references and
     * to pass to `recall_artifact`.
     */
    put(value: unknown, size: number): PutResult {
        // Bookkeeping is lazy: TTL-sweep before deciding whether the
        // new entry fits, so an old expired entry can release room
        // even if its TTL hasn't been "noticed" yet.
        this.sweepExpired();

        if (size > this.singleArtifactCap) {
            return { stored: false, reason: "too_large_for_store", size };
        }

        // Also reject if the value can't possibly fit even in an empty
        // store. This is only reachable when the caller misconfigures
        // singleArtifactCap > totalBytesCap; in the normal config
        // (128KB ≤ 1MB) the singleArtifactCap check above catches it
        // first. Doing this *before* any eviction guarantees the
        // public contract "a too_large_for_store rejection mutates
        // nothing" — including not destroying existing entries via
        // a futile LRU sweep.
        if (size > this.totalBytesCap) {
            return { stored: false, reason: "too_large_for_store", size };
        }

        // Generate a unique key using the same ID scheme as profiles.
        // The format (`<timestamp>-<random>`) is collision-safe and
        // filesystem-safe — no special characters, no encoding needed.
        const key = generateId();

        const evicted: EvictionRecord[] = [];

        // Evict LRU until the new entry fits. Order of iteration of
        // `live` is insertion order; we re-insert on touch (see `get`),
        // so the first key is the least-recently-accessed.
        //
        // Termination: size ≤ totalBytesCap was checked above, so once
        // `live` is empty we have `liveBytes=0` and `0+size ≤ cap`. The
        // loop cannot exit with the cap still exceeded.
        while (this.liveBytes + size > this.totalBytesCap && this.live.size > 0) {
            const oldestKey: string | undefined = this.live.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            const oldest = this.live.get(oldestKey)!;
            this.live.delete(oldestKey);
            this.liveBytes -= oldest.size;
            // LRU eviction: the entry's value is (or will be) on disk;
            // mark it in the diskIndex so get() can recover it later.
            this.writeDiskIndex(oldestKey, "lru", oldest.size);
            evicted.push({ key: oldestKey, reason: "lru", size: oldest.size });
        }

        this.live.set(key, { value, size, lastAccess: this.now() });
        this.liveBytes += size;

        // Fire-and-forget: persist to disk if adapter is available.
        // The caller (context-compression) stays sync; write failures are
        // logged but do not block prompt assembly.
        if (this.adapter && this.artifactsDir) {
            void this.persistToFile(key, value, size);
        }

        return { stored: true, key, evicted };
    }

    /**
     * Replace the value of an existing live entry in-place.
     *
     * Unlike {@link put}, this does NOT generate a new key — it
     * overwrites the value at `key`, preserving the same artifact
     * identity. This allows a two-phase write pattern:
     *   1. `put({ status: "RUNNING" })`  → key: "abc"
     *   2. `replace("abc", { status: "SUCCEEDED", text: "..." })`
     * where callers observing "abc" after step 2 see the final result.
     *
     * Semantics:
     *  - The entry MUST already exist in `live`. If it doesn't, this
     *    is a no-op (returns `false`) — the caller should have called
     *    {@link put} first.
     *  - `liveBytes` is adjusted: `old.size` is subtracted, `size` is
     *    added. NO per-entry or total-byte cap check is performed
     *    because the entry already had a slot. If the replacement is
     *    dramatically larger it may push `liveBytes` over the cap, but
     *    the next `put` call's LRU sweep will correct this — and for
     *    the intended use case (RUNNING → SUCCEEDED with similar-sized
     *    payloads) this is a non-issue.
     *  - `lastAccess` is refreshed so the updated entry moves to the
     *    LRU tail.
     *  - In persistence mode the on-disk file is overwritten
     *    fire-and-forget.
     *
     * @returns `true` if the entry was found and replaced, `false` if
     *   `key` is not currently live.
     */
    replace(key: string, value: unknown, size: number): boolean {
        const existing = this.live.get(key);
        if (existing === undefined) return false;

        this.liveBytes = this.liveBytes - existing.size + size;

        // Re-insert to move to LRU tail (same pattern as get()'s touch).
        this.live.delete(key);
        this.live.set(key, { value, size, lastAccess: this.now() });

        // Fire-and-forget: overwrite the on-disk file if persisted.
        if (this.adapter && this.artifactsDir) {
            void this.persistToFile(key, value, size);
        }

        return true;
    }

    /**
     * Look up `key`. Three outcomes:
     *   - Live hit: returns `{ found: true, value, size }`. Refreshes
     *     `lastAccess` (this is how LRU stays accurate).
     *   - DiskIndex hit: attempts to read the value from disk.
     *     On success, restores to live and returns found.
     *     On failure (file missing / corrupt), returns evicted.
     *   - Pure miss: returns `{ found: false, evicted: false }`.
     *
     * Lazy TTL: a live entry whose `lastAccess + ttlMs <= now` is
     * tombstoned on this very call before being returned as evicted.
     */
    get(key: string): GetResult {
        this.sweepExpiredFor(key);

        const live = this.live.get(key);
        if (live !== undefined) {
            // Touch: re-insert to move to LRU tail, then update access ts.
            this.live.delete(key);
            live.lastAccess = this.now();
            this.live.set(key, live);
            return { found: true, value: live.value, size: live.size };
        }

        // Live miss — check diskIndex for a disk-resident / evicted entry.
        const idx = this.diskIndex.get(key);
        if (idx !== undefined) {
            // Attempt disk recovery if we have an adapter.
            if (this.adapter && this.artifactsDir) {
                const restored = this.tryRestoreFromDisk(key);
                if (restored !== null) {
                    return restored;
                }
                // tryRestoreFromDisk cannot perform async I/O in the sync
                // get() contract. Keep the diskIndex entry intact so the
                // tombstone remains discoverable on subsequent lookups.
                // (If the on-disk file is actually gone, the stale index
                // entry is harmless — it's bounded by sub-agent call count.)
            }
            // Either no adapter (memory-only mode) or sync recovery not
            // possible (persistence mode). Return the evicted tombstone.
            return {
                found: false,
                evicted: true,
                reason: idx.reason ?? "lru",
                size: idx.size,
            };
        }

        return { found: false, evicted: false };
    }

    /**
     * The set of currently-live keys, used by the prompt assembler to
     * inject an "available artifacts" index into the main-agent system
     * prompt (plan §1.4 last paragraph). Order is insertion / LRU
     * order; callers must not depend on it being sorted.
     *
     * Sweeps expired entries first so the index never advertises a
     * key that recall would then 404 on.
     */
    liveKeys(): string[] {
        this.sweepExpired();
        return Array.from(this.live.keys());
    }

    /**
     * End-of-session cleanup. Every currently-live entry becomes a
     * `session_end` tombstone, then both maps are emptied. The
     * tombstones are kept so any in-flight `recall_artifact` on a
     * session that has just been torn down gets a meaningful reason
     * rather than a bare miss.
     *
     * In persistence mode, also deletes the on-disk artifact files.
     *
     * The plan (§1.3 "Session end: drop the entire store") allows
     * just dropping everything; the `session_end` tombstones are an
     * additive improvement for observability and cost nothing — a
     * `SessionRuntime` that doesn't outlive its caller's reference
     * to the store will let the whole instance be GC'd anyway.
     */
    clear(): void {
        for (const [k, entry] of this.live) {
            this.writeDiskIndex(k, "session_end", entry.size);
        }
        this.live.clear();
        this.liveBytes = 0;

        // In persistence mode, delete the on-disk artifacts directory.
        // Fire-and-forget — the runtime is being torn down.
        if (this.adapter && this.artifactsDir) {
            void this.deleteArtifactsDir();
        }
    }

    /** Snapshot for tests / debug UI. Not part of the public recall contract. */
    stats(): ArtifactStoreStats {
        return {
            liveCount: this.live.size,
            liveBytes: this.liveBytes,
            diskIndexCount: this.diskIndex.size,
        };
    }

    // ─────────── internals ───────────

    /**
     * Move an entry to LRU tail without changing its access time.
     * Currently unused (we re-insert inline in {@link get}) but kept
     * private for future internal needs.
     */
    private touch(key: string): void {
        const e = this.live.get(key);
        if (e === undefined) return;
        this.live.delete(key);
        this.live.set(key, e);
    }

    /**
     * Sweep every live entry for TTL expiry. Cheap-ish but O(n);
     * called only on the explicit-scan paths (`put`, `liveKeys`).
     * `get(key)` uses {@link sweepExpiredFor} so a hot lookup costs
     * O(1).
     */
    private sweepExpired(): void {
        if (this.ttlMs <= 0) return;
        const cutoff = this.now() - this.ttlMs;
        // Snapshot keys first — we mutate during iteration.
        const expired: Array<[string, LiveEntry]> = [];
        for (const [k, e] of this.live) {
            if (e.lastAccess <= cutoff) expired.push([k, e]);
        }
        for (const [k, e] of expired) {
            this.live.delete(k);
            this.liveBytes -= e.size;
            this.writeDiskIndex(k, "ttl", e.size);
        }
    }

    /**
     * Cheap path used by {@link get}: only sweep the single key being
     * looked up. Keeps a hot recall O(1) without leaving stale entries
     * visible to that particular call.
     */
    private sweepExpiredFor(key: string): void {
        if (this.ttlMs <= 0) return;
        const e = this.live.get(key);
        if (e === undefined) return;
        if (e.lastAccess <= this.now() - this.ttlMs) {
            this.live.delete(key);
            this.liveBytes -= e.size;
            this.writeDiskIndex(key, "ttl", e.size);
        }
    }

    /**
     * Write (or overwrite) a diskIndex entry. No FIFO cap — the number
     * of diskIndex entries is naturally bounded by sub-agent call count
     * (persistence-plan §2.3). A re-insert for an existing key replaces
     * the reason (e.g. ttl → session_end on a stale entry that gets
     * picked up by clear()).
     */
    private writeDiskIndex(
        key: string,
        reason: EvictionReason,
        size: number,
    ): void {
        this.diskIndex.set(key, { size, reason });
    }

    // ─────────── file I/O (persistence mode) ───────────

    /**
     * Derive the vault-relative file path for a given artifact key.
     * Keys may contain characters that are invalid in filenames
     * (e.g. `:`), so we encode them.
     */
    private filePathForKey(key: string): string {
        // Encode the key for safe use as a filename component.
        // `:` → `_` is the main concern; other special chars are rare.
        const safeKey = key.replace(/[:/\\?%*|"<>]/g, '_');
        return `${this.artifactsDir}/${safeKey}.json`;
    }

    /**
     * Ensure the artifacts directory exists. Called before each file
     * write; `adapter.mkdir` is a no-op if the directory already
     * exists on most platforms.
     */
    private async ensureArtifactsDir(): Promise<void> {
        if (!this.adapter || !this.artifactsDir) return;
        try {
            if (!await this.adapter.exists(this.artifactsDir)) {
                await this.adapter.mkdir(this.artifactsDir);
            }
        } catch (err) {
            console.warn('[ArtifactStore] failed to ensure artifacts dir:', err);
        }
    }

    /**
     * Persist a single entry to disk. Fire-and-forget — callers do not
     * await. Write failures are logged but never block prompt assembly.
     */
    private async persistToFile(
        key: string,
        value: unknown,
        size: number,
    ): Promise<void> {
        if (!this.adapter || !this.artifactsDir) return;
        try {
            await this.ensureArtifactsDir();
            const filePath = this.filePathForKey(key);
            const payload = {
                v: 1,
                key,
                size,
                value,
            };
            const json = JSON.stringify(payload);
            await this.adapter.write(filePath, json);
        } catch (err) {
            console.warn('[ArtifactStore] failed to persist artifact to disk:', key, err);
        }
    }

    /**
     * Attempt to restore a single entry from its disk file. Returns
     * the GetResult on success, or null if the entry cannot be
     * synchronously recovered.
     *
     * Note: with the sync `get()` contract and async DataAdapter,
     * synchronous disk reads are not possible. Entries recovered during
     * construction (via {@link recoverFromDisk}) are already in
     * `live`; entries that have been LRU-evicted from live but still
     * have a disk file fall through to the diskIndex tombstone path
     * so the caller gets `{ found: false, evicted: true }`.
     */
    private tryRestoreFromDisk(_key: string): GetResult | null {
        // Async read not available in the sync get() contract.
        // Entries recovered during construction are in `live`.
        return null;
    }

    /**
     * Scan the artifacts directory and restore all valid `.json` files
     * into the `live` Map. Fire-and-forget — called from the constructor.
     * Entries that exceed the total byte cap are LRU-evicted as usual.
     */
    private async recoverFromDisk(): Promise<void> {
        if (!this.adapter || !this.artifactsDir) return;
        try {
            if (!await this.adapter.exists(this.artifactsDir)) return;

            const files = await this.adapter.list(this.artifactsDir);
            for (const file of files.files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const filePath = `${this.artifactsDir}/${file}`;
                    const raw = await this.adapter.read(filePath);
                    const data = JSON.parse(raw) as {
                        v?: number;
                        key?: string;
                        size?: number;
                        value?: unknown;
                    };
                    // Validate shape.
                    if (data?.v === 1 && typeof data.key === 'string' && data.key.length > 0
                        && data.value !== undefined && typeof data.size === 'number') {
                        // Restore into live; put() handles LRU eviction.
                        // Use a synthetic put — we bypass the
                        // per-entry / total cap checks because the
                        // file was already accepted by a previous
                        // put() call.
                        this.restoreEntry(data.key, data.value, data.size);
                    }
                } catch {
                    console.warn('[ArtifactStore] failed to recover artifact file, skipping:', file);
                    // Attempt to delete the corrupt file.
                    try {
                        await this.adapter.remove(`${this.artifactsDir}/${file}`);
                    } catch { /* best-effort */ }
                }
            }
        } catch (err) {
            console.warn('[ArtifactStore] failed to recover artifacts from disk:', err);
        }
    }

    /**
     * Restore a single entry into live during startup recovery.
     * Bypasses the single-artifact and total-byte checks because the
     * entry was already validated by the original put(). If the total
     * cap is exceeded after restore, LRU-evicts until it fits.
     */
    private restoreEntry(key: string, value: unknown, size: number): void {
        // Skip if already live (shouldn't happen but be defensive).
        if (this.live.has(key)) return;

        // Remove any stale diskIndex entry for this key.
        this.diskIndex.delete(key);

        // LRU-evict until it fits.
        while (this.liveBytes + size > this.totalBytesCap && this.live.size > 0) {
            const oldestKey: string | undefined = this.live.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            const oldest = this.live.get(oldestKey)!;
            this.live.delete(oldestKey);
            this.liveBytes -= oldest.size;
            // Evicted during recovery: mark in diskIndex so get() can
            // re-read from the (still-present) disk file.
            this.writeDiskIndex(oldestKey, "lru", oldest.size);
        }

        this.live.set(key, { value, size, lastAccess: this.now() });
        this.liveBytes += size;
    }

    /**
     * Delete the entire artifacts directory. Called from clear() during
     * session teardown. Fire-and-forget.
     */
    private async deleteArtifactsDir(): Promise<void> {
        if (!this.adapter || !this.artifactsDir) return;
        try {
            if (await this.adapter.exists(this.artifactsDir)) {
                // Delete each file individually, then try to rmdir.
                const files = await this.adapter.list(this.artifactsDir);
                for (const file of files.files) {
                    try {
                        await this.adapter.remove(`${this.artifactsDir}/${file}`);
                    } catch { /* best-effort per file */ }
                }
                try {
                    await this.adapter.rmdir(this.artifactsDir, false);
                } catch { /* directory may have subdirs or already gone */ }
            }
        } catch (err) {
            console.warn('[ArtifactStore] failed to delete artifacts dir:', err);
        }
        this.diskIndex.clear();
    }
}
