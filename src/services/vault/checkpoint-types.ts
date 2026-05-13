/**
 * Type model for per-session checkpoints.
 *
 * A checkpoint groups every AI-driven vault mutation that happened
 * inside a single main-agent round (one user message ↔ one assistant
 * turn). The checkpoint is the unit users accept or discard from the
 * UI; until they do, the files it touched are locked across sessions
 * via {@link GlobalFileLockManager}.
 *
 * State is entirely runtime-only. Nothing in here ever round-trips
 * through disk — restart wipes the world (snapshots dir + lock table +
 * checkpoint lists), see plugin-paths / SnapshotManager.clearAll.
 */

import type { VaultEditKind } from "../../edit-history/vault-edit-log-types";

/** Terminal-or-not state of a checkpoint. */
export type CheckpointStatus = "pending" | "accepted" | "discarded";

/**
 * One file participation in a checkpoint. Created the first time the
 * file is touched within that checkpoint; subsequent mutations to the
 * same file in the same round are no-ops at this layer (no second
 * entry, no second snapshot).
 *
 * Phase 1 scope: rollback (on discard) is only implemented for
 * {@link kind} === "modify". For "create" / "delete" / "rename" /
 * delete-folder, the entry exists so the file is correctly locked
 * across sessions, but discard will release the lock without
 * touching the vault — these mutations stay permanent in Phase 1.
 */
export interface CheckpointFileEntry {
    /**
     * Path at which the lock is held and the audit row was recorded.
     * For `modify`/`create`/`delete` this is the target file; for
     * `rename` this is the new (post-mutation) path.
     */
    path: string;
    /** Pre-rename path (`rename` only). */
    previousPath?: string;
    /** Which AI tool kind put this file into the checkpoint. */
    kind: VaultEditKind;
    /** True when `path` refers to a folder (`rename` / `delete_folder` only). */
    isFolder?: boolean;
    /**
     * Snapshot id produced by {@link SnapshotManager.takeContent}.
     * Populated only for `modify` entries on existing files where
     * we captured the pre-edit content. Undefined for other kinds.
     */
    snapshotId?: string;
}

/**
 * One checkpoint = one main-agent round's worth of vault mutations.
 * Created lazily the first time {@link VaultMutator} successfully
 * registers a mutation under the round's `anchorMessageId`. Stays
 * mutable until either:
 *   - the user accepts or discards it from the UI, OR
 *   - the owning {@link SessionRuntime} is disposed (auto-accept).
 */
export interface Checkpoint {
    /** Stable id (filesystem-safe), used to name the snapshot dir. */
    id: string;
    /**
     * Id of the user message that anchored this round. Stable across
     * the checkpoint's lifetime; UI "goto" jumps to this message.
     */
    anchorMessageId: string;
    /** Wall-clock creation timestamp. */
    createdAt: number;
    /** Current status. */
    status: CheckpointStatus;
    /** When status transitioned to terminal (accept / discard). */
    terminatedAt?: number;
    /**
     * Per-file entries keyed by path. Iteration order is insertion
     * order, which matches the order in which files were first
     * touched in this round.
     */
    files: Map<string, CheckpointFileEntry>;
}
