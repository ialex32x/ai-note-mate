import type { ChatMessage } from '../../services/chat-stream';
import type { SessionManager } from '../../session-manager';
import type { ScrollController } from './scroll-controller';
import type { InsightCoordinator } from './insight-coordinator';
import type { ChatAgentCallbacks } from './chat-factory';

/**
 * Minimal capability slice that the chat-agent callbacks need from
 * SessionView. Kept narrow so the builder stays a pure data-mover and
 * the view's private surface isn't widened beyond necessity.
 *
 * Behaviour is identical to what previously lived inline inside
 * `SessionView.getChatStream()`; this file is a pure relocation.
 */
export interface ChatCallbackContext {
    // Streaming/UX state mutators
    setStreaming(value: boolean): void;
    setInputLocked(locked: boolean): void;
    showTypingIndicator(): void;
    hideTypingIndicator(): void;

    // Bubble / message routing
    handleMessageUpdate(msg: ChatMessage): void;
    handleSubAgentMessageUpdate(msg: ChatMessage): void;
    handleAbort(msg: ChatMessage): void;
    appendErrorBubble(message: string): void;
    isMessageProducingVisibleContent(msg: ChatMessage): boolean;

    // Post-turn coordinators
    saveCurrentSessionState(): Promise<void>;
    maybeGenerateSessionTitle(): Promise<void>;
    maybeShowFollowUpSuggestions(): void;
    updateSessionStatusDisplay(): void;
    markContextCompressed(): void;

    // Externals reused as-is
    readonly sessionManager: SessionManager;
    readonly scroller: ScrollController;
    readonly insightCoordinator: InsightCoordinator;
    readonly pendingConfirmations: Map<string, (approved: boolean) => void>;
}

/**
 * Build the {@link ChatAgentCallbacks} object passed to
 * `createChatAgent(...)`. Callers still own `generationMatches` and
 * `getDynamicTools` (those depend on per-call closures), so this builder
 * deliberately omits them — the call site spreads them in alongside.
 */
export function buildChatAgentCallbacks(
    ctx: ChatCallbackContext,
): Omit<ChatAgentCallbacks, 'generationMatches' | 'getDynamicTools'> {
    return {
        onStart: () => {
            ctx.setStreaming(true);
            ctx.setInputLocked(true);
            ctx.showTypingIndicator();
        },
        onMessageUpdate: (msg) => {
            // Hide typing indicator as soon as the assistant starts
            // producing visible content (thinking text, streaming
            // content, or a streaming tool_call). In those states the
            // bubble itself (plus the blinking in-bubble `▍` cursor)
            // already indicates activity, so the global "waiting" dots
            // should step aside.
            if (ctx.isMessageProducingVisibleContent(msg)) {
                ctx.hideTypingIndicator();
            }
            ctx.handleMessageUpdate(msg);
        },
        onToolCallEnd: () => {
            // Tool execution completed - show typing indicator to fill the gap
            // before AI starts its next response (may include thinking)
            ctx.showTypingIndicator();
        },
        onFinish: () => {
            ctx.setStreaming(false);
            ctx.scroller.clearUserScrolledUp();
            ctx.hideTypingIndicator();
            ctx.setInputLocked(false);
            void ctx.saveCurrentSessionState();
            void ctx.maybeGenerateSessionTitle();
            // Save session cache to disk after each complete conversation round
            void ctx.sessionManager.saveToCache();
            // Offer quick-pick follow-up suggestions derived from the last
            // assistant reply, if the user has the feature enabled.
            ctx.maybeShowFollowUpSuggestions();
            // Optionally extract reusable knowledge nuggets from this turn.
            void ctx.insightCoordinator.maybeShowInsightCard();
        },
        onAbort: (msg) => {
            ctx.setStreaming(false);
            ctx.scroller.clearUserScrolledUp();
            ctx.hideTypingIndicator();
            ctx.handleAbort(msg);
        },
        onUsageUpdate: () => {
            ctx.updateSessionStatusDisplay();
        },
        onError: (err) => {
            console.warn('ChatStream error:', err);
            ctx.setStreaming(false);
            ctx.scroller.clearUserScrolledUp();
            ctx.hideTypingIndicator();
            ctx.setInputLocked(false);
            ctx.appendErrorBubble(err.message);
        },
        onContextCompressed: () => {
            ctx.markContextCompressed();
        },
        onSubAgentMessageUpdate: (_agentName, msg) => {
            // Mirror the main-agent rule: once the sub-agent
            // starts emitting visible content, hide the global
            // typing dots so the bubble's own cursor takes over.
            if (ctx.isMessageProducingVisibleContent(msg)) {
                ctx.hideTypingIndicator();
            }
            ctx.handleSubAgentMessageUpdate(msg);
        },
        onConfirmToolCall: (messageId) => {
            return new Promise<boolean>((resolve) => {
                ctx.pendingConfirmations.set(messageId, resolve);
            });
        },
    };
}
