/**
 * Tiny helper that records a successful vault mutation into the plugin's
 * {@link VaultEditLogStore}. Lives here so individual edit tools can stay
 * focused on the mutation itself; the log bookkeeping is a one-liner.
 *
 * The helper never throws and never surfaces a Notice — logging is
 * best-effort audit data and must not interfere with the actual tool
 * result returned to the model.
 */

import type NoteAssistantPlugin from "../../../../main";
import type { ChatStream } from "../../../chat-stream";
import type { RecordVaultEditInput } from "../../../../edit-history/vault-edit-log-types";

export function recordVaultEdit(
    plugin: NoteAssistantPlugin,
    chatStream: ChatStream | undefined,
    input: Omit<RecordVaultEditInput, "sessionId">,
): void {
    try {
        const store = plugin.vaultEditLog;
        if (!store) return;
        store.record({
            ...input,
            sessionId: chatStream?.contextTag,
        });
    } catch (e) {
        // Never propagate — this is audit logging, not user-visible.
        console.warn("[vault-edit-log] record failed", e);
    }
}
