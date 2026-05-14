/**
 * CheckpointStore — per-session state machine for round-grouped
 * vault mutations.
 *
 * The store owns:
 *   - the ordered list of {@link Checkpoint}s produced by this
 *     session (oldest first),
 *   - identity of the currently-open checkpoint (lazily opened on
 *     first mutation of a round, implicitly closed when the round's
 *     `anchorMessageId` changes),
 *   - the per-store async serialization that guarantees consecutive
 *     `registerFile` calls see a consistent view of "is this path
 *     already in the current checkpoint?".
 *
 * State machine (per checkpoint):
 *
 *     pending ──user accept──► accepted   (locks released, snapshots deleted)
 *        │
 *        └──user discard──► discarded     (snapshots restored, locks released)
 *
 * Cross-checkpoint propagation rules (matching the design discussion):
 *   - `accept(K)` auto-accepts every prior pending checkpoint.
 *   - `discard(K)` auto-discards every later pending checkpoint —
 *     and processes them in latest-first order so each snapshot's
 *     restore lands the file at the "state-at-start-of-that-round"
 *     it actually captured.
 *
 * Phase 1 scope:
 *   - `modify` → snapshot pre-edit content; rollback writes it back.
 *   - `create` → no snapshot needed; rollback trashes the file we
 *     created so the path is empty again.
 *   - `delete` → snapshot pre-delete content; rollback re-creates
 *     the file at its original path (parents auto-created).
 *   - `rename` → no snapshot needed; rollback renames `path` back
 *     to `previousPath` (Obsidian's `fileManager.renameFile` also
 *     fixes up internal links).
 *
 * Within a single checkpoint, entries are restored in a specific
 * order so they don't trample each other: rename → modify → create
 * → delete. This frees up paths that creates might want to clear,
 * lets modifies operate on files in their original locations, etc.
 */

import { type App, TFile } from "obsidian";
import type { GlobalFileLockManager } from "./file-lock-manager";
import type { SnapshotManager } from "./snapshot-manager";
import type { Checkpoint, CheckpointFileEntry } from "./checkpoint-types";
import type { VaultEditKind } from "../../edit-history/vault-edit-log-types";

