import {
    App,
    Component,
} from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import {
    StreamingMarkdownController,
    renderFinalMarkdown,
} from './streaming-markdown-controller';
import { stripStructuredBlock } from '../../services/suggestions';
import type { BubbleContext } from '../bubble/bubble-context';
import {
    getSubAgentLabel,
} from '../bubble/sub-agent';
import { renderThinkingSection as renderThinkingSectionImpl } from '../bubble/thinking-section';
import {
    attachImageContextMenu,
    attachLinkContextMenu,
} from '../bubble/context-menus';
import { SpeechController } from '../bubble/speech-controller';
import { ChatBubble, type ChatBubbleOptions } from '../bubble/chat-bubble';

/**
 * Message bubble renderer - handles rendering of all message types.
 *
 * Owns cross-bubble state (streaming controllers, speech controller,
 * floating layer) and delegates per-bubble DOM rendering to
 * {@link ChatBubble}, the single source of truth for bubble DOM structure.
 */
export class BubbleRenderer extends Component {
    /**
     * Shared context handed to bubble sub-modules. Constructed lazily so the
     * renderer's constructor stays parameter-compatible with call sites.
     */
    private ctx: BubbleContext;

    /**
     * Owns Web Speech (TTS) state — selected voice, currently-speaking
     * button, and in-flight utterance — across every bubble's speak
     * button. Constructed once in the ctor so the voice choice persists
     * for the lifetime of the renderer.
     */
    private speechController: SpeechController;

    /**
     * Active streaming controllers keyed by message ID.
     * Each streaming assistant message gets its own controller that
     * handles throttling and markdown sanitization.
     */
    private streamingControllers = new Map<string, StreamingMarkdownController>();

    /**
     * Lazily-created floating layer mounted inside `dropdownHost`. Acts as the
     * positioned ancestor (containing block) for absolute-positioned popups
     * such as the voice picker and tool-confirm dropdowns.
     *
     * Why a dedicated layer instead of mounting popups directly on the host:
     * - We don't want to mutate the host's `position`/style (the host is owned
     *   by the view and may be Obsidian's `containerEl`).
     * - `position: fixed` would also work, but its containing block can be
     *   hijacked by any ancestor with `transform`/`filter`/`contain`/
     *   `will-change`, which Obsidian and themes occasionally apply — that
     *   silently breaks viewport-based coordinates and pushes popups off
     *   screen. Anchoring to our own positioned layer avoids that class of
     *   bug entirely.
     *
     * The layer itself has zero footprint (`position: relative` with no size)
     * and is `pointer-events: none`; child popups opt back into pointer events
     * via the standard `.session-dropdown-menu` styles.
     */
    private floatingLayer: HTMLElement | null = null;

