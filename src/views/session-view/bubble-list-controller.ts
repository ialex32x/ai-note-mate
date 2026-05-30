import type { ChatMessage, IChatAgent } from '../../services/chat-stream';
import type { BubbleRenderer } from '../../components/session';
import type { FollowUpBar } from '../../components/session/follow-up-bar';
import type { InsightCard } from '../../components/session/insight-card';
import type { StreamingLoader } from './streaming-loader';
import type { ScrollController } from './scroll-controller';
import type { MessageWindowController } from './message-window-controller';
import type { ErrorBubbleTracker } from './error-bubble';

export interface BubbleListControllerDeps {
    messagesEl: HTMLElement;
    bubbleRenderer: BubbleRenderer;
    errorBubbles: ErrorBubbleTracker;
    streamingLoader: StreamingLoader;
    scroller: ScrollController;
    messageWindow: MessageWindowController;
    followUpBar: FollowUpBar | null;
    insightCard: InsightCard | null;
    /** Whether the current session is streaming (isBusy). */
    isStreaming: () => boolean;
    /** Pending tool-call confirmations map from the runtime. */
    pendingConfirmations: () => Map<string, (approved: boolean) => void>;
    /** Refresh "new chat" button enabled state after DOM mutation. */
    updateNewChatBtnState: () => void;
    /** Lock/unlock the compose input area. */
    setInputLocked: (locked: boolean) => void;
    /** Access the current chat agent (may be undefined when no runtime is attached). */
    chat: () => IChatAgent | undefined;
    /** Refresh the session title in the toolbar. */
    updateSessionTitle: () => void;
}

export interface AppendBubbleOptions {
    /** Whether to register the bubble in the message-window controller. Default true. */
    trackInWindow?: boolean;
    /** Scroll behaviour: 'follow' wraps in auto-follow, 'none' skips scroll. Default 'follow'. */
    scrollMode?: 'follow' | 'none';
}

/**
 * Owns the bubble DOM map, aborted-message tracking, and the low-level
 * append/prepend/render/update/abort operations that SessionView used to
 * inline. Extracted from session-view.ts so the view delegates bubble
 * lifecycle to a focused controller.
 *
 * The controller does **not** own `messagesEl` or `bubbleRenderer` — it
 * receives them as constructor deps and orchestrates calls across them.
 * The `messageBubbles` and `abortedMessageIds` maps are public readonly
 * so callers in the view can read them directly (the existing API surface
 * uses `Map.get` / `Set.has`).
 */
export class BubbleListController {
    /** Maps message id → the DOM element currently rendering that message. */
    readonly messageBubbles: Map<string, HTMLElement> = new Map();
    /** Set of message IDs that were aborted by the user. */
    readonly abortedMessageIds: Set<string> = new Set();

    constructor(private readonly deps: BubbleListControllerDeps) {}

    /** Convenience: check if a message has been aborted. */
    isAborted(id: string): boolean {
        return this.abortedMessageIds.has(id);
    }

    /** Clear all tracked state and drop the error-continue-button reference. */
    clear(): void {
        this.messageBubbles.clear();
        this.abortedMessageIds.clear();
        this.deps.errorBubbles.forgetContinueBtn();
    }

    /**
     * Append a bubble to the tail of the message list.
     *
     * @param msg - The message to render.
     * @param opts.trackInWindow - Whether to register in the message-window controller (default true).
     * @param opts.scrollMode - 'follow' wraps creation in auto-follow scroll; 'none' skips (default 'follow').
     */
    append(msg: ChatMessage, opts: AppendBubbleOptions = {}): HTMLElement {
        const trackInWindow = opts.trackInWindow ?? true;
        const scrollMode = opts.scrollMode ?? 'follow';

        const build = () => this.createAndRender(msg);

        const bubble = scrollMode === 'follow'
            ? this.deps.scroller.runWithAutoFollow(build)
            : build();

        if (trackInWindow) {
            this.deps.messageWindow.registerAppendedUnit({ msg });
        }
        return bubble;
    }

    /**
     * Insert a bubble before an existing anchor node (older-history
     * prepend). Does not auto-scroll to the tail.
     */
    prepend(msg: ChatMessage, beforeEl: HTMLElement | null): HTMLElement {
        const bubble = this.createAndRender(msg);
        if (beforeEl) {
            // createAndRender builds the bubble at the list tail, so a unit
            // that externalises its action bar (user / sub-agent) leaves the
            // bar as the bubble's next sibling at the tail. Move it together
            // with the bubble — otherwise insertBefore relocates only the
            // bubble and the toolbar is orphaned at the tail as a standalone
            // flex child, which is always visible on mobile and accumulates
            // (one per prepended unit) as the user loads older history.
            const external = bubble.nextElementSibling;
            this.deps.messagesEl.insertBefore(bubble, beforeEl);
            if (external?.classList.contains('session-bubble__actions--external')) {
                this.deps.messagesEl.insertBefore(external, beforeEl);
            }
            this.deps.streamingLoader.pinToEnd();
        }
        return bubble;
    }

