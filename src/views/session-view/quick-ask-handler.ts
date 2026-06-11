import { Notice } from 'obsidian';
import NoteAssistantPlugin from 'main';
import { t } from '../../i18n';
import { IChatAgent } from '../../services/chat-stream';
import { SessionRuntime } from '../../services/session-runtime';
import { createSummarizerConfig } from '../../services/chat-factory';
import { BubbleListController } from './bubble-list-controller';

export interface QuickAskHandlerDeps {
    plugin: NoteAssistantPlugin;
    getRuntime: () => SessionRuntime | undefined;
    bubbleList: BubbleListController;
    /** Refresh the QuickAsk panel after a submission (late-bound). */
    refreshQuickAskPanel: () => void;
}

/**
 * Handles QuickAsk side-inquiry submission/deletion against the active
 * runtime's chat agent, including persistence and the parent-bubble
 * "active" (orange) state refresh.
 */
export class QuickAskHandler {
    private readonly deps: QuickAskHandlerDeps;

    constructor(deps: QuickAskHandlerDeps) {
        this.deps = deps;
    }

    /**
     * Delete a QuickAsk turn and re-render the parent bubble
     * to remove the active button state.
     */
    async handleQuickAskDelete(parentMessageId: string): Promise<void> {
        const runtime = this.deps.getRuntime();
        if (!runtime) return;
        const chat = runtime.chat;
        if (!chat.removeQuickAskTurn) return;

        chat.removeQuickAskTurn(parentMessageId);
        await runtime.persist();
        await this.deps.plugin.sessionManager.saveToCache();

        // Re-render the parent bubble to drop the orange underline
        this.refreshParentBubble(parentMessageId, chat);
    }

    /**
     * Re-render the parent bubble after a QuickAsk completes so the button
     * picks up the active (orange) state.
     */
    private refreshParentBubble(parentMessageId: string, chat: IChatAgent): void {
        const bubble = this.deps.bubbleList.messageBubbles.get(parentMessageId);
        if (!bubble) return;
        const msg = chat.messages.find(m => m.id === parentMessageId);
        if (msg) {
            this.deps.bubbleList.updateContent(bubble, msg);
        }
    }

    /**
     * Execute a QuickAsk submission: call promptQuickAsk on the chat
     * agent with a summarizer-model config, then persist.
     */
    async handleQuickAskSubmit(
        parentMessageId: string,
        input: string,
    ): Promise<void> {
        const runtime = this.deps.getRuntime();
        if (!runtime) return;

        const chat = runtime.chat;
        if (!chat.promptQuickAsk) return;

        const summarizerConfig = createSummarizerConfig(this.deps.plugin);
        if (!summarizerConfig) {
            new Notice(t('view.noSummarizerConfigured'));
            return;
        }

        try {
            await chat.promptQuickAsk(parentMessageId, input, summarizerConfig);
            // Refresh the panel now that side-turn data has been updated
            this.deps.refreshQuickAskPanel();
            // Re-render the parent bubble so the QuickAsk button turns orange
            this.refreshParentBubble(parentMessageId, chat);
            // Persist side-turns to in-memory cache
            await runtime.persist();
            // Flush to disk immediately — QuickAsk is not a turn, so the
            // normal turn-finish saveToCache trigger won't fire for it.
            await this.deps.plugin.sessionManager.saveToCache();
        } catch (err) {
            console.error('[SessionView] QuickAsk submission failed:', err);
            new Notice(t('view.quickAskFailed'));
        }
    }
}