    constructor(
        private app: App,
        private onScrollNeeded: () => void,
        /**
         * Optional callback fired when the user clicks the per-bubble
         * "Extract insights" action on an assistant reply. The host (session
         * view) is expected to run a one-shot insight-extraction pass against
         * this specific message and surface the result in the existing
         * Insights block.
         *
         * When omitted, the action button is not rendered (the feature
         * gracefully degrades for renderer hosts that haven't opted in).
         */
        private onExtractInsights?: (msg: ChatMessage) => void,
        /**
         * Mount point for floating UI (e.g. the tool-confirm and voice
         * dropdowns) that must escape its bubble's clipping ancestors. When
         * omitted, falls back to `activeDocument.body` to preserve legacy behavior.
         *
         * Hosts should pass the view's container (e.g. `ItemView.containerEl`)
         * so floating elements are scoped to the view and get cleaned up
         * naturally when the view is detached. The renderer creates its own
         * positioned `session-floating-layer` inside this host, which acts
         * as the containing block for anchored popups — this avoids relying
         * on `position: fixed` (whose containing block can be hijacked by
         * ancestors with transform/filter/contain).
         */
        private dropdownHost: HTMLElement = activeDocument.body,
        /**
         * Optional callback fired when the user selects "Branch from here"
         * on a user message bubble. The host (session view) should fork the
         * current session at this message and drive the usual session-switch
         * flow. When omitted, the menu item is not shown.
         */
        private onBranchFromMessage?: (msg: ChatMessage) => void,
        /**
         * Optional callback fired when the user selects "Edit message"
         * on a user message bubble. The host (session view) should roll
         * back the conversation to before this message, discard any
         * affected checkpoints, and restore the message content to the
         * input box. When omitted, the button is not rendered.
         */
        private onEditFromMessage?: (msg: ChatMessage) => void,
        /**
         * Optional callback fired when the user clicks the jump button on an
         * AI bubble. The host should find the nearest preceding user message
         * and scroll to it.
         */
        private onJumpToPrevUser?: (msg: ChatMessage) => void,
        /** Callback: scroll to the next (following) user message. */
        private onJumpToNextUser?: (msg: ChatMessage) => void,
        /** Returns true when the given message has a previous user message to jump to (ID-based). */
        private canJumpToPrevUser?: (msg: ChatMessage) => boolean,
        /** Returns true when the given message has a next user message to jump to (ID-based). */
        private canJumpToNextUser?: (msg: ChatMessage) => boolean,
        /**
         * Optional callback for QuickAsk (追问). Fired when the user clicks
         * the "Ask follow-up" button on an assistant bubble.
         */
        private onQuickAsk?: (msg: ChatMessage) => void,
        /**
         * Optional getter: returns the set of message IDs that already
         * have QuickAsk side-turn data. Called at each render; the Set
         * is rebuilt lazily by the host so it stays current.
         */
        private getQuickAskMessageIds?: () => Set<string>,
        /**
         * Optional callback fired when the user clicks an attachment
         * image in a user message bubble. The host should open a
         * full-screen preview overlay for the image.
         */
        private onPreviewImage?: (src: string, fileName: string) => void,
    ) {
        super();
        this.ctx = {
            app: this.app,
            onScrollNeeded: () => this.onScrollNeeded(),
            getFloatingLayer: () => this.getFloatingLayer(),
            register: (cb) => this.register(cb),
            onExtractInsights: this.onExtractInsights,
        };
        this.speechController = new SpeechController(this.ctx);
    }

    /** Returns the host element used to mount floating UI. */
    getDropdownHost(): HTMLElement {
        return this.dropdownHost;
    }

    /**
     * Get (or lazily create) the floating layer used as the positioned
     * containing block for anchored popups. Mounted as a child of
     * `dropdownHost` so it shares the host's lifecycle.
     */
    private getFloatingLayer(): HTMLElement {
        if (!this.floatingLayer || !this.floatingLayer.isConnected) {
            this.floatingLayer = this.dropdownHost.createEl('div', {
                cls: 'session-floating-layer',
            });
            // Make sure the layer is removed when the renderer unloads, even
            // if the host outlives us (e.g. host is a long-lived containerEl
            // and the renderer is recreated across session switches).
            this.register(() => {
                this.floatingLayer?.remove();
                this.floatingLayer = null;
            });
        }
        return this.floatingLayer;
    }

    /**
     * Build a {@link ChatBubbleOptions} from the renderer's constructor
     * callbacks. Merged with per-call overrides.
     */
    private buildBubbleOpts(overrides: {
        wasThinkingExpanded?: boolean;
        wasToolDetailExpanded?: boolean;
        abortedMessageIds?: Set<string>;
        pendingConfirmations?: Map<string, (approved: boolean) => void>;
        isBusy?: boolean;
        hasQuickAskData?: boolean;
    }): ChatBubbleOptions {
        return {
            ...overrides,
            speechController: this.speechController,
            onExtractInsights: this.onExtractInsights,
            onEdit: this.onEditFromMessage,
            onBranch: this.onBranchFromMessage,
            onJumpToPrevUser: this.onJumpToPrevUser,
            onJumpToNextUser: this.onJumpToNextUser,
            canJumpToPrevUser: this.canJumpToPrevUser,
            canJumpToNextUser: this.canJumpToNextUser,
            onQuickAsk: this.onQuickAsk,
            hasQuickAskData: overrides.hasQuickAskData ?? false,
            onPreviewImage: this.onPreviewImage,
        };
    }