    /** Shared DOM construction for append and prepend paths. */
    private createAndRender(msg: ChatMessage): HTMLElement {
        // Any new bubble invalidates the previous follow-up suggestions bar
        // and insight card AT THE DOM LEVEL. Must dismiss BEFORE creating
        // the new bubble so neither tail element ends up sandwiched
        // between two bubbles. The runtime is the source of truth for
        // persisted insight state — its `insight-update`/`start` events
        // are what actually flip the canonical state; this hide is just
        // a defensive DOM cleanup for the rare case where a new bubble
        // arrives before the runtime's clear event has been observed
        // (e.g. during replay, where no runtime emit happens).
        this.deps.followUpBar?.hide();
        this.deps.insightCard?.hide();
        // A new chat bubble means the conversation has moved past the
        // last error tail (if any), so the inline "continue" affordance
        // is no longer applicable to that historical error.
        this.deps.errorBubbles.clearContinueBtn();

        let statusCls = '';
        if (msg.role === 'tool_call' && msg.toolCallResult) {
            statusCls = ` session-bubble--tool-${msg.toolCallResult.status}`;
        }
        let subAgentCls = '';
        if (msg.subAgent) {
            subAgentCls = ` session-bubble--subagent session-bubble--subagent-${msg.subAgent.agentName}`;
        }

        const bubble = this.deps.messagesEl.createEl('div', {
            cls: `session-bubble session-bubble--${msg.role}${statusCls}${subAgentCls}`,
        });

        this.deps.bubbleRenderer.renderInto(bubble, msg, {
            abortedMessageIds: this.abortedMessageIds,
            pendingConfirmations: this.deps.pendingConfirmations(),
            isBusy: this.deps.isStreaming(),
        });

        this.messageBubbles.set(msg.id, bubble);
        this.deps.streamingLoader.pinToEnd();
        this.deps.updateNewChatBtnState();
        return bubble;
    }

    /**
     * Update the content of an existing bubble element (re-render).
     * Preserves collapsible-block expanded states across the re-render.
     */
    updateContent(bubble: HTMLElement, msg: ChatMessage): void {
        // Preserve expanded states
        const thinkingBody = bubble.querySelector('.collapsible-block--inline .collapsible-block__body');
        const wasThinkingExpanded = thinkingBody?.classList.contains('collapsible-block__body--expanded') ?? false;
        const toolDetailBody = bubble.querySelector('.collapsible-block--tool .collapsible-block__body');
        const wasToolDetailExpanded = toolDetailBody?.classList.contains('collapsible-block__body--expanded') ?? false;

        // Same auto-follow snapshot rationale as append: a single
        // re-render can grow the bubble by hundreds of pixels (e.g. a
        // tool_call gaining its result detail body, or a thinking section
        // collapsing into a finalised assistant reply), so we must capture
        // the "was at bottom" intent before the synchronous DOM mutation.
        this.deps.scroller.runWithAutoFollow(() => {
            this.deps.bubbleRenderer.renderInto(bubble, msg, {
                wasThinkingExpanded,
                wasToolDetailExpanded,
                abortedMessageIds: this.abortedMessageIds,
                pendingConfirmations: this.deps.pendingConfirmations(),
                isBusy: this.deps.isStreaming(),
            });
        });
    }

    /**
     * Handle an aborted message: mark it, re-render its bubble, and
     * append any trailing system message.
     *
     * The caller (view) is expected to have already restored auto-follow
     * and hidden the streaming loader before calling this method.
     */
    handleAbort(msg: ChatMessage): void {
        this.deps.setInputLocked(false);

        if (msg.content) {
            this.abortedMessageIds.add(msg.id);
            const existing = this.messageBubbles.get(msg.id);
            if (existing) {
                this.updateContent(existing, msg);
            }
        }

        const messages = this.deps.chat()?.messages ?? [];
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'system') {
            this.append(lastMsg);
        }

        // Persistence is owned by the runtime (see runtime-factory's
        // onAbort) — the view only needs to refresh derived UI here.
        this.deps.updateSessionTitle();
    }
}
