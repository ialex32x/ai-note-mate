import { App, Notice } from 'obsidian';
import { t } from '../../i18n';
import { ChatMessage } from '../../services/chat-stream';
import { SessionManager } from '../../session-manager';
import { CheckpointActionConfirmModal } from '../../modals/checkpoint-action-confirm-modal';
import type { TokenUsage } from '../../services/llm-provider';
import { SessionRuntime } from '../../services/session-runtime';
import { CMInput } from '../../components/cm-input';
import { DraftInputController } from '../../components/session';
import { SessionPromptOptimizer } from './session-prompt-optimizer';
import { SessionRuntimeBinder } from './session-runtime-binder';

export interface MessageEditHandlerDeps {
    app: App;
    runtimeBinder: SessionRuntimeBinder;
    sessionManager: SessionManager;
    promptOptimizer: SessionPromptOptimizer;
    draftController: DraftInputController;
    cmInput: CMInput;
    getRuntime: () => SessionRuntime | undefined;
    waitForChatIdle: (timeoutMs?: number) => Promise<boolean>;
    guardSwitchSession: () => boolean;
    getStreaming: () => boolean;
}

/**
 * Owns the in-place message-edit flow: roll back the conversation to
 * before a chosen user message, discard affected checkpoints, persist
 * the truncated state, replay the UI, and restore the message text to
 * the input box for re-editing.
 */
export class MessageEditHandler {
    private readonly deps: MessageEditHandlerDeps;

    constructor(deps: MessageEditHandlerDeps) {
        this.deps = deps;
    }

    /**
     * Roll back the conversation to before the given user message,
     * discarding any affected checkpoints, and restore the message
     * content to the input box for re-editing.
     *
     * Unlike branching, this operates in-place — the current session
     * is truncated rather than forked.
     */
    async handleEditMessage(msg: ChatMessage): Promise<void> {
        if (msg.role !== 'user') return;
        if (!this.deps.guardSwitchSession()) return;
        const runtime = this.deps.getRuntime();
        if (!runtime) return;

        const chat = runtime.chat;
        const messages = chat.messages;
        const anchorIdx = messages.findIndex(m => m.id === msg.id);
        if (anchorIdx < 0) return;

        // ── Check for affected checkpoints ──────────────────────────
        // Build a set of message IDs that will be truncated (from the
        // target message onwards). Any pending checkpoint whose anchor
        // falls into this set must be discarded.
        const truncatedIds = new Set<string>();
        for (let i = anchorIdx; i < messages.length; i++) {
            const m = messages[i];
            if (m) truncatedIds.add(m.id);
        }

        const store = runtime.checkpointStore;
        const checkpoints = store.checkpoints;
        const affectedPending = checkpoints.filter(
            cp => cp.status === 'pending' && truncatedIds.has(cp.anchorMessageId),
        );

        // ── Confirm before editing ──────────────────────────────────
        const streamingNow = this.deps.getStreaming();
        let confirmMessage = t('view.editMessageConfirmMessage');
        if (streamingNow) {
            confirmMessage = `${confirmMessage}\n\n${t('view.editMessageConfirmAbortStreaming')}`;
        }
        const confirmed = await new CheckpointActionConfirmModal(
            this.deps.app,
            t('view.editMessageConfirmTitle'),
            confirmMessage,
            t('view.editMessage'),
            'discard',
        ).waitForResult();
        if (!confirmed) return;

        // Stop an in-flight reply before truncating chat state.
        if (this.deps.getStreaming()) {
            this.deps.promptOptimizer.abort();
            chat.abort();
            if (!await this.deps.waitForChatIdle()) {
                new Notice(t('view.editAbortTimeout'));
                return;
            }
        }

        // Discard affected checkpoints if any, earliest first so the
        // cascade rule (discard(id) → also discards all later pending)
        // handles the rest naturally.
        if (affectedPending.length > 0) {
            const [earliest] = affectedPending;
            if (earliest) await store.discard(earliest.id);
        }

        // ── Truncate messages before the anchor ─────────────────────
        const prefix = messages.slice(0, anchorIdx).map(m => ({
            ...m,
            streaming: false,
        }));

        const currentTokenUsage: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedPromptTokens: 0,
        };

        // Restore the chat agent to the truncated state
        chat.restoreState(prefix, currentTokenUsage);

        // Persist the truncated state via SessionManager
        await this.deps.sessionManager.saveSession(
            runtime.sessionId,
            prefix,
            currentTokenUsage,
        );

        // ── Rebuild the view DOM ────────────────────────────────────
        this.deps.runtimeBinder.clearViewDOM();
        // The runtime is still the same instance; we just truncated its
        // chat messages. Replay the UI from the new (truncated) state.
        await this.deps.runtimeBinder.replayRuntimeUI(runtime, { fromCache: true });

        // ── Restore the message content to the input ────────────────
        this.deps.cmInput.setContent(msg.content);
        this.deps.cmInput.focus();
        this.deps.draftController?.scheduleSave();

        new Notice(t('view.messageEdited'));
    }
}
