// ─────────────────────────────────────────────
// Artifact store (per-session, in-memory)
// ─────────────────────────────────────────────
//
// Pure data structure backing the delegate-envelope artifact mechanism
// described in `docs/delegate-envelope-artifact-plan.md` (§1.3, §1.4, §1.6).
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
//
// Non-responsibilities (deliberately):
//   - No I/O. No DOM. No `setInterval`. No `register*` hooks.
//     Eviction runs lazily on `put` / `get` / `liveKeys`. Justification:
//     setInterval-driven timers behave poorly on mobile under sleep/wake
//     (plan §6); a lazy sweep gives identical observable behaviour because
//     callers can only observe state through these same accessors.
//   - No knowledge of `JSON.stringify` or the envelope shape. The caller
//     measures the serialized byte size and passes it in. This keeps the
//     store reusable and avoids double-encoding on the hot path
//     (`buildDelegatePayload` already serializes once).
//   - No async surface. The contract is sync. Concurrent calls are not
//     a concern because all reachable call sites run on the JS main thread.
//
// Lifecycle ownership is `SessionRuntime`'s (plan §1.3 "Mounting") — not
// the plugin's, not `AgentOrchestrator`'s. Background sessions get their
// own instance. `clear()` is called at session end and converts every
// live entry into a `session_end` tombstone before dropping the map.

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
    /** Max number of tombstones retained before FIFO drop. */
    tombstoneCap: 128,
} as const;

/** Options accepted by {@link ArtifactStore}. All optional. */
export interface ArtifactStoreOptions {
    /** Total byte budget for live entries. Default {@link ARTIFACT_STORE_DEFAULTS.totalBytesCap}. */
    totalBytesCap?: number;
    /** Reject any single `put` whose declared size exceeds this. Default {@link ARTIFACT_STORE_DEFAULTS.singleArtifactCap}. */
    singleArtifactCap?: number;
    /** Time-to-live since last access, in ms. `0` disables. Default {@link ARTIFACT_STORE_DEFAULTS.ttlMs}. */
    ttlMs?: number;
    /** Maximum number of tombstones retained. Oldest is evicted FIFO. Default {@link ARTIFACT_STORE_DEFAULTS.tombstoneCap}. */
    tombstoneCap?: number;
    /** Time source. Defaults to `Date.now`. Tests inject a mock clock. */
    now?: () => number;
}

/** Result of {@link ArtifactStore.put}. */
export type PutResult =
    | { stored: true; evicted: ReadonlyArray<EvictionRecord> }
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
    tombstoneCount: number;
}

/** Internal: a live entry. */
interface LiveEntry {
    value: unknown;
    size: number;
    /** Wall-clock timestamp from injected `now()` at the last put/get. */
    lastAccess: number;
}

/** Internal: a tombstone entry. */
interface Tombstone {
    reason: EvictionReason;
    size: number;
    /** Wall-clock timestamp at the moment the entry was tombstoned. Used only for FIFO cap. */
    createdAt: number;
}

export class ArtifactStore {
    private readonly totalBytesCap: number;
    private readonly singleArtifactCap: number;
    private readonly ttlMs: number;
    private readonly tombstoneCap: number;
    private readonly now: () => number;

    /**
     * Live entries. Iteration order is insertion order (the JS `Map`
     * guarantee). We re-insert on access to keep LRU order trivially:
     * eldest = first key in iteration. See {@link touch}.
     */
    private readonly live = new Map<string, LiveEntry>();

    /**
     * Tombstones. Same key space as `live` (plan decision #6: a key
     * cannot be both live and tombstoned). FIFO-capped.
     */
    private readonly tombstones = new Map<string, Tombstone>();

    /** Running sum of `live[k].size` for O(1) cap checks. */
    private liveBytes = 0;

    constructor(opts: ArtifactStoreOptions = {}) {
        this.totalBytesCap = opts.totalBytesCap ?? ARTIFACT_STORE_DEFAULTS.totalBytesCap;
        this.singleArtifactCap = opts.singleArtifactCap ?? ARTIFACT_STORE_DEFAULTS.singleArtifactCap;
        this.ttlMs = opts.ttlMs ?? ARTIFACT_STORE_DEFAULTS.ttlMs;
        this.tombstoneCap = opts.tombstoneCap ?? ARTIFACT_STORE_DEFAULTS.tombstoneCap;
        this.now = opts.now ?? Date.now;
    }

