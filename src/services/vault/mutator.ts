/**
 * VaultMutator — central gateway for AI-driven vault mutations.
 *
 * All AI edit tools (create / modify / rename / delete) funnel through
 * {@link VaultMutator.run} instead of calling `app.vault.*` and
 * audit-recording themselves. The gateway owns the cross-cutting
 * concerns that every mutation needs:
 *
 * - cross-session file locking via {@link GlobalFileLockManager}: a
 *   mutation against a path locked by another session is refused with
 *   a clear error pointing to the holder.
 * - per-checkpoint snapshotting via {@link CheckpointStore}: the
 *   first time a file enters a round's checkpoint the original
 *   content is captured so the round can be rolled back on user
 *   discard.
 * - audit logging into {@link VaultEditLogStore}: every successful
 *   mutation lands in the AI file-changes log.
 *
 * Phase 1 scope: rollback (on discard) only writes back content for
 * `modify` kind mutations. `create` / `delete` / `rename` / folder
 * ops are locked-but-not-rollbackable — discard releases the lock
 * without touching the vault.
 *
 * Design:
 * - Closure-based API: callers describe the mutation (kind / path /
 *   etc.) AND provide a `perform` closure that performs the actual
 *   vault call. The gateway wraps the call with lock + snapshot +
 *   audit without needing to know the specifics of each tool.
 * - Singleton on the plugin (`plugin.vaultMutator`), constructed
 *   once during `onload`.
 * - `chatStream` is passed per-call so the gateway can resolve the
 *   owning session's checkpoint store via
 *   `plugin.runtimePool.get(chatStream.contextTag)`.
 * - Mutations from contexts without a session (no `contextTag`, or
 *   the runtime is not in the pool) fall through to a plain
 *   perform + audit path — they neither acquire locks nor produce
 *   checkpoints.
 */

import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../main";
import type { ChatStream, ToolCallResult } from "../chat-stream";
import type { VaultEditKind } from "../../edit-history/vault-edit-log-types";
import type { CheckpointStore } from "./checkpoint-store";

/**
 * Tool-facing error thrown when a mutation cannot proceed because
 * another session currently owns the file's lock. Tool wrappers
 * convert this into a structured `success: false` result so the
 * model can react.
 */
export class VaultLockConflictError extends Error {
    readonly path: string;
    readonly heldBy: string;
    constructor(path: string, heldBy: string) {
        super(`File "${path}" is locked by session "${heldBy}".`);
        this.name = "VaultLockConflictError";
        this.path = path;
        this.heldBy = heldBy;
    }
}

/**
 * One vault mutation. Mirrors the shape of `RecordVaultEditInput`
 * (so audit-log integration stays a near-identity mapping) plus a
 * `perform` closure that the gateway invokes to actually mutate the
 * vault.
 */
export interface VaultMutation {
    /** Mutation kind, matches the audit-log taxonomy. */
    kind: VaultEditKind;
    /**
     * Target path AFTER the mutation. For `rename`, this is the new
     * path; for `create` / `modify` / `delete`, it is the path of the
     * affected file (or folder, for delete_folder).
     */
    path: string;
    /** For `rename` only: the original path. */
    previousPath?: string;
    /** True when `path` refers to a folder (`rename` / `delete` only). */
    isFolder?: boolean;
    /** Name of the AI tool driving this mutation (e.g. "write_file"). */
    toolName: string;
    /** The actual vault call. Awaited by the gateway. */
    perform: () => Promise<void>;
    /**
     * Optional list of child paths to register under the same
     * checkpoint as the main mutation. Used by `delete_folder` to
     * record per-file rollback data (one entry per descendant
     * file) while keeping the audit log a single folder-level row.
     *
     * Each entry gets its own cross-session lock acquisition and
     * (when `preEditContent` is supplied) its own content snapshot.
     * All locks are acquired synchronously up-front; if ANY of them
     * conflict with another session, the whole call is rejected
     * before perform runs and the partially-acquired locks are
     * released.
     */
    batchEntries?: BatchEntry[];
}