    /**
     * Render a complete message bubble.
     * @param msg - The message to render.
     * @param options - Rendering options.
     */
    render(
        msg: ChatMessage,
        options: {
            wasThinkingExpanded?: boolean;
            wasToolDetailExpanded?: boolean;
            abortedMessageIds?: Set<string>;
            pendingConfirmations?: Map<string, (approved: boolean) => void>;
            parentEl?: HTMLElement;
            isBusy?: boolean;
        } = {}
    ): HTMLElement {
        const { parentEl, ...renderOptions } = options;
        const bubbleOpts = this.buildBubbleOpts(renderOptions);

        const bubble = parentEl
            ? ChatBubble.createIn(parentEl, this.ctx, msg, bubbleOpts)
            : ChatBubble.create(this.ctx, msg, bubbleOpts);

        // For assistant messages, handle content rendering
        if (msg.role === 'assistant') {
            const contentEl = bubble.querySelector('.session-bubble__content');
            if (contentEl instanceof HTMLElement) {
                if (msg.streaming) {
                    const controller = this.getOrCreateController(msg.id);
                    controller.update(contentEl, msg.content);
                } else {
                    this.finalizeStreamingController(msg.id, contentEl, msg.content);
                }
            }
        }

        return bubble;
    }

    /**
     * Render message content into an existing bubble element.
     * This clears the existing bubble and re-renders its content.
     *
     * Delegates DOM structure to {@link ChatBubble.renderInto} — the
     * single source of truth for bubble layout. Cross-bubble concerns
     * (streaming controllers, speech) remain here.
     */
    renderInto(
        bubble: HTMLElement,
        msg: ChatMessage,
        options: {
            wasThinkingExpanded?: boolean;
            wasToolDetailExpanded?: boolean;
            abortedMessageIds?: Set<string>;
            pendingConfirmations?: Map<string, (approved: boolean) => void>;
            isBusy?: boolean;
        } = {}
    ): void {
        // Sub-agent assistant reply with empty content: hide the bubble
        if (msg.role === 'assistant' && msg.subAgent && !msg.content.trim()) {
            bubble.empty();
            bubble.addClass('session-bubble--hidden');
            return;
        }
        // manage_todos tool calls stay collapsed
        if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'manage_todos') {
            bubble.empty();
            bubble.addClass('session-bubble--hidden');
            return;
        }
        bubble.removeClass('session-bubble--hidden');

        // For streaming assistant messages, try incremental update
        if (msg.role === 'assistant' && msg.streaming) {
            const existing = bubble.querySelector('.session-bubble__content');
            if (existing instanceof HTMLElement && !this.subAgentBubbleNeedsFullRender(bubble, msg)) {
                this.updateStreamingAssistant(bubble, existing, msg, options);
                return;
            }
        }

        // Full re-render via ChatBubble
        const bubbleOpts = this.buildBubbleOpts({
            ...options,
            hasQuickAskData: this.getQuickAskMessageIds ? this.getQuickAskMessageIds().has(msg.id) : false,
        });
        ChatBubble.renderInto(bubble, this.ctx, msg, bubbleOpts);