    /**
     * Insert (or overwrite) `key`. `size` is the caller-measured
     * serialized byte size — we do not measure ourselves because the
     * orchestrator has already serialized once to decide which branch
     * to take (plan §1.6).
     *
     * Returns `{ stored: false }` if the value alone exceeds the
     * per-entry cap; nothing is mutated in that case (no tombstone
     * either — the caller writes a `too_large_for_store` marker on the
     * envelope, not in the store; plan §1.6 last bullet).
     *
     * If accepted, may LRU-evict zero or more existing entries to make
     * room under {@link totalBytesCap}; each such eviction is recorded
     * as a tombstone and returned in the result for caller logging.
     *
     * Overwriting an existing live key replaces its value and refreshes
     * `lastAccess`; no tombstone is generated for an overwrite (the
     * caller observes the new value, so "gone" would be a lie). Any
     * pre-existing tombstone under this key is removed.
     */
    put(key: string, value: unknown, size: number): PutResult {
        // Bookkeeping is lazy: TTL-sweep before deciding whether the
        // new entry fits, so an old expired entry can release room
        // even if its TTL hasn't been "noticed" yet.
        this.sweepExpired();

        if (size > this.singleArtifactCap) {
            // Do NOT tombstone here. Per plan §1.6, the too_large_for_store
            // marker lives on the envelope itself; the store stays clean.
            return { stored: false, reason: "too_large_for_store", size };
        }

        // Also reject if the value can't possibly fit even in an empty
        // store. This is only reachable when the caller misconfigures
        // singleArtifactCap > totalBytesCap; in the normal config
        // (128KB ≤ 1MB) the singleArtifactCap check above catches it
        // first. Doing this *before* any eviction guarantees the
        // public contract "a too_large_for_store rejection mutates
        // nothing" — including not destroying existing entries via
        // a futile LRU sweep that the rolled-back tombstone deletion
        // could not undo.
        if (size > this.totalBytesCap) {
            return { stored: false, reason: "too_large_for_store", size };
        }

        const evicted: EvictionRecord[] = [];

        // Overwrite path: remove the old entry's bytes before sizing
        // the new one. No tombstone — caller is replacing, not losing.
        const prev = this.live.get(key);
        if (prev !== undefined) {
            this.liveBytes -= prev.size;
            this.live.delete(key);
        }

        // Any prior tombstone under this exact key is now stale: the
        // caller is making the key live again. Drop it so recall
        // doesn't lie about it being evicted.
        this.tombstones.delete(key);

        // Evict LRU until the new entry fits. Order of iteration of
        // `live` is insertion order; we re-insert on touch (see `get`),
        // so the first key is the least-recently-accessed.
        //
        // Termination: size ≤ totalBytesCap was checked above, so once
        // `live` is empty we have `liveBytes=0` and `0+size ≤ cap`. The
        // loop cannot exit with the cap still exceeded.
        while (this.liveBytes + size > this.totalBytesCap && this.live.size > 0) {
            const oldestKey = this.live.keys().next().value as string | undefined;
            if (oldestKey === undefined) break;
            const oldest = this.live.get(oldestKey)!;
            this.live.delete(oldestKey);
            this.liveBytes -= oldest.size;
            this.writeTombstone(oldestKey, "lru", oldest.size);
            evicted.push({ key: oldestKey, reason: "lru", size: oldest.size });
        }

        this.live.set(key, { value, size, lastAccess: this.now() });
        this.liveBytes += size;
        return { stored: true, evicted };
    }

    /**
     * Look up `key`. Three outcomes:
     *   - Live hit: returns `{ found: true, value, size }`. Refreshes
     *     `lastAccess` (this is how LRU stays accurate).
     *   - Tombstone hit: returns `{ found: false, evicted: true, reason, size }`.
     *     Tombstones do **not** have their lifetime extended on read —
     *     they're FIFO-capped, not LRU.
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

        const tomb = this.tombstones.get(key);
        if (tomb !== undefined) {
            return { found: false, evicted: true, reason: tomb.reason, size: tomb.size };
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
     * tombstones are kept (subject to {@link tombstoneCap}) so any
     * in-flight `recall_artifact` on a session that has just been
     * torn down gets a meaningful reason rather than a bare miss.
     *
     * The plan (§1.3 "Session end: drop the entire store") allows
     * just dropping everything; the `session_end` tombstones are an
     * additive improvement for observability and cost nothing — a
     * `SessionRuntime` that doesn't outlive its caller's reference
     * to the store will let the whole instance be GC'd anyway.
     */
    clear(): void {
        const now = this.now();
        for (const [k, entry] of this.live) {
            this.writeTombstone(k, "session_end", entry.size, now);
        }
        this.live.clear();
        this.liveBytes = 0;
    }

    /** Snapshot for tests / debug UI. Not part of the public recall contract. */
    stats(): ArtifactStoreStats {
        return {
            liveCount: this.live.size,
            liveBytes: this.liveBytes,
            tombstoneCount: this.tombstones.size,
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
            this.writeTombstone(k, "ttl", e.size);
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
            this.writeTombstone(key, "ttl", e.size);
        }
    }

    /**
     * Write a tombstone, enforcing the FIFO cap. Using a `Map` for
     * tombstones gives us insertion-order iteration for free, so
     * "drop oldest" is `keys().next().value`.
     */
    private writeTombstone(
        key: string,
        reason: EvictionReason,
        size: number,
        createdAt: number = this.now(),
    ): void {
        // Re-insert if a tombstone for this key already exists, so the
        // newest reason wins (e.g. ttl-then-session_end on a stale entry).
        this.tombstones.delete(key);
        this.tombstones.set(key, { reason, size, createdAt });

        while (this.tombstones.size > this.tombstoneCap) {
            const oldest = this.tombstones.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.tombstones.delete(oldest);
        }
    }
}