/** Generate a checkpoint id. Short, filesystem-safe, locally unique. */
function generateCheckpointId(): string {
    return `cp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Input handed to {@link CheckpointStore.registerFile} (and the batch
 * variant). Mirrors the shape of {@link VaultMutation} but carries
 * the optional `preEditContent` field that VaultMutator computes
 * once per entry by reading the file before perform.
 */
export interface RegisterFileInput {
    path: string;
    previousPath?: string;
    kind: VaultEditKind;
    isFolder?: boolean;
    /**
     * Captured pre-mutation content for rollback. Used as the
     * snapshot blob. Provided by the caller for kinds whose
     * rollback is content-based (`modify`, `delete`); omitted for
     * kinds whose rollback is metadata-only (`create`, `rename`).
     */
    preEditContent?: string;
}

/**
 * Result of a registerFile attempt.
 *
 *   - `ok: true, alreadyInCheckpoint: true`  → the path was already
 *     in the current checkpoint; no lock change, no new snapshot,
 *     caller proceeds to perform.
 *   - `ok: true, alreadyInCheckpoint: false` → first time this path
 *     enters this checkpoint; lock acquired, snapshot taken (if
 *     applicable), caller proceeds to perform.
 *   - `ok: false, heldBy`                    → another session
 *     currently owns this path's lock; caller must refuse the
 *     mutation and surface the holder's session id.
 */
export type RegisterFileResult =
    | { ok: true; alreadyInCheckpoint: boolean }
    | { ok: false; heldBy: string };

export interface CheckpointStoreOptions {
    sessionId: string;
    lockManager: GlobalFileLockManager;
    snapshotManager: SnapshotManager;
    app: App;
}

/** Listener invoked whenever the list of checkpoints changes. */
type ChangeListener = () => void;

export class CheckpointStore {
    private readonly sessionId: string;
    private readonly lockManager: GlobalFileLockManager;
    private readonly snapshotManager: SnapshotManager;
    private readonly app: App;

    /** Checkpoints in creation order (oldest first). */
    private readonly _checkpoints: Checkpoint[] = [];

    /**
     * The checkpoint that subsequent `registerFile` calls will add to,
     * or undefined when no round has produced a mutation yet (or the
     * previous round's checkpoint has been implicitly closed by a new
     * round's anchor).
     */
    private _currentId: string | undefined;

    /**
     * Promise chain used to serialise `registerFile` calls within
     * this store. Ensures a second call observes the first's
     * `paths.has()` mutation BEFORE deciding whether to skip the
     * snapshot, so two parallel tool calls touching the same path
     * cannot both think they are "first" and double-snapshot.
     */
    private chain: Promise<void> = Promise.resolve();

    private readonly _changeListeners = new Set<ChangeListener>();

    constructor(options: CheckpointStoreOptions) {
        this.sessionId = options.sessionId;
        this.lockManager = options.lockManager;
        this.snapshotManager = options.snapshotManager;
        this.app = options.app;
    }

    // ── Read API ─────────────────────────────────────────────────────────

    /** All checkpoints ever produced by this session, oldest first. */
    get checkpoints(): readonly Checkpoint[] {
        return this._checkpoints;
    }

    /** The currently-open checkpoint, or undefined when none. */
    get current(): Checkpoint | undefined {
        if (!this._currentId) return undefined;
        return this._checkpoints.find(c => c.id === this._currentId);
    }

    /** True when at least one checkpoint is still pending. */
    get hasPending(): boolean {
        return this._checkpoints.some(c => c.status === "pending");
    }

    /** Number of checkpoints currently in `pending` status. */
    get pendingCount(): number {
        let n = 0;
        for (const c of this._checkpoints) {
            if (c.status === "pending") n++;
        }
        return n;
    }

    // ── Round / checkpoint lifecycle ─────────────────────────────────────

    /**
     * Return the open checkpoint for the given round anchor, creating
     * one if needed. When `anchorMessageId` differs from the current
     * open checkpoint's anchor (i.e. a new round has started), the
     * old one is implicitly closed and a fresh one is opened.
     *
     * Prefer passing `anchorMessageId` to `registerFile` /
     * `registerBatch` instead — those open the checkpoint lazily on
     * first SUCCESSFUL registration so a failed lock acquire never
     * leaves an empty pending checkpoint behind.
     */
    openIfNeeded(anchorMessageId: string): Checkpoint {
        const existing = this.resolveCurrentForAnchor(anchorMessageId);
        if (existing) return existing;
        const fresh = this.openCheckpoint(anchorMessageId);
        this.emit();
        return fresh;
    }

    /**
     * Resolve the current checkpoint that matches `anchorMessageId`,
     * or undefined when no such checkpoint is open. Pure read — never
     * mutates store state. When `anchorMessageId` is undefined,
     * returns whatever current pending checkpoint exists (legacy
     * behavior for callers that pre-opened via openIfNeeded).
     */
    private resolveCurrentForAnchor(anchorMessageId?: string): Checkpoint | undefined {
        const cur = this.current;
        if (!cur || cur.status !== "pending") return undefined;
        if (anchorMessageId === undefined) return cur;
        return cur.anchorMessageId === anchorMessageId ? cur : undefined;
    }

    /**
     * Allocate a new pending checkpoint and make it current. Does
     * NOT emit — callers are expected to follow up with a single
     * emit after they've placed entries (or to call this from inside
     * openIfNeeded which does emit unconditionally).
     */
    private openCheckpoint(anchorMessageId: string): Checkpoint {
        const fresh: Checkpoint = {
            id: generateCheckpointId(),
            anchorMessageId,
            createdAt: Date.now(),
            status: "pending",
            files: new Map(),
        };
        this._checkpoints.push(fresh);
        this._currentId = fresh.id;
        return fresh;
    }

    /**
     * Drop an empty checkpoint that was just opened lazily but
     * ended up receiving no entries (e.g. because every snapshot
     * failed). Restores `_currentId` to undefined when this was the
     * current one. No-op if the checkpoint has entries — accept /
     * discard are the only ways to retire non-empty checkpoints.
     */
    private discardEmptyCheckpoint(cp: Checkpoint): void {
        if (cp.files.size > 0) return;
        const idx = this._checkpoints.indexOf(cp);
        if (idx >= 0) this._checkpoints.splice(idx, 1);
        if (this._currentId === cp.id) this._currentId = undefined;
    }

    // ── Mutation registration ────────────────────────────────────────────

    /**
     * Try to add a path to the round's checkpoint, acquiring the
     * cross-session lock and snapshotting pre-edit content as needed.
     *
     * When `anchorMessageId` is provided AND no current checkpoint
     * matches it, the checkpoint is created LAZILY — only after the
     * lock acquire succeeds. A failed lock acquire therefore never
     * leaves an empty pending checkpoint behind in the UI.
     *
     * When `anchorMessageId` is omitted, the call falls back to the
     * legacy "use whatever current checkpoint exists" mode. This
     * keeps `openIfNeeded` + `registerFile` flows working without
     * change.
     *
     * The whole operation is serialised against other in-flight
     * registerFile / registerBatch calls in the same store so two
     * parallel mutations on the same path do not race on the
     * snapshot.
     */
    async registerFile(
        input: RegisterFileInput,
        anchorMessageId?: string,
    ): Promise<RegisterFileResult> {
        const prev = this.chain;
        let releaseNext: () => void = () => { /* placeholder */ };
        this.chain = new Promise<void>(resolve => { releaseNext = resolve; });
        try {
            await prev;
            return await this.registerFileImpl(input, anchorMessageId);
        } finally {
            releaseNext();
        }
    }

    private async registerFileImpl(
        input: RegisterFileInput,
        anchorMessageId?: string,
    ): Promise<RegisterFileResult> {
        let cp = this.resolveCurrentForAnchor(anchorMessageId);

        // Defensive: no anchor AND no current pending → caller forgot
        // to open one. Behave as a noop so the perform still runs.
        if (!cp && anchorMessageId === undefined) {
            return { ok: true, alreadyInCheckpoint: false };
        }

        // Idempotent re-registration within the same checkpoint.
        if (cp && cp.files.has(input.path)) {
            return { ok: true, alreadyInCheckpoint: true };
        }

        // Cross-session lock acquire. Same-session re-acquisition is
        // allowed (refCount++) — e.g. an earlier checkpoint of THIS
        // session already held the path, we just nest the lock.
        const acq = this.lockManager.tryAcquire(input.path, this.sessionId);
        if (!acq.ok) {
            return { ok: false, heldBy: acq.heldBy };
        }

        // For rename: ALSO acquire the source path so no other
        // session can repopulate it while our checkpoint is pending.
        // Without this lock, a `rename X→Y` followed by another
        // session creating a new file at X would make a later
        // `discard` (which renames Y back to X) fail with "target
        // already exists". Release the main lock if this fails so
        // partial state doesn't leak.
        if (input.kind === "rename" && input.previousPath) {
            const prevAcq = this.lockManager.tryAcquire(input.previousPath, this.sessionId);
            if (!prevAcq.ok) {
                this.lockManager.release(input.path, this.sessionId);
                return { ok: false, heldBy: prevAcq.heldBy };
            }
        }

        // Locks are secured — NOW it is safe to materialise a fresh
        // checkpoint for this round, if the caller wanted lazy open.
        let openedNow = false;
        if (!cp) {
            cp = this.openCheckpoint(anchorMessageId!);
            openedNow = true;
        }

        let snapshotId: string | undefined;
        try {
            snapshotId = await this.takeSnapshotIfNeeded(cp.id, input);
        } catch (e) {
            this.releaseAcquiredLocks(input);
            // If we just opened a fresh checkpoint for this call and
            // it never received an entry, drop it so the UI doesn't
            // show a phantom empty round.
            if (openedNow) this.discardEmptyCheckpoint(cp);
            throw e;
        }

        cp.files.set(input.path, {
            path: input.path,
            previousPath: input.previousPath,
            kind: input.kind,
            isFolder: input.isFolder,
            snapshotId,
        });
        this.emit();
        return { ok: true, alreadyInCheckpoint: false };
    }

    /**
     * Atomically register a batch of paths into the current checkpoint.
     *
     * Acquires every lock synchronously first; if any cross-session
     * conflict is detected, the already-acquired locks are released
     * and the call returns the holder's session id without touching
     * any snapshot disk I/O.
     *
     * Snapshots are then taken sequentially. A failed snapshot for
     * one entry only loses rollback for that single file (the lock
     * is released and the entry is dropped); other entries continue.
     *
     * Used by tools that mutate many files in a single atomic vault
     * call (e.g. `delete_folder` trashing a whole subtree). Single-
     * entry callers should keep using {@link registerFile}, which is
     * simpler and supports same-checkpoint idempotency.
     */
    async registerBatch(
        inputs: RegisterFileInput[],
        anchorMessageId?: string,
    ): Promise<RegisterFileResult> {
        const prev = this.chain;
        let releaseNext: () => void = () => { /* placeholder */ };
        this.chain = new Promise<void>(resolve => { releaseNext = resolve; });
        try {
            await prev;
            return await this.registerBatchImpl(inputs, anchorMessageId);
        } finally {
            releaseNext();
        }
    }

    private async registerBatchImpl(
        inputs: RegisterFileInput[],
        anchorMessageId?: string,
    ): Promise<RegisterFileResult> {
        let cp = this.resolveCurrentForAnchor(anchorMessageId);

        if (!cp && anchorMessageId === undefined) {
            return { ok: true, alreadyInCheckpoint: false };
        }

        // Phase A — synchronous lock acquire across all paths,
        // including each rename entry's previousPath. Any conflict
        // releases everything we've taken so far and bails out
        // WITHOUT opening a new checkpoint, so a doomed batch leaves
        // no empty pending entry behind.
        const fresh: RegisterFileInput[] = [];
        const acquired: string[] = [];
        const releaseAcquired = () => {
            for (const p of acquired) this.lockManager.release(p, this.sessionId);
        };
        for (const input of inputs) {
            if (cp && cp.files.has(input.path)) continue;
            const main = this.lockManager.tryAcquire(input.path, this.sessionId);
            if (!main.ok) {
                releaseAcquired();
                return { ok: false, heldBy: main.heldBy };
            }
            acquired.push(input.path);
            if (input.kind === "rename" && input.previousPath) {
                const prev = this.lockManager.tryAcquire(input.previousPath, this.sessionId);
                if (!prev.ok) {
                    releaseAcquired();
                    return { ok: false, heldBy: prev.heldBy };
                }
                acquired.push(input.previousPath);
            }
            fresh.push(input);
        }

        // Nothing fresh (every input was already in checkpoint) —
        // return without opening anything new.
        if (fresh.length === 0) {
            return { ok: true, alreadyInCheckpoint: true };
        }

        // Locks secured — materialise the checkpoint if the caller
        // wanted lazy open.
        let openedNow = false;
        if (!cp) {
            cp = this.openCheckpoint(anchorMessageId!);
            openedNow = true;
        }

        // Phase B — async per-entry snapshot. Failures are isolated
        // per entry (locks released, entry dropped) so a single bad
        // file doesn't block the whole batch.
        for (const input of fresh) {
            let snapshotId: string | undefined;
            try {
                snapshotId = await this.takeSnapshotIfNeeded(cp.id, input);
            } catch (e) {
                console.warn("[checkpoint] batch snapshot failed", { path: input.path, error: e });
                this.releaseAcquiredLocks(input);
                continue;
            }
            cp.files.set(input.path, {
                path: input.path,
                previousPath: input.previousPath,
                kind: input.kind,
                isFolder: input.isFolder,
                snapshotId,
            });
        }

        // Defensive: if every snapshot failed, the new checkpoint
        // would be empty — drop it.
        if (openedNow && cp.files.size === 0) {
            this.discardEmptyCheckpoint(cp);
        }
        this.emit();
        return { ok: true, alreadyInCheckpoint: false };
    }

    /**
     * Take a content snapshot if the caller provided `preEditContent`.
     * Returns the snapshot id or undefined. Lock unwinding on failure
     * is the caller's responsibility — this helper only does I/O.
     */
    private async takeSnapshotIfNeeded(
        checkpointId: string,
        input: RegisterFileInput,
    ): Promise<string | undefined> {
        if (input.preEditContent === undefined) return undefined;
        return await this.snapshotManager.takeContent(checkpointId, input.preEditContent);
    }

    /**
     * Release every lock this `input` would have acquired
     * (main path + optional rename source). Used on failed
     * snapshot capture so the failure path doesn't leak locks.
     */
    private releaseAcquiredLocks(input: RegisterFileInput): void {
        this.lockManager.release(input.path, this.sessionId);
        if (input.kind === "rename" && input.previousPath) {
            this.lockManager.release(input.previousPath, this.sessionId);
        }
    }

    // ── User-driven terminal transitions ─────────────────────────────────

    /**
     * Accept the checkpoint `id` AND every prior pending one in the
     * list. Releases their locks and deletes their snapshot blobs.
     * No-op when `id` is missing or already terminal.
     */
    async accept(id: string): Promise<void> {
        const targetIdx = this._checkpoints.findIndex(c => c.id === id);
        if (targetIdx < 0) return;
        const target = this._checkpoints[targetIdx]!;
        if (target.status !== "pending") return;

        // Walk in chronological order so audit-style listeners see the
        // earliest one resolve first. Order doesn't affect correctness
        // for accept (we just drop snapshots and release locks).
        for (let i = 0; i <= targetIdx; i++) {
            const cp = this._checkpoints[i]!;
            if (cp.status !== "pending") continue;
            this.releaseLocks(cp);
            cp.status = "accepted";
            cp.terminatedAt = Date.now();
            await this.snapshotManager.deleteCheckpoint(cp.id);
        }
        if (this._currentId && this._checkpoints[targetIdx]?.id === this._currentId) {
            this._currentId = undefined;
        } else if (this._currentId) {
            // Current may have been terminated as part of the prefix.
            const cur = this._checkpoints.find(c => c.id === this._currentId);
            if (!cur || cur.status !== "pending") this._currentId = undefined;
        }
        this.emit();
    }

    /**
     * Discard the checkpoint `id` AND every later pending one. Walks
     * latest-first so each snapshot's restore lands the file at the
     * state it was captured against. No-op when `id` is missing or
     * already terminal.
     */
    async discard(id: string): Promise<void> {
        const targetIdx = this._checkpoints.findIndex(c => c.id === id);
        if (targetIdx < 0) return;
        const target = this._checkpoints[targetIdx]!;
        if (target.status !== "pending") return;

        // Iterate from the newest pending down to `id`. Walking the
        // tail in reverse means restoring snapshot[N] before
        // snapshot[N-1], so each successive write lands on the file
        // state the earlier snapshot was captured against.
        for (let i = this._checkpoints.length - 1; i >= targetIdx; i--) {
            const cp = this._checkpoints[i]!;
            if (cp.status !== "pending") continue;
            await this.restoreCheckpoint(cp);
            this.releaseLocks(cp);
            cp.status = "discarded";
            cp.terminatedAt = Date.now();
            await this.snapshotManager.deleteCheckpoint(cp.id);
        }
        if (this._currentId) {
            const cur = this._checkpoints.find(c => c.id === this._currentId);
            if (!cur || cur.status !== "pending") this._currentId = undefined;
        }
        this.emit();
    }

    /**
     * Silently accept every still-pending checkpoint. Used by
     * {@link SessionRuntime.dispose} so a session that is destroyed
     * with pending checkpoints doesn't leak locks. The on-disk
     * mutations stay as they are; only the rollback option is lost
     * (which is exactly what an "implicit accept" means).
     */
    async acceptAllPending(): Promise<void> {
        for (const cp of this._checkpoints) {
            if (cp.status !== "pending") continue;
            this.releaseLocks(cp);
            cp.status = "accepted";
            cp.terminatedAt = Date.now();
            await this.snapshotManager.deleteCheckpoint(cp.id);
        }
        this._currentId = undefined;
        this.emit();
    }

    // ── Change events ────────────────────────────────────────────────────

    on(event: "change", cb: ChangeListener): () => void {
        if (event !== "change") return () => { /* no-op */ };
        this._changeListeners.add(cb);
        return () => this._changeListeners.delete(cb);
    }

    private emit(): void {
        for (const cb of this._changeListeners) {
            try { cb(); } catch (e) { console.error("[checkpoint] listener failed", e); }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /**
     * Release every lock held by the given checkpoint. Rename entries
     * hold TWO locks (target + source) so the helper has to mirror
     * the acquire path. Idempotent — the lock manager simply no-ops
     * on entries that don't exist.
     */
    private releaseLocks(cp: Checkpoint): void {
        for (const entry of cp.files.values()) {
            this.lockManager.release(entry.path, this.sessionId);
            if (entry.kind === "rename" && entry.previousPath) {
                this.lockManager.release(entry.previousPath, this.sessionId);
            }
        }
    }

    /**
     * Apply the rollback for every restorable entry in the given
     * checkpoint, in a kind-aware order:
     *
     *   1. `rename`  — move files back to their previous paths so
     *                  the slots they vacated are free again.
     *   2. `modify`  — restore content; files are now at the paths
     *                  the modify entry was registered against.
     *   3. `create`  — trash files that didn't exist before this
     *                  round, so freshly-vacated paths are clean.
     *   4. `delete`  — re-create files at their original paths
     *                  (parents are auto-created when missing).
     *
     * Failures during restore are logged and swallowed — partial
     * rollback is better than no rollback, and the user can fall
     * back to Obsidian's trash for deleted files.
     */
    private async restoreCheckpoint(cp: Checkpoint): Promise<void> {
        const byKind: Record<VaultEditKind, CheckpointFileEntry[]> = {
            rename: [], modify: [], create: [], delete: [],
        };
        for (const entry of cp.files.values()) byKind[entry.kind].push(entry);

        for (const entry of byKind.rename)  await this.tryRestoreRename(entry);
        for (const entry of byKind.modify)  await this.tryRestoreModify(cp, entry);
        for (const entry of byKind.create)  await this.tryRestoreCreate(entry);
        for (const entry of byKind.delete)  await this.tryRestoreDelete(cp, entry);
    }

    private async tryRestoreRename(entry: CheckpointFileEntry): Promise<void> {
        if (!entry.previousPath) return;
        try {
            const file = this.app.vault.getAbstractFileByPath(entry.path);
            if (!file) {
                console.warn("[checkpoint] rename source missing during discard",
                    { path: entry.path, target: entry.previousPath });
                return;
            }
            // fileManager.renameFile works for both TFile and TFolder
            // and updates internal links; same call site used by the
            // rename_or_move_file tool's perform.
            await this.app.fileManager.renameFile(file, entry.previousPath);
        } catch (e) {
            console.error("[checkpoint] rename rollback failed",
                { path: entry.path, target: entry.previousPath, error: e });
        }
    }

    private async tryRestoreModify(cp: Checkpoint, entry: CheckpointFileEntry): Promise<void> {
        if (!entry.snapshotId) return;
        try {
            const content = await this.snapshotManager.readContent(cp.id, entry.snapshotId);
            if (content === null) {
                console.warn("[checkpoint] modify snapshot missing during discard",
                    { checkpointId: cp.id, path: entry.path });
                return;
            }
            const file = this.lookupFile(entry.path);
            if (!file) {
                console.warn("[checkpoint] modify target missing during discard",
                    { path: entry.path });
                return;
            }
            await this.app.vault.modify(file, content);
        } catch (e) {
            console.error("[checkpoint] modify rollback failed", { path: entry.path, error: e });
        }
    }

    private async tryRestoreCreate(entry: CheckpointFileEntry): Promise<void> {
        try {
            const abs = this.app.vault.getAbstractFileByPath(entry.path);
            if (!abs) {
                // Already gone — nothing to do.
                return;
            }
            // Use fileManager.trashFile so the user can recover from
            // trash if they discarded by mistake; matches what
            // delete_files / delete_folder use for the forward path.
            await this.app.fileManager.trashFile(abs);
        } catch (e) {
            console.error("[checkpoint] create rollback failed", { path: entry.path, error: e });
        }
    }

    private async tryRestoreDelete(cp: Checkpoint, entry: CheckpointFileEntry): Promise<void> {
        if (!entry.snapshotId) return;
        try {
            const content = await this.snapshotManager.readContent(cp.id, entry.snapshotId);
            if (content === null) {
                console.warn("[checkpoint] delete snapshot missing during discard",
                    { checkpointId: cp.id, path: entry.path });
                return;
            }
            const existing = this.app.vault.getAbstractFileByPath(entry.path);
            if (existing) {
                console.warn("[checkpoint] delete rollback skipped: path already occupied",
                    { path: entry.path });
                return;
            }
            await this.ensureParentFolder(entry.path);
            await this.app.vault.create(entry.path, content);
        } catch (e) {
            console.error("[checkpoint] delete rollback failed", { path: entry.path, error: e });
        }
    }

    /**
     * Create the parent folder chain for `path` if missing.
     * Mirrors `_shared.ts:ensureParentFolder` but inlined to keep
     * `CheckpointStore` independent of the tools layer.
     */
    private async ensureParentFolder(path: string): Promise<void> {
        const parent = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
        if (!parent) return;
        if (this.app.vault.getAbstractFileByPath(parent)) return;
        await this.app.vault.createFolder(parent);
    }

    private lookupFile(path: string): TFile | null {
        const abs = this.app.vault.getAbstractFileByPath(path);
        return abs instanceof TFile ? abs : null;
    }
}
