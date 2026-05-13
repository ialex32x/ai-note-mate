/**
 * Public entry point for the vault gateway layer.
 *
 * Anything that needs to mutate the vault on behalf of an AI tool
 * should go through {@link VaultMutator} rather than calling
 * `app.vault.*` directly. See `mutator.ts` for the full rationale.
 */

export { VaultMutator, VaultLockConflictError, runVaultMutation } from "./mutator";
export type { VaultMutation, BatchEntry } from "./mutator";
export { GlobalFileLockManager } from "./file-lock-manager";
export type { AcquireResult, FileLockEntry } from "./file-lock-manager";
export { SnapshotManager } from "./snapshot-manager";
export type { SnapshotManagerOptions } from "./snapshot-manager";
export { CheckpointStore } from "./checkpoint-store";
export type {
    CheckpointStoreOptions,
    RegisterFileInput,
    RegisterFileResult,
} from "./checkpoint-store";
export type { Checkpoint, CheckpointFileEntry, CheckpointStatus } from "./checkpoint-types";
