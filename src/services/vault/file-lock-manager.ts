/**
 * GlobalFileLockManager — process-wide cross-session file lock table.
 *
 * Used to prevent two AI sessions from concurrently mutating the same
 * vault file. The lock model is intentionally minimal:
 *
 *   - Each entry is keyed by vault-relative path.
 *   - An entry records the owning `sessionId` plus a reference count.
 *   - Cross-session acquisition on an already-held path fails outright;
 *     callers (the {@link VaultMutator}) surface this as a tool error
 *     so the model can see "session X is currently working on this file"
 *     and react.
 *   - Same-session re-acquisition simply increments `refCount`. The
 *     caller is expected to gate "first vs repeat" at the
 *     {@link CheckpointStore} layer (one increment per file per
 *     checkpoint), so a typical lifecycle is:
 *
 *         A1 first-touches file X  → tryAcquire(X, A) → entry {A, 1}
 *         A2 first-touches file X  → tryAcquire(X, A) → entry {A, 2}
 *         A1 terminates            → release(X, A)    → entry {A, 1}
 *         A2 terminates            → release(X, A)    → entry removed
 *
 * Lifecycle:
 *   - The manager is a singleton on the plugin (`plugin.fileLockManager`)
 *     and holds *runtime-only* state — nothing is serialised. Plugin
 *     unload drops the whole table; the next launch starts fresh.
 *   - Callers must release every acquire they successfully made. The
 *     {@link CheckpointStore} owns this discipline: every path it adds
 *     to a checkpoint is balanced by exactly one release on
 *     accept/discard/runtime-dispose.
 *
 * Threading: JavaScript is single-threaded, so the table never has to
 * worry about racy CAS. All acquire/release operations are synchronous;
 * await points must come AFTER the acquire and BEFORE the matching
 * release to maintain the invariant.
 */

export interface FileLockEntry {
    readonly sessionId: string;
    readonly refCount: number;
}

export type AcquireResult =
    | { ok: true }
    | { ok: false; heldBy: string };

export class GlobalFileLockManager {
    private readonly table = new Map<string, { sessionId: string; refCount: number }>();

    /**
     * Attempt to acquire (or re-acquire) the lock for `path` on behalf
     * of `sessionId`. Returns `{ ok: true }` when the lock is now held
     * by the caller, or `{ ok: false, heldBy }` when a different
     * session already owns it.
     *
     * Increments the reference count when the caller already owns the
     * lock — callers are expected to balance every successful acquire
     * with exactly one release.
     */
    tryAcquire(path: string, sessionId: string): AcquireResult {
        const entry = this.table.get(path);
        if (!entry) {
            this.table.set(path, { sessionId, refCount: 1 });
            return { ok: true };
        }
        if (entry.sessionId !== sessionId) {
            return { ok: false, heldBy: entry.sessionId };
        }
        entry.refCount += 1;
        return { ok: true };
    }

    /**
     * Release one reference to `path` for `sessionId`. No-op when the
     * lock is not held, or held by another session (defensive — should
     * never happen if callers balance their acquires).
     *
     * When the reference count drops to zero the entry is removed
     * entirely so the table does not grow unboundedly over a long
     * plugin lifetime.
     */
    release(path: string, sessionId: string): void {
        const entry = this.table.get(path);
        if (!entry) return;
        if (entry.sessionId !== sessionId) {
            console.warn(
                "[file-lock] release called by non-owner: path=%s owner=%s caller=%s",
                path, entry.sessionId, sessionId,
            );
            return;
        }
        entry.refCount -= 1;
        if (entry.refCount <= 0) {
            this.table.delete(path);
        }
    }

    /**
     * True when the lock is held by some session OTHER than
     * `sessionId`. Used by read-only callers (notably the AI Edit
     * rewrite path, which does not participate in the checkpoint
     * model but must still respect active locks).
     */
    isHeldByOther(path: string, sessionId: string | undefined): boolean {
        const entry = this.table.get(path);
        if (!entry) return false;
        return entry.sessionId !== sessionId;
    }

    /**
     * Look up the current holder of `path`, or undefined when the path
     * is not locked. Returned object is a shallow snapshot — callers
     * must not mutate it.
     */
    getHolder(path: string): FileLockEntry | undefined {
        const entry = this.table.get(path);
        if (!entry) return undefined;
        return { sessionId: entry.sessionId, refCount: entry.refCount };
    }

    /**
     * Transfer the lock entry from `oldPath` to `newPath`. Used by the
     * `rename_or_move_file` tool so a rename inside a held checkpoint
     * does not silently drop the lock and let another session race in
     * on the new path.
     *
     * If `newPath` is already locked by a DIFFERENT session, the
     * transfer fails and the old entry is left untouched — the caller
     * (VaultMutator) should treat this as an acquire failure on
     * `newPath`. If `newPath` is held by the SAME session, the
     * reference counts are merged (rare but possible: same session
     * had a separate checkpoint touching `newPath` already).
     */
    transferOnRename(oldPath: string, newPath: string): AcquireResult {
        const oldEntry = this.table.get(oldPath);
        if (!oldEntry) {
            return { ok: true };
        }
        const newEntry = this.table.get(newPath);
        if (newEntry && newEntry.sessionId !== oldEntry.sessionId) {
            return { ok: false, heldBy: newEntry.sessionId };
        }
        if (newEntry) {
            newEntry.refCount += oldEntry.refCount;
        } else {
            this.table.set(newPath, { sessionId: oldEntry.sessionId, refCount: oldEntry.refCount });
        }
        this.table.delete(oldPath);
        return { ok: true };
    }

    /** Test/debug helper — number of entries currently in the table. */
    get size(): number {
        return this.table.size;
    }
}