/**
 * Sibling entry inside {@link VaultMutation.batchEntries}. Mirrors
 * {@link RegisterFileInput} but is exposed under a distinct name
 * because it is part of the mutator's public surface, not the
 * checkpoint store's.
 */
export interface BatchEntry {
    path: string;
    previousPath?: string;
    kind: VaultEditKind;
    isFolder?: boolean;
    /**
     * Pre-mutation content for rollback. Supplied by the caller for
     * kinds whose rollback is content-based (`modify`, `delete`).
     */
    preEditContent?: string;
}

export class VaultMutator {
    constructor(private readonly plugin: NoteAssistantPlugin) {}

    /**
     * Execute `mutation.perform()` under the gateway's cross-cutting
     * concerns. Flow:
     *
     *   1. Resolve the owning session's {@link CheckpointStore}.
     *      Missing (no contextTag, or runtime not in pool) → plain
     *      perform + audit, no locking / snapshotting.
     *   2. Resolve the round's anchor message id from the chat's
     *      message list (latest user message). Missing → same plain
     *      fallback as step 1.
     *   3. Open the round's checkpoint (lazy — already open for the
     *      same anchor means the existing one is reused).
     *   4. Read pre-edit content for `modify` mutations on existing
     *      files; pass it to `registerFile` as the snapshot input.
     *   5. Register the path with the checkpoint store:
     *      - already in checkpoint  → no lock change, no snapshot,
     *        proceed to perform.
     *      - newly added             → lock acquired + snapshot
     *        captured, proceed to perform.
     *      - cross-session conflict  → throw {@link VaultLockConflictError}.
     *   6. Run `mutation.perform()`. On throw, the lock and snapshot
     *      stay with the checkpoint — the user can still accept /
     *      discard from the UI, and the mutation simply didn't
     *      happen.
     *   7. Record audit row.
     */
    async run(chatStream: ChatStream | undefined, mutation: VaultMutation): Promise<void> {
        const sessionId = chatStream?.contextTag;
        const runtime = sessionId ? this.plugin.runtimePool.get(sessionId) : undefined;
        const checkpointStore = runtime?.checkpointStore;

        if (!checkpointStore || !runtime) {
            // No session context → behave like the legacy
            // `recordVaultEdit` path: just perform + audit.
            await mutation.perform();
            this.recordAudit(chatStream, mutation);
            return;
        }

        const anchorMessageId = this.resolveAnchorMessageId(runtime);
        if (!anchorMessageId) {
            // No user message has been seen yet on this runtime —
            // there is nothing to anchor a checkpoint to. Fall back
            // to the plain perform + audit path so the mutation
            // still goes through; the rare "AI runs before any user
            // input" case (e.g. proactive insight) is uncommon and
            // does not need rollback support.
            await mutation.perform();
            this.recordAudit(chatStream, mutation);
            return;
        }

        // Capture pre-mutation content for kinds whose rollback is
        // content-based (`modify`, `delete`). `create` and `rename`
        // are metadata-only: nothing on disk before the action that
        // we'd need to snapshot.
        const needsContent = mutation.kind === "modify" || mutation.kind === "delete";
        const preEditContent = needsContent
            ? await this.readCurrentContentForSnapshot(mutation.path)
            : undefined;

        const mainEntry = {
            path: mutation.path,
            previousPath: mutation.previousPath,
            kind: mutation.kind,
            isFolder: mutation.isFolder,
            preEditContent,
        };

        // Register first; only on successful registration will the
        // checkpoint store open a new checkpoint for this round (lazy
        // open). Passing `anchorMessageId` to the store is what
        // enables that behavior — a failed lock acquire therefore
        // never leaves an empty pending checkpoint behind in the UI.
        // Batch path: when the mutation carries child entries (e.g.
        // delete_folder), register them atomically together with the
        // main entry so a single cross-session conflict aborts the
        // whole call before perform runs.
        if (mutation.batchEntries && mutation.batchEntries.length > 0) {
            const reg = await checkpointStore.registerBatch(
                [mainEntry, ...mutation.batchEntries],
                anchorMessageId,
            );
            if (!reg.ok) {
                throw new VaultLockConflictError(mutation.path, reg.heldBy);
            }
        } else {
            const reg = await checkpointStore.registerFile(mainEntry, anchorMessageId);
            if (!reg.ok) {
                throw new VaultLockConflictError(mutation.path, reg.heldBy);
            }
        }

        await mutation.perform();
        this.recordAudit(chatStream, mutation);
    }

