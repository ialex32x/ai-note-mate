import {
    MarkdownRenderer,
    App,
    Component,
} from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { StreamingMarkdownController } from './streaming-markdown-controller';
import { stripStructuredBlock } from '../../services/suggestions';
import type { BubbleContext } from '../bubble/bubble-context';
import {
    renderSubAgentBadge,
    renderDelegateTaskBubble,
    shouldShowRoleLabel,
} from '../bubble/sub-agent';
import { renderThinkingSection as renderThinkingSectionImpl } from '../bubble/thinking-section';
import { renderUserContent } from '../bubble/user-content';
import {
    attachImageContextMenu,
    attachLinkContextMenu,
} from '../bubble/context-menus';
import { renderToolCallContent as renderToolCallContentImpl } from '../bubble/tool-call';
import { SpeechController } from '../bubble/speech-controller';
import { renderActionBar as renderActionBarImpl, renderUserActionBar } from '../bubble/action-bar';

/**
 * Message bubble renderer - handles rendering of all message types.
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
     * Render a complete message bubble
     * @param msg - The message to render
     * @param options - Rendering options
     * @param options.parentEl - Optional parent element to append the bubble to. If not provided, creates a detached element.
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

        let statusCls = '';
        if (msg.role === 'tool_call' && msg.toolCallResult) {
            statusCls = ` session-bubble--tool-${msg.toolCallResult.status}`;
        }
        // Apply sub-agent origin classes so the UI can render a colored side bar
        // + badge for messages produced by a sub-agent.
        let subAgentCls = '';
        if (msg.subAgent) {
            subAgentCls = ` session-bubble--subagent session-bubble--subagent-${msg.subAgent.agentName}`;
        }

        // Create bubble element - either attached to parent or detached
        const bubble = parentEl
            ? parentEl.createEl('div', {
                  cls: `session-bubble session-bubble--${msg.role}${statusCls}${subAgentCls}`,
              })
            : createEl('div', {
                  cls: `session-bubble session-bubble--${msg.role}${statusCls}${subAgentCls}`,
              });

        this.renderBubbleContent(bubble, msg, renderOptions);
        return bubble;
    }

    /**
     * Render message content into an existing bubble element.
     * This clears the existing bubble and re-renders its content.
     * @param bubble - The existing bubble element to render into
     * @param msg - The message to render
     * @param options - Rendering options
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
        // Sub-agent assistant reply with empty content: hide the bubble entirely
        // (avoid showing a lone "Reply from {agent}" collapsible header that
        // expands to nothing). The bubble will be revealed automatically on the
        // next render once content arrives.
        if (msg.role === 'assistant' && msg.subAgent && !msg.content.trim()) {
            bubble.empty();
            bubble.addClass('session-bubble--hidden');
            return;
        }
        // manage_todos tool calls are surfaced exclusively through the
        // pinned TodoPanel; keep the chat bubble itself collapsed so
        // mid-stream re-renders (e.g. when toolCallResult arrives)
        // don't briefly flash the default tool-call chrome.
        if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'manage_todos') {
            bubble.empty();
            bubble.addClass('session-bubble--hidden');
            return;
        }
        bubble.removeClass('session-bubble--hidden');

        // For streaming assistant messages, try to do an incremental update
        // instead of tearing down and rebuilding the entire DOM tree.
        if (msg.role === 'assistant' && msg.streaming) {
            const existing = bubble.querySelector('.session-bubble__content');
            if (existing instanceof HTMLElement && !this.subAgentBubbleNeedsFullRender(bubble, msg)) {
                this.updateStreamingAssistant(bubble, existing, msg, options);
                return;
            }
        }

        // Update bubble class
        bubble.className = `session-bubble session-bubble--${msg.role}`;
        if (msg.role === 'tool_call' && msg.toolCallResult) {
            bubble.addClass(`session-bubble--tool-${msg.toolCallResult.status}`);
        }
        if (msg.subAgent) {
            bubble.addClass('session-bubble--subagent');
            bubble.addClass(`session-bubble--subagent-${msg.subAgent.agentName}`);
        }

        // Remove any stale external action bar left from a previous render
        // before the bubble is rebuilt (applies to sub-agent and user bubbles
        // whose toolbars live outside the bubble border).
        if (msg.subAgent || msg.role === 'user') {
            const oldExternal = bubble.nextElementSibling;
            if (oldExternal?.classList.contains('session-bubble__actions--external')) {
                oldExternal.remove();
            }
        }

        // Clear existing content
        bubble.empty();

        this.renderBubbleContent(bubble, msg, options);

        // For sub-agents, move the action bar outside the bubble border
        // so the toolbar (copy/speak/insights) sits below the bubble rather
        // than inside its padded area
        if (msg.role === 'assistant' && msg.subAgent && msg.content.trim()) {
            const actionsEl = bubble.querySelector(':scope > .session-bubble__actions');
            if (actionsEl) {
                actionsEl.classList.add('session-bubble__actions--external');
                bubble.insertAdjacentElement('afterend', actionsEl);
            }
        }
    }

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
        // The trailing `…` loader at the tail of the message list is the
        // single global "AI is working" indicator now — bubbles no longer
        // host their own per-message streaming cursor.
        const controller = this.getOrCreateController(msg.id);
        controller.update(contentEl, msg.content);

        this.onScrollNeeded();
    }

    /**
     * Core rendering logic shared by render() and renderInto().
     * Populates the given bubble element with message content.
     */
    private renderBubbleContent(
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
        const {
            wasThinkingExpanded = false,
            wasToolDetailExpanded = false,
            abortedMessageIds = new Set<string>(),
            pendingConfirmations = new Map<string, (approved: boolean) => void>(),
            isBusy = false,
        } = options;

        // System messages: special handling
        if (msg.role === 'system') {
            this.renderSystemMessage(bubble, msg);
            return;
        }

        // delegate_task: render as a plain message bubble (task as content),
        // not as a collapsible tool-call bubble. The delegate_task's tool result
        // is intentionally hidden; the sub-agent's own assistant reply is shown
        // as a separate bubble instead.
        if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'delegate_task') {
            renderDelegateTaskBubble(bubble, msg);
            this.onScrollNeeded();
            return;
        }

        // manage_todos: the entire UI surface for this tool lives in
        // the pinned TodoPanel above the message list. Rendering a
        // per-call bubble in the conversation flow would be noise —
        // a long plan can produce 20+ updates that mean nothing to
        // the user once the panel state is already correct. We hide
        // the bubble with a dedicated class so the chat history file
        // still records the call (so future replays remain accurate)
        // but it takes no space. The `tool_call` ChatMessage stays
        // intact for the chat agent's own context.
        if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'manage_todos') {
            bubble.addClass('session-bubble--hidden');
            bubble.empty();
            return;
        }

        // Sub-agent badge: show which sub-agent produced this message
        if (msg.subAgent) {
            renderSubAgentBadge(bubble, msg.subAgent.agentName);
        }

        if (shouldShowRoleLabel(msg)) {
            bubble.createEl('span', {
                cls: 'session-bubble__role',
                text: this.roleLabel(msg.role),
            });
        }

        // Thinking section (assistant messages only)
        if (msg.role === 'assistant' && msg.thinkingContent) {
            // Thinking is complete if explicitly marked, or if message streaming has finished
            const thinkingComplete = msg.thinkingComplete === true || msg.streaming === false;
            this.renderThinkingSection(bubble, msg.thinkingContent, thinkingComplete, wasThinkingExpanded);
        }

        // Content
        const contentEl = bubble.createEl('div', { cls: 'session-bubble__content' });

        if (msg.role === 'tool_call') {
            renderToolCallContentImpl(this.ctx, contentEl, msg, wasToolDetailExpanded, pendingConfirmations);
        } else if (msg.role === 'assistant') {
            if (msg.streaming) {
                // Streaming: use throttled controller with markdown sanitization
                const controller = this.getOrCreateController(msg.id);
                controller.update(contentEl, msg.content);
            } else {
                // Complete message or finalization: render directly
                this.finalizeStreamingController(msg.id, contentEl, msg.content);
            }
        } else if (msg.role === 'user') {
            renderUserContent(this.ctx, contentEl, msg.content);
            // Render inline action bar (Copy + Branch) — replaces the
            // previous right-click context menu so the same actions are
            // discoverable on hover without a secondary gesture.
            renderUserActionBar(
                bubble,
                msg,
                this.onBranchFromMessage,
            );
            // Move the user action bar outside the bubble border so it
            // sits below the bubble rather than inside its padded area,
            // matching the sub-agent toolbar behaviour.
            const userActionsEl = bubble.querySelector(':scope > .session-bubble__actions');
            if (userActionsEl) {
                userActionsEl.classList.add('session-bubble__actions--external');
                bubble.insertAdjacentElement('afterend', userActionsEl);
            }
        } else {
            contentEl.setText(msg.content);
        }

        // Action bar (assistant messages only, and only if content is non-empty)
        if (msg.role === 'assistant' && msg.content.trim()) {
            renderActionBarImpl(this.ctx, bubble, msg, {
                abortedMessageIds,
                speechController: this.speechController,
                onExtractInsights: this.onExtractInsights,
                isBusy,
            });
        }

        this.onScrollNeeded();
    }

    /**
     * Render system message
     */
    private renderSystemMessage(bubble: HTMLElement, msg: ChatMessage): void {
        if (msg.content === 'aborted') {
            const divider = bubble.createEl('div', { cls: 'session-bubble__abort-divider' });
            divider.createEl('span', { cls: 'session-bubble__abort-text', text: t('view.responseAborted') });
        } else {
            bubble.createEl('span', { cls: 'session-bubble__role', text: 'System' });
            const contentEl = bubble.createEl('div', { cls: 'session-bubble__content' });
            contentEl.setText(msg.content);
        }
    }

    /**
     * Render tool call content
     */
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

    /**
     * Render markdown content (used for non-streaming / final renders).
     */
    private async renderMarkdownContent(contentEl: HTMLElement, markdown: string): Promise<void> {
        // Strip the machine-readable <!--suggestions ... --> block so that it
        // never appears in the rendered DOM (even though it's an HTML comment,
        // keeping it out avoids surprising copy-paste behaviour and keeps
        // trailing whitespace tidy).
        const cleaned = stripStructuredBlock(markdown);
        await MarkdownRenderer.render(this.app, cleaned, contentEl, '', this);
        attachImageContextMenu(this.ctx, contentEl);
        attachLinkContextMenu(this.ctx, contentEl);
    }

    // ── Streaming controller management ──────────────────────────────────────

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
     * If no controller exists, falls back to a direct render.
     */
    private finalizeStreamingController(
        messageId: string,
        contentEl: HTMLElement,
        content: string
    ): void {
        const controller = this.streamingControllers.get(messageId);
        if (controller) {
            void controller.finalize(contentEl, content).then(() => {
                this.disposeController(messageId);
            });
        } else {
            // No controller (e.g. loading from history) — render directly
            void this.renderMarkdownContent(contentEl, content);
        }
    }

    /**
     * Dispose a single streaming controller and remove it from the map.
     */
    private disposeController(messageId: string): void {
        const controller = this.streamingControllers.get(messageId);
        if (controller) {
            controller.dispose();
            this.streamingControllers.delete(messageId);
        }
    }

    /**
     * Dispose all active streaming controllers.
     */
    private disposeAllControllers(): void {
        for (const [, controller] of this.streamingControllers) {
            controller.dispose();
        }
        this.streamingControllers.clear();
    }

    // ── Utility methods ─────────────────────────────────────────────────────

    /**
     * Sub-agent bubbles that were first rendered without `subAgent` metadata
     * (or before a badge was added) can retain a stale "AI" role line while
     * streaming. Force a full re-render when that happens.
     */
    private subAgentBubbleNeedsFullRender(bubble: HTMLElement, msg: ChatMessage): boolean {
        if (!msg.subAgent) return false;
        const hasStaleRole = bubble.querySelector('.session-bubble__role') !== null;
        const missingBadge = bubble.querySelector('.session-bubble__subagent-badge') === null;
        const missingSubagentClass = !bubble.hasClass('session-bubble--subagent');
        return hasStaleRole || missingBadge || missingSubagentClass;
    }

    private roleLabel(role: ChatMessage['role']): string {
        switch (role) {
            case 'user':
                return t('view.roleYou');
            case 'assistant':
                return t('view.roleAI');
            case 'tool_call':
                return t('view.roleTool');
            case 'tool_result':
                return t('view.roleResult');
            case 'system':
                return '';
        }
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