        // For assistant messages, handle content rendering
        if (msg.role === 'assistant') {
            const contentEl = bubble.querySelector('.session-bubble__content');
            if (contentEl instanceof HTMLElement) {
                if (msg.streaming) {
                    const controller = this.getOrCreateController(msg.id);
                    controller.update(contentEl, msg.content);
                } else {
                    this.finalizeStreamingController(msg.id, contentEl, msg.content);
                }
            }
        }
    }

    // ── Incremental streaming update (performance optimisation) ────────

    /**
     * Incremental update for a streaming assistant message.
     * Only updates the content area and thinking section without
     * tearing down the entire bubble DOM.
     */
    private updateStreamingAssistant(
        bubble: HTMLElement,
        contentEl: HTMLElement,
        msg: ChatMessage,
        options: {
            wasThinkingExpanded?: boolean;
            wasToolDetailExpanded?: boolean;
            abortedMessageIds?: Set<string>;
            pendingConfirmations?: Map<string, (approved: boolean) => void>;
        }
    ): void {
        if (msg.subAgent) {
            bubble.querySelectorAll('.session-bubble__role').forEach((el) => el.remove());
        }

        // Update thinking section if present
        if (msg.thinkingContent) {
            const thinkingWrapper = bubble.querySelector('.collapsible-block--inline');
            if (thinkingWrapper instanceof HTMLElement) {
                // Update existing thinking section body text
                const body = thinkingWrapper.querySelector(':scope > .collapsible-block__body');
                if (body instanceof HTMLElement) body.setText(msg.thinkingContent);

                // Update streaming state
                const thinkingComplete = msg.thinkingComplete === true || msg.streaming === false;
                thinkingWrapper.toggleClass('collapsible-block--streaming', !thinkingComplete);
                const summary = thinkingWrapper.querySelector(':scope > .collapsible-block__header .collapsible-block__summary');
                if (summary instanceof HTMLElement) summary.setText(thinkingComplete ? t('view.thinkingDone') : t('view.thinkingInProgress'));
            } else {
                // Thinking section appeared for the first time — insert before content
                const wasExpanded = options.wasThinkingExpanded ?? false;
                const thinkingComplete = msg.thinkingComplete === true || msg.streaming === false;
                // Create a temporary container, render thinking into it, then insert
                const tempDiv = createEl('div');
                this.renderThinkingSection(tempDiv, msg.thinkingContent, thinkingComplete, wasExpanded);
                const newThinking = tempDiv.firstElementChild;
                if (newThinking) {
                    contentEl.parentElement?.insertBefore(newThinking, contentEl);
                }
            }
        }

        // Feed content to the streaming controller (throttled + sanitized).
        const controller = this.getOrCreateController(msg.id);
        controller.update(contentEl, msg.content);

        this.onScrollNeeded();
    }

    // ── Thinking section (public API preserved for backward compat) ────

    /**
     * Render the collapsible "thinking" section for an assistant message.
     *
     * Kept as a public method on the renderer so existing callers
     * (`updateStreamingAssistant`, the session view) can continue to invoke
     * `bubbleRenderer.renderThinkingSection(...)` unchanged. Delegates to
     * the pure-function implementation in `../bubble/thinking-section`.
     */
    renderThinkingSection(
        bubble: HTMLElement,
        thinkingContent: string,
        thinkingComplete: boolean,
        startExpanded = false
    ): void {
        renderThinkingSectionImpl(bubble, thinkingContent, thinkingComplete, startExpanded);
    }

    // ── Sub-agent full-render detection ────────────────────────────────

    /**
     * Sub-agent bubbles that were first rendered without `subAgent` metadata
     * can retain a stale "AI" role line while streaming. Force a full re-render
     * when that happens. After the first correct render (role label == expected
     * sub-agent name), streaming updates use the incremental path.
     */
    private subAgentBubbleNeedsFullRender(bubble: HTMLElement, msg: ChatMessage): boolean {
        if (!msg.subAgent) return false;
        const roleEl = bubble.querySelector('.session-bubble__role');
        if (!roleEl) return true; // No role label yet — needs render
        const expectedText = getSubAgentLabel(msg.subAgent.agentName);
        if (roleEl.textContent !== expectedText) return true; // Stale "AI" label
        if (!bubble.hasClass('session-bubble--subagent')) return true;
        return false;
    }

    // ── Streaming controller management ────────────────────────────────

    /**
     * Get or create a StreamingMarkdownController for the given message.
     */
    private getOrCreateController(messageId: string): StreamingMarkdownController {
        let controller = this.streamingControllers.get(messageId);
        if (!controller) {
            controller = new StreamingMarkdownController(this.app, this);
            controller.setAfterRenderCallback((el) => {
                attachImageContextMenu(this.ctx, el);
                attachLinkContextMenu(this.ctx, el);
                // The streaming renderer runs asynchronously (markdown render
                // is async + throttled ~100ms), so the DOM mutation that
                // grows the bubble happens LATER than the synchronous
                // onScrollNeeded() call in renderInto(). If we don't also
                // re-trigger auto-scroll here, the view stays pinned to the
                // old scroll position and never follows the newly appended
                // content.
                this.onScrollNeeded();
            });
            this.streamingControllers.set(messageId, controller);
        }
        return controller;
    }

    /**
     * Finalize and clean up the streaming controller for a message.
     * If no controller exists (e.g. loading from history), falls back
     * to a direct one-shot render.
     */
    private finalizeStreamingController(
        messageId: string,
        contentEl: HTMLElement,
        content: string
    ): void {
        const controller = this.streamingControllers.get(messageId);
        if (!controller) {
            // No controller (e.g. loading from history) — render directly.
            void this.renderFinalContent(contentEl, content);
            return;
        }

        this.streamingControllers.delete(messageId);
        void controller.finalize(contentEl, content, stripStructuredBlock).then(() => {
            controller.dispose();
        });
    }

    /**
     * Drop a streaming controller when its bubble is removed from the DOM
     * without going through the normal finalize path (e.g. ephemeral
     * thinking-only assistant bubbles on pure tool-call turns).
     */
    retireStreamingController(messageId: string): void {
        const controller = this.streamingControllers.get(messageId);
        if (!controller) return;
        controller.dispose();
        this.streamingControllers.delete(messageId);
    }

    /**
     * Dispose all active streaming controllers and forget them.
     *
     * Public so the session view can call it from `clearViewDOM()` on every
     * session switch / new-chat / clear — not just on view teardown. Each
     * controller owns a throttle timer and pending render state; emptying
     * `messagesEl` removes their target bubbles but leaves the controllers
     * (and their timers) alive in this map until the view unloads. Disposing
     * them here keeps the lifetime tied to the DOM they render into. The
     * controllers are recreated on demand by {@link getOrCreateController}
     * when the next session replays, so this is safe to call repeatedly.
     */
    disposeAllControllers(): void {
        for (const [, controller] of this.streamingControllers) {
            controller.dispose();
        }
        this.streamingControllers.clear();
    }

    /**
     * Render fully-formed markdown content (used for non-streaming / final
     * renders such as history loads). Shares the same preprocess +
     * after-render pipeline as {@link StreamingMarkdownController.finalize}
     * so streaming and non-streaming bubbles end up with identical DOM.
     */
    private renderFinalContent(contentEl: HTMLElement, markdown: string): Promise<void> {
        return renderFinalMarkdown(this.app, this, contentEl, markdown, {
            preprocess: stripStructuredBlock,
            afterRender: (el) => {
                attachImageContextMenu(this.ctx, el);
                attachLinkContextMenu(this.ctx, el);
            },
        });
    }

    /**
     * Cancel any in-flight speech. Delegated to the speech controller;
     * kept as a renderer-level method because external hosts (e.g. the
     * session view on detach) drive cancellation through the renderer.
     */
    cancelSpeech(): void {
        this.speechController.cancelSpeech();
    }

    onunload(): void {
        this.cancelSpeech();
        this.disposeAllControllers();
    }
}