    /**
     * Resolve the most recent user-message id on the runtime's chat
     * history. The checkpoint uses this as a stable "round anchor"
     * — UI "goto" jumps to this message, and consecutive mutations
     * in the same round share the same checkpoint instance via
     * {@link CheckpointStore.openIfNeeded}.
     */
    private resolveAnchorMessageId(runtime: { chat: { messages: readonly { id: string; role: string }[] } }): string | undefined {
        const msgs = runtime.chat.messages;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m && m.role === "user") return m.id;
        }
        return undefined;
    }

    /**
     * Read the current on-disk content of `path` for use as the
     * pre-edit snapshot. Returns `undefined` when the path doesn't
     * resolve to a file (folder, non-existent, or a binary asset that
     * `vault.read` would refuse). The caller treats `undefined` as
     * "no snapshot to take", which leaves the entry locked but
     * non-rollbackable — acceptable for Phase 1.
     */
    private async readCurrentContentForSnapshot(path: string): Promise<string | undefined> {
        const abs = this.plugin.app.vault.getAbstractFileByPath(path);
        if (!(abs instanceof TFile)) return undefined;
        try {
            return await this.plugin.app.vault.read(abs);
        } catch (e) {
            console.warn("[vault-mutator] pre-edit snapshot read failed", { path, error: e });
            return undefined;
        }
    }

    private recordAudit(chatStream: ChatStream | undefined, mutation: VaultMutation): void {
        try {
            const store = this.plugin.vaultEditLog;
            if (!store) return;
            store.record({
                kind: mutation.kind,
                path: mutation.path,
                previousPath: mutation.previousPath,
                isFolder: mutation.isFolder,
                toolName: mutation.toolName,
                sessionId: chatStream?.contextTag,
            });
        } catch (e) {
            console.warn("[vault-mutator] audit log failed", e);
        }
    }
}

// Re-export so callers don't need to know which file defines the
// shared types.
export type { CheckpointStore };

/**
 * Convenience wrapper for edit tools: runs the mutation through
 * {@link VaultMutator.run} and converts a {@link VaultLockConflictError}
 * into a structured `success: false` tool result. Any other error is
 * rethrown so the chat stream's outer handler produces a normal
 * exception path.
 *
 * Returns `null` on success — the caller proceeds to build its own
 * success payload. Returns a {@link ToolCallResult} when the lock
 * conflict was caught, which the caller surfaces as-is.
 *
 * Usage in tools:
 *
 *     const lockErr = await runVaultMutation(plugin, chatStream, {
 *         kind: "modify", path, toolName: "write_file",
 *         perform: async () => { await plugin.app.vault.modify(file, content); },
 *     });
 *     if (lockErr) return lockErr;
 */
export async function runVaultMutation(
    plugin: NoteAssistantPlugin,
    chatStream: ChatStream | undefined,
    mutation: VaultMutation,
): Promise<ToolCallResult | null> {
    try {
        await plugin.vaultMutator.run(chatStream, mutation);
        return null;
    } catch (e) {
        if (e instanceof VaultLockConflictError) {
            return {
                success: false,
                type: "text",
                content:
                    `Cannot modify "${e.path}": this file is currently part of an active, ` +
                    `unconfirmed checkpoint in another AI session (${e.heldBy}). ` +
                    `Wait until that session's pending changes are accepted or discarded, ` +
                    `or operate on a different file.`,
            };
        }
        throw e;
    }
}

