import {
    MarkdownRenderer,
    setIcon,
    setTooltip,
    Menu,
    Notice,
    TFile,
    TFolder,
    TAbstractFile,
    App,
    Component,
} from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { extractFileRefs } from '../cm-input/cm-input';
import { openFileInWorkspace, revealInNavigation, resolveFileRef } from '../../utils/workspace-utils';
import { StreamingMarkdownController } from './streaming-markdown-controller';
import { stripStructuredBlock } from '../../services/suggestions';

/**
 * Message bubble renderer - handles rendering of all message types.
 */
export class BubbleRenderer extends Component {
    private selectedVoiceURI: string | null = null;
    private speakingBtn: HTMLButtonElement | null = null;
    private currentUtterance: SpeechSynthesisUtterance | null = null;

    private static readonly SPEAK_ICON_NAME = 'volume-2' as const;
    private static readonly STOP_ICON_NAME = 'square' as const;

    /**
     * Active streaming controllers keyed by message ID.
     * Each streaming assistant message gets its own controller that
     * handles throttling and markdown sanitization.
     */
    private streamingControllers = new Map<string, StreamingMarkdownController>();

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
        private onExtractInsights?: (msg: ChatMessage) => void
    ) {
        super();
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
        bubble.removeClass('session-bubble--hidden');

        // For streaming assistant messages, try to do an incremental update
        // instead of tearing down and rebuilding the entire DOM tree.
        if (msg.role === 'assistant' && msg.streaming) {
            const existing = bubble.querySelector('.session-bubble__content') as HTMLElement | null;
            if (existing) {
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

        // Clear existing content
        bubble.empty();

        this.renderBubbleContent(bubble, msg, options);
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
        // Update thinking section if present
        if (msg.thinkingContent) {
            let thinkingWrapper = bubble.querySelector('.session-bubble__thinking') as HTMLElement | null;
            if (thinkingWrapper) {
                // Update existing thinking section body text
                const body = thinkingWrapper.querySelector('.session-bubble__thinking-body') as HTMLElement | null;
                if (body) body.setText(msg.thinkingContent);

                // Update streaming state
                const thinkingComplete = msg.thinkingComplete === true || msg.streaming === false;
                thinkingWrapper.toggleClass('session-bubble__thinking--streaming', !thinkingComplete);
                const summary = thinkingWrapper.querySelector('.session-bubble__thinking-summary') as HTMLElement | null;
                if (summary) summary.setText(thinkingComplete ? t('view.thinkingDone') : t('view.thinkingInProgress'));
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

        // Feed content to the streaming controller (throttled + sanitized)
        const controller = this.getOrCreateController(msg.id);
        controller.update(contentEl, msg.content);

        // Update streaming cursor.
        // The cursor is placed as a sibling AFTER contentEl (not inside it)
        // so that doRender()'s contentEl.empty() won't destroy it.
        let cursor = bubble.querySelector('.session-bubble__cursor') as HTMLElement | null;
        if (msg.streaming) {
            if (!cursor) {
                cursor = createEl('span', { cls: 'session-bubble__cursor', text: '▍' });
                contentEl.insertAdjacentElement('afterend', cursor);
            }
        } else if (cursor) {
            cursor.remove();
        }

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
        } = {}
    ): void {
        const {
            wasThinkingExpanded = false,
            wasToolDetailExpanded = false,
            abortedMessageIds = new Set(),
            pendingConfirmations = new Map(),
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
            this.renderDelegateTaskBubble(bubble, msg);
            this.onScrollNeeded();
            return;
        }

        // Sub-agent badge: show which sub-agent produced this message
        if (msg.subAgent) {
            const badge = bubble.createEl('span', {
                cls: `session-bubble__subagent-badge session-bubble__subagent-badge--${msg.subAgent.agentName}`,
            });
            const badgeIcon = badge.createEl('span', { cls: 'session-bubble__subagent-badge-icon' });
            setIcon(badgeIcon, this.getSubAgentIcon(msg.subAgent.agentName));
            badge.createEl('span', {
                cls: 'session-bubble__subagent-badge-text',
                text: this.getSubAgentLabel(msg.subAgent.agentName),
            });
        }

        // Role label — skipped for sub-agent bubbles since the agent badge
        // above already identifies the speaker (the generic "AI" label would
        // be redundant next to e.g. "Vault Agent").
        if (!msg.subAgent) {
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
            this.renderToolCallContent(contentEl, msg, wasToolDetailExpanded, pendingConfirmations);
        } else if (msg.role === 'assistant') {
            // Sub-agent reply: always wrap the content in a collapsible section,
            // default collapsed (both during streaming and after completion),
            // since the main agent's final answer typically summarises this reply.
            // Empty-content case is already filtered out earlier in renderInto.
            if (msg.subAgent) {
                this.wrapInSubAgentCollapsible(bubble, contentEl, msg);
            }

            if (msg.streaming) {
                // Streaming: use throttled controller with markdown sanitization
                const controller = this.getOrCreateController(msg.id);
                controller.update(contentEl, msg.content);
            } else {
                // Complete message or finalization: render directly
                this.finalizeStreamingController(msg.id, contentEl, msg.content);
            }
        } else if (msg.role === 'user') {
            this.renderUserContent(contentEl, msg.content);
        } else {
            contentEl.setText(msg.content);
        }

        // Streaming cursor — placed as a sibling after contentEl so that
        // the controller's contentEl.empty() won't destroy it.
        if (msg.streaming && msg.role !== 'tool_call') {
            const cursor = createEl('span', { cls: 'session-bubble__cursor', text: '▍' });
            contentEl.insertAdjacentElement('afterend', cursor);
        }

        // Action bar (assistant messages only, and only if content is non-empty)
        if (msg.role === 'assistant' && msg.content.trim()) {
            this.renderActionBar(bubble, msg, abortedMessageIds);
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
    private renderToolCallContent(
        contentEl: HTMLElement,
        msg: ChatMessage,
        wasToolDetailExpanded: boolean,
        pendingConfirmations: Map<string, (approved: boolean) => void>,
    ): void {
        const headerRow = contentEl.createEl('div', {
            cls: 'session-bubble__tool-header',
        });

        const arrow = wasToolDetailExpanded ? '▾' : '▸';
        const arrowSpan = headerRow.createEl('span', {
            cls: 'session-bubble__tool-arrow',
            text: arrow,
        });

        headerRow.createEl('span', {
            cls: 'session-bubble__tool-label',
            text: msg.streaming ? `${msg.content}  …` : msg.content,
        });

        if (msg.toolCallResult) {
            const statusIcon = msg.toolCallResult.status === 'error' ? '✕' : '✓';
            const statusCls = `session-bubble__tool-status session-bubble__tool-status--${msg.toolCallResult.status}`;
            headerRow.createEl('span', { cls: statusCls, text: statusIcon });
        }

        // Confirmation UI or streaming cursor
        if (msg.confirmationState === 'pending' && msg.streaming) {
            this.renderToolConfirmPending(contentEl, msg.id, pendingConfirmations);
        } else if (msg.confirmationState === 'allowed' || msg.confirmationState === 'rejected') {
            this.renderToolConfirmBadge(contentEl, msg.confirmationState);
            // After user approval, the tool is still executing — surface a
            // blinking cursor so the UI clearly conveys an in-progress state
            // (e.g. long-running image generation).
            if (msg.confirmationState === 'allowed' && msg.streaming) {
                contentEl.createEl('span', { cls: 'session-bubble__cursor', text: '▍' });
            }
        } else if (msg.streaming) {
            contentEl.createEl('span', { cls: 'session-bubble__cursor', text: '▍' });
        }

        // Collapsible detail section
        if (msg.toolCallMeta || msg.toolCallResult) {
            this.renderToolDetail(contentEl, msg, wasToolDetailExpanded, arrowSpan, headerRow);
        }

        // Context menu: copy arguments / copy result
        this.attachToolCallContextMenu(contentEl, msg);
    }

    /**
     * Attach a right-click menu to a tool-call bubble that allows the user
     * to copy the tool's arguments or result to the clipboard.
     *
     * Both entries are conditional: arguments only appear when toolCallMeta
     * is available, and result only when toolCallResult is available. The
     * menu is suppressed when neither is present (e.g. early streaming).
     */
    private attachToolCallContextMenu(rootEl: HTMLElement, msg: ChatMessage): void {
        rootEl.addEventListener('contextmenu', (e: MouseEvent) => {
            const hasArgs = !!msg.toolCallMeta;
            const hasResult = !!msg.toolCallResult;
            if (!hasArgs && !hasResult) return;

            e.preventDefault();
            e.stopPropagation();

            const menu = new Menu();

            if (hasArgs) {
                menu.addItem((item) => {
                    item.setTitle(t('view.copyToolArgs'));
                    item.setIcon('braces');
                    item.onClick(async () => {
                        const args = msg.toolCallMeta?.toolArgs;
                        const text = args === undefined ? '' : JSON.stringify(args, null, 2);
                        await this.copyToClipboard(text);
                    });
                });
            }

            if (hasResult) {
                menu.addItem((item) => {
                    item.setTitle(t('view.copyToolResult'));
                    item.setIcon('clipboard-copy');
                    item.onClick(async () => {
                        const text = msg.toolCallResult?.result ?? '';
                        await this.copyToClipboard(text);
                    });
                });
            }

            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });
    }

    private async copyToClipboard(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            new Notice(t('view.copied'));
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
        }
    }

    /**
     * Render a delegate_task message as a plain conversational bubble:
     * shows the target sub-agent badge and the task text as the bubble
     * content. The tool result and any internal tool-call progress are
     * intentionally omitted — the sub-agent's own replies / tool bubbles
     * rendered as sibling messages already convey all that information.
     */
    private renderDelegateTaskBubble(bubble: HTMLElement, msg: ChatMessage): void {
        const agentName = (msg.toolCallMeta?.toolArgs?.['agent'] as string | undefined) ?? 'agent';
        const taskText = (msg.toolCallMeta?.toolArgs?.['task'] as string | undefined) ?? '';

        // Agent badge (same visual treatment as sub-agent bubbles so the
        // "main agent → sub-agent" handoff reads naturally).
        const badge = bubble.createEl('span', {
            cls: `session-bubble__subagent-badge session-bubble__subagent-badge--${agentName}`,
        });
        const badgeIcon = badge.createEl('span', { cls: 'session-bubble__subagent-badge-icon' });
        setIcon(badgeIcon, this.getSubAgentIcon(agentName));
        badge.createEl('span', {
            cls: 'session-bubble__subagent-badge-text',
            text: this.getSubAgentLabel(agentName),
        });

        // Role label: reuse the assistant label so the bubble visually aligns
        // with other AI-originated turns.
        bubble.createEl('span', {
            cls: 'session-bubble__role',
            text: t('view.roleAI'),
        });

        // Content: render the task text as plain text (no tool-detail chrome).
        const contentEl = bubble.createEl('div', { cls: 'session-bubble__content' });
        if (taskText) {
            contentEl.createEl('div', {
                cls: 'session-bubble__delegate-task-text',
                text: taskText,
            });
        }

        // Streaming cursor while the delegate_task is in-flight.
        if (msg.streaming) {
            const cursor = createEl('span', { cls: 'session-bubble__cursor', text: '▍' });
            contentEl.insertAdjacentElement('afterend', cursor);
        }
    }

    /**
     * Get a human-readable label for a sub-agent.
     */
    private getSubAgentLabel(agentName: string): string {
        switch (agentName) {
            case 'vault': return t('view.subAgentVault');
            case 'web': return t('view.subAgentWeb');
            case 'code': return t('view.subAgentCode');
            default: return agentName;
        }
    }

    /**
     * Get a Lucide icon name for a sub-agent.
     */
    private getSubAgentIcon(agentName: string): string {
        switch (agentName) {
            case 'vault': return 'vault';
            case 'web': return 'globe';
            case 'code': return 'code';
            default: return 'bot';
        }
    }

    /**
     * Render tool detail section (args + result)
     */
    private renderToolDetail(
        contentEl: HTMLElement,
        msg: ChatMessage,
        wasToolDetailExpanded: boolean,
        arrowSpan: HTMLElement,
        headerRow: HTMLElement
    ): void {
        const detailBody = contentEl.createEl('div', {
            cls: wasToolDetailExpanded
                ? 'session-bubble__tool-detail-body session-bubble__tool-detail-body--expanded'
                : 'session-bubble__tool-detail-body',
        });

        // Args
        if (msg.toolCallMeta) {
            const argsWrapper = detailBody.createEl('div', { cls: 'session-bubble__tool-section' });
            argsWrapper.createEl('span', {
                cls: 'session-bubble__tool-section-label',
                text: 'Arguments',
            });
            const argsPre = argsWrapper.createEl('pre', { cls: 'session-bubble__tool-code' });
            argsPre.setText(JSON.stringify(msg.toolCallMeta.toolArgs, null, 2));
        }

        // Result
        if (msg.toolCallResult) {
            const resultWrapper = detailBody.createEl('div', { cls: 'session-bubble__tool-section' });
            resultWrapper.createEl('span', {
                cls: 'session-bubble__tool-section-label',
                text: 'Result',
            });
            const resultPre = resultWrapper.createEl('pre', { cls: 'session-bubble__tool-code' });
            const resultText = msg.toolCallResult.result;
            resultPre.setText(resultText.length > 2000 ? resultText.slice(0, 2000) + '\n... (truncated)' : resultText);
        }

        // Toggle handler
        let toolDetailExpanded = wasToolDetailExpanded;
        const toggleToolDetail = () => {
            toolDetailExpanded = !toolDetailExpanded;
            detailBody.toggleClass('session-bubble__tool-detail-body--expanded', toolDetailExpanded);
            arrowSpan.setText(toolDetailExpanded ? '▾' : '▸');
            headerRow.toggleClass('session-bubble__tool-header--expanded', toolDetailExpanded);
        };
        headerRow.addEventListener('click', toggleToolDetail);
        headerRow.style.cursor = 'pointer';
        if (wasToolDetailExpanded) {
            headerRow.addClass('session-bubble__tool-header--expanded');
        }
    }

    /**
     * Render thinking section
     * @param bubble Parent element
     * @param thinkingContent The reasoning text
     * @param thinkingComplete True if thinking phase is done (content output has begun or finished)
     * @param startExpanded Initial expanded state
     */
    renderThinkingSection(
        bubble: HTMLElement,
        thinkingContent: string,
        thinkingComplete: boolean,
        startExpanded = false
    ): void {
        const wrapper = bubble.createEl('div', {
            cls: thinkingComplete
                ? 'session-bubble__thinking'
                : 'session-bubble__thinking session-bubble__thinking--streaming',
        });

        const summaryText = thinkingComplete ? t('view.thinkingDone') : t('view.thinkingInProgress');
        const arrow = startExpanded ? '▾' : '▸';

        const header = wrapper.createEl('span', {
            cls: startExpanded
                ? 'session-bubble__thinking-header session-bubble__thinking-header--expanded'
                : 'session-bubble__thinking-header',
            attr: { 'aria-label': t('view.toggleThinking'), role: 'button', tabindex: '0' },
        });
        header.innerHTML = `<span class="session-bubble__thinking-arrow">${arrow}</span> <span class="session-bubble__thinking-summary">${summaryText}</span>`;

        const body = wrapper.createEl('div', {
            cls: startExpanded
                ? 'session-bubble__thinking-body session-bubble__thinking-body--expanded'
                : 'session-bubble__thinking-body',
        });
        if (thinkingContent) {
            body.setText(thinkingContent);
        }

        let expanded = startExpanded;
        const toggle = () => {
            expanded = !expanded;
            body.toggleClass('session-bubble__thinking-body--expanded', expanded);
            header.toggleClass('session-bubble__thinking-header--expanded', expanded);
            header.querySelector('.session-bubble__thinking-arrow')!.setText(expanded ? '▾' : '▸');
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
    }

    /**
     * Wrap a sub-agent's final assistant reply in a collapsible section.
     * Default state:
     *   - First render (no previous expanded marker on bubble): collapsed
     *   - Re-render (user had manually expanded): preserve that state
     *
     * The content element (`contentEl`) is moved inside the collapsible body
     * after being created by the caller, so the caller's markdown rendering
     * still targets the same element — only its parent changes.
     */
    private wrapInSubAgentCollapsible(
        bubble: HTMLElement,
        contentEl: HTMLElement,
        msg: ChatMessage,
    ): void {
        const agentName = msg.subAgent?.agentName ?? 'agent';
        const agentLabel = this.getSubAgentLabel(agentName);

        // Preserve the user's manual toggle across re-renders within the
        // same DOM bubble (the caller has already emptied the bubble before
        // calling render, so we check for a data attribute that survives).
        const previouslyExpanded = bubble.dataset['subAgentReplyExpanded'] === '1';

        const wrapper = createEl('div', {
            cls: previouslyExpanded
                ? 'session-bubble__subagent-reply session-bubble__subagent-reply--expanded'
                : 'session-bubble__subagent-reply',
        });

        const header = wrapper.createEl('span', {
            cls: previouslyExpanded
                ? 'session-bubble__subagent-reply-header session-bubble__subagent-reply-header--expanded'
                : 'session-bubble__subagent-reply-header',
            attr: {
                'aria-label': t('view.toggleSubAgentReply'),
                role: 'button',
                tabindex: '0',
            },
        });
        const arrow = previouslyExpanded ? '▾' : '▸';
        header.innerHTML = `<span class="session-bubble__subagent-reply-arrow">${arrow}</span> <span class="session-bubble__subagent-reply-summary">${t('view.subAgentReplySummary', { agent: agentLabel })}</span>`;

        // Replace the pre-created contentEl with a body wrapper that contains it.
        contentEl.addClass('session-bubble__subagent-reply-body');
        if (previouslyExpanded) {
            contentEl.addClass('session-bubble__subagent-reply-body--expanded');
        }
        // Move contentEl into the wrapper (it was created on `bubble` by the caller).
        bubble.insertBefore(wrapper, contentEl);
        wrapper.appendChild(contentEl);

        const toggle = () => {
            const expanded = !header.hasClass('session-bubble__subagent-reply-header--expanded');
            wrapper.toggleClass('session-bubble__subagent-reply--expanded', expanded);
            header.toggleClass('session-bubble__subagent-reply-header--expanded', expanded);
            contentEl.toggleClass('session-bubble__subagent-reply-body--expanded', expanded);
            header.querySelector('.session-bubble__subagent-reply-arrow')!.setText(expanded ? '▾' : '▸');
            if (expanded) {
                bubble.dataset['subAgentReplyExpanded'] = '1';
            } else {
                delete bubble.dataset['subAgentReplyExpanded'];
            }
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
    }

    /**
     * Render action bar for assistant messages
     */
    private renderActionBar(
        bubble: HTMLElement,
        msg: ChatMessage,
        abortedMessageIds: Set<string>
    ): void {
        const actions = bubble.createEl('div', { cls: 'session-bubble__actions' });

        // Copy button
        const copyBtn = actions.createEl('button', {
            cls: 'session-icon-btn session-bubble__action-btn',
            attr: { 'aria-label': t('view.copyMessage') },
        });
        setIcon(copyBtn, 'copy');
        copyBtn.addEventListener('click', () => void this.onCopy(copyBtn, msg.content));

        // Speak button group
        if ('speechSynthesis' in window) {
            this.renderSpeakButtonGroup(actions, msg.content);
        }

        // Extract-insights button — only meaningful for non-aborted replies
        // and when a host callback is wired. Mirrors Copy/Speak as a plain
        // icon button (rather than a menu) to stay consistent with the rest
        // of the action bar and remain tap-friendly on mobile.
        if (this.onExtractInsights && !abortedMessageIds.has(msg.id)) {
            const insightBtn = actions.createEl('button', {
                cls: 'session-icon-btn session-bubble__action-btn',
                attr: {
                    'aria-label': t('view.extractInsights'),
                    type: 'button',
                },
            });
            setIcon(insightBtn, 'lightbulb');
            setTooltip(insightBtn, t('view.extractInsights'));
            insightBtn.addEventListener('click', () => {
                this.onExtractInsights?.(msg);
            });
        }

        // Aborted indicator
        if (abortedMessageIds.has(msg.id)) {
            actions.createEl('span', {
                cls: 'session-bubble__abort-label',
                text: t('view.responseStopped'),
            });
        }
    }

    /**
     * Render speak button with voice picker.
     *
     * The voice dropdown is lazily created on first open and lives in
     * `document.body` (to escape bubble overflow/stacking contexts). While
     * open, the host bubble gets a `--actions-pinned` modifier so the action
     * bar remains visible even when the pointer hovers the dropdown itself
     * (which lies outside the bubble and would otherwise end the :hover
     * state and fade the ▾ button out — making it look like the dropdown
     * "can no longer be opened" after selecting an item).
     */
    private renderSpeakButtonGroup(actions: HTMLElement, content: string): void {
        const speakGroup = actions.createEl('span', { cls: 'session-bubble__speak-group' });

        const speakBtn = speakGroup.createEl('button', {
            cls: 'session-icon-btn session-bubble__action-btn session-bubble__speak-btn',
            attr: { 'aria-label': t('view.speakMessage') },
        });
        setIcon(speakBtn, BubbleRenderer.SPEAK_ICON_NAME);
        speakBtn.addEventListener('click', () => this.onSpeak(speakBtn, content));

        const voicePickerBtn = speakGroup.createEl('button', {
            cls: 'session-icon-btn session-bubble__action-btn session-bubble__voice-picker-btn',
            attr: { 'aria-label': t('view.selectVoice') },
        });
        setIcon(voicePickerBtn, 'chevron-down');

        // Lazily created on first open; torn down on close to avoid leaking
        // detached dropdowns into document.body across bubble re-renders.
        let voiceDropdown: HTMLElement | null = null;
        let outsideClickHandler: ((ev: MouseEvent) => void) | null = null;
        let voicesChangedHandler: (() => void) | null = null;

        // Walk up to the enclosing bubble so we can pin the action bar while
        // the dropdown is open (see doc-comment above).
        const findBubble = (): HTMLElement | null => actions.closest('.session-bubble');

        const populateVoiceDropdown = (): boolean => {
            if (!voiceDropdown) return false;
            voiceDropdown.empty();
            const voices = speechSynthesis.getVoices();
            if (voices.length === 0) {
                voiceDropdown.createEl('div', {
                    cls: 'session-dropdown-item session-bubble__voice-item',
                    text: 'Loading voices…',
                });
                return false;
            }
            const sorted = [...voices].sort((a, b) => {
                if (a.localService !== b.localService) return a.localService ? 1 : -1;
                return a.lang.localeCompare(b.lang);
            });
            for (const v of sorted) {
                const item = voiceDropdown.createEl('div', { cls: 'session-dropdown-item session-bubble__voice-item' });
                const checkSpan = item.createEl('span', { cls: 'session-bubble__voice-item-check' });
                item.createEl('span', {
                    cls: 'session-bubble__voice-item-label',
                    text: v.localService ? `${v.name} (${v.lang})` : `${v.name} (${v.lang}) ★`,
                });
                if (this.selectedVoiceURI === v.voiceURI) {
                    item.addClasses(['session-dropdown-item--active', 'session-bubble__voice-item--active']);
                    setIcon(checkSpan, 'check');
                }
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.selectedVoiceURI = v.voiceURI;
                    closeVoiceDropdown();
                });
            }
            return true;
        };

        const closeVoiceDropdown = () => {
            if (voicesChangedHandler) {
                speechSynthesis.removeEventListener('voiceschanged', voicesChangedHandler);
                voicesChangedHandler = null;
            }
            if (outsideClickHandler) {
                document.removeEventListener('click', outsideClickHandler);
                outsideClickHandler = null;
            }
            if (voiceDropdown) {
                voiceDropdown.remove();
                voiceDropdown = null;
            }
            findBubble()?.removeClass('session-bubble--actions-pinned');
        };

        const openVoiceDropdown = () => {
            // Fresh element each open — keeps document.body clean and avoids
            // stale state accumulating across bubble re-renders.
            voiceDropdown = document.body.createEl('div', {
                cls: 'session-dropdown-menu session-dropdown-menu--fixed session-bubble__voice-dropdown',
            });

            const voicesReady = populateVoiceDropdown();
            if (!voicesReady) {
                voicesChangedHandler = () => {
                    if (populateVoiceDropdown() && voicesChangedHandler) {
                        speechSynthesis.removeEventListener('voiceschanged', voicesChangedHandler);
                        voicesChangedHandler = null;
                    }
                };
                speechSynthesis.addEventListener('voiceschanged', voicesChangedHandler);
            }

            const btnRect = voicePickerBtn.getBoundingClientRect();
            voiceDropdown.style.position = 'fixed';
            voiceDropdown.style.bottom = `${window.innerHeight - btnRect.top + 4}px`;
            voiceDropdown.style.left = `${btnRect.left}px`;
            voiceDropdown.style.right = '';
            voiceDropdown.addClass('session-dropdown-menu--open');
            findBubble()?.addClass('session-bubble--actions-pinned');

            requestAnimationFrame(() => {
                if (!voiceDropdown) return;
                const rect = voiceDropdown.getBoundingClientRect();
                if (rect.right > window.innerWidth) {
                    voiceDropdown.style.left = `${window.innerWidth - rect.width - 8}px`;
                }
            });

            outsideClickHandler = (ev: MouseEvent) => {
                const target = ev.target as Node;
                if (!speakGroup.contains(target) && !(voiceDropdown && voiceDropdown.contains(target))) {
                    closeVoiceDropdown();
                }
            };
            document.addEventListener('click', outsideClickHandler);
        };

        voicePickerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (voiceDropdown) {
                closeVoiceDropdown();
            } else {
                openVoiceDropdown();
            }
        });

        // Ensure cleanup if the BubbleRenderer itself unloads while a
        // dropdown is open.
        this.register(() => closeVoiceDropdown());
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
        this.attachImageContextMenu(contentEl);
        this.attachLinkContextMenu(contentEl);
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
                this.attachImageContextMenu(el);
                this.attachLinkContextMenu(el);
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

    /**
     * Render user message content with inline file references.
     * Parses [[path]] syntax and renders as clickable inline chips.
     */
    private renderUserContent(container: HTMLElement, content: string): void {
        const refs = extractFileRefs(content);

        // If no file references, just set text directly
        if (refs.length === 0) {
            container.setText(content);
            return;
        }

        // Build content with inline file references
        let lastEnd = 0;
        for (const ref of refs) {
            // Add text before this reference
            if (ref.start > lastEnd) {
                container.appendText(content.slice(lastEnd, ref.start));
            }

            // Render the file reference
            this.renderInlineFileRef(container, ref.path);

            lastEnd = ref.end;
        }

        // Add remaining text after last reference
        if (lastEnd < content.length) {
            container.appendText(content.slice(lastEnd));
        }
    }

    /**
     * Render an inline file reference chip.
     * Shows as clickable link with broken state for missing files.
     * Supports both full paths and short links (filename-only references).
     */
    private renderInlineFileRef(container: HTMLElement, path: string): void {
        const resolved = resolveFileRef(this.app, path);
        const exists = resolved !== null;
        const isFolder = resolved?.isFolder ?? false;
        const resolvedPath = resolved?.path ?? path;

        const chip = container.createEl('span', {
            cls: exists
                ? 'bubble-file-ref'
                : 'bubble-file-ref bubble-file-ref--missing',
        });

        // Add data attributes for hover preview (use resolved path)
        chip.setAttribute('data-href', resolvedPath);
        chip.setAttribute('data-path', resolvedPath);

        // Add tooltip with resolved full path (show original if short link)
        const tooltipPath = resolved?.isShortLink
            ? `${path} → ${resolvedPath}`
            : resolvedPath;
        setTooltip(chip, tooltipPath, { placement: 'top' });

        // Add icon
        const iconEl = chip.createEl('span', { cls: 'bubble-file-ref__icon' });
        setIcon(iconEl, isFolder ? 'folder' : 'file');

        // Add name (last segment of resolved path)
        const name = resolvedPath.split('/').pop() ?? resolvedPath;
        chip.createEl('span', { cls: 'bubble-file-ref__name', text: name });

        // Hover preview handler (only for files, not folders)
        if (exists && !isFolder) {
            const file = this.app.vault.getAbstractFileByPath(resolvedPath);
            if (file instanceof TFile) {
                chip.addEventListener('mouseenter', (evt) => {
                    this.app.workspace.trigger('hover-link', {
                        event: evt,
                        source: 'ai-assistant',
                        hoverParent: container,
                        targetEl: chip,
                        linktext: resolvedPath,
                    });
                });
            }
        }

        // Click handler
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            if (exists) {
                const file = this.app.vault.getAbstractFileByPath(resolvedPath);
                if (file instanceof TFolder) {
                    this.revealInExplorer(file);
                } else if (file instanceof TFile) {
                    this.openFile(file);
                }
            }
        });
    }

    /**
     * Render tool confirmation pending UI
     */
    renderToolConfirmPending(
        container: HTMLElement,
        messageId: string,
        pendingConfirmations: Map<string, (approved: boolean) => void>
    ): void {
        // Remove orphaned dropdown
        document.body.querySelector(`[data-confirm-msg-id="${messageId}"]`)?.remove();

        const confirmRow = container.createEl('div', { cls: 'session-bubble__tool-confirm' });

        const allowBtn = confirmRow.createEl('button', {
            cls: 'session-bubble__tool-confirm-btn',
            text: t('view.toolConfirmApprove'),
            attr: { type: 'button' },
        });

        const arrowWrap = confirmRow.createEl('span', { cls: 'session-bubble__tool-confirm-arrow-wrap' });
        const arrowBtn = arrowWrap.createEl('button', {
            cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-arrow',
            attr: { type: 'button', 'aria-label': 'More options' },
        });
        setIcon(arrowBtn, 'chevron-down');

        const dropdown = document.body.createEl('div', {
            cls: 'session-dropdown-menu session-dropdown-menu--fixed session-bubble__tool-confirm-dropdown',
            attr: { 'data-confirm-msg-id': messageId },
        });
        dropdown.hide();

        const rejectItem = dropdown.createEl('div', {
            cls: 'session-dropdown-item session-bubble__tool-confirm-dropdown-item',
            text: t('view.toolConfirmReject'),
        });

        let dropdownOpen = false;
        const closeDropdown = () => {
            dropdown.hide();
            dropdownOpen = false;
        };

        const finalize = (approved: boolean) => {
            closeDropdown();
            dropdown.remove();
            document.removeEventListener('click', outsideClickHandler);
            const resolve = pendingConfirmations.get(messageId);
            if (resolve) {
                pendingConfirmations.delete(messageId);
                resolve(approved);
            }
            // Update UI
            arrowWrap.remove();
            confirmRow.empty();
            if (approved) {
                confirmRow.createEl('span', {
                    cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--allowed',
                    text: t('view.toolConfirmAllowed'),
                });
            } else {
                const badge = confirmRow.createEl('span', {
                    cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--rejected',
                });
                const icon = badge.createEl('span', { cls: 'session-bubble__tool-confirm-reject-icon' });
                setIcon(icon, 'alert-triangle');
                badge.createEl('span', { text: t('view.toolConfirmRejected') });
            }
        };

        allowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            finalize(true);
        });

        arrowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (dropdownOpen) {
                closeDropdown();
            } else {
                const rect = arrowBtn.getBoundingClientRect();
                dropdown.style.position = 'fixed';
                dropdown.style.top = `${rect.bottom + 4}px`;
                dropdown.style.left = `${rect.left}px`;
                dropdown.show();
                dropdownOpen = true;
            }
        });

        rejectItem.addEventListener('click', (e) => {
            e.stopPropagation();
            finalize(false);
        });

        const outsideClickHandler = (ev: MouseEvent) => {
            if (!arrowWrap.contains(ev.target as Node) && !dropdown.contains(ev.target as Node)) {
                closeDropdown();
            }
        };
        requestAnimationFrame(() => {
            document.addEventListener('click', outsideClickHandler);
        });
    }

    /**
     * Render tool confirmation badge
     */
    renderToolConfirmBadge(container: HTMLElement, state: 'allowed' | 'rejected'): void {
        const confirmRow = container.createEl('div', { cls: 'session-bubble__tool-confirm' });
        if (state === 'allowed') {
            confirmRow.createEl('span', {
                cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--allowed',
                text: t('view.toolConfirmAllowed'),
            });
        } else {
            const badge = confirmRow.createEl('span', {
                cls: 'session-bubble__tool-confirm-btn session-bubble__tool-confirm-btn--result session-bubble__tool-confirm-btn--rejected',
            });
            const icon = badge.createEl('span', { cls: 'session-bubble__tool-confirm-reject-icon' });
            setIcon(icon, 'alert-triangle');
            badge.createEl('span', { text: t('view.toolConfirmRejected') });
        }
    }

    // ── Utility methods ─────────────────────────────────────────────────────

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

    private async onCopy(copyBtn: HTMLButtonElement, content: string): Promise<void> {
        await navigator.clipboard.writeText(content);
        setIcon(copyBtn, 'check');
        setTimeout(() => {
            setIcon(copyBtn, 'copy');
        }, 1500);
    }

    private onSpeak(btn: HTMLButtonElement, content: string): void {
        if (!('speechSynthesis' in window)) return;

        if (this.speakingBtn === btn && speechSynthesis.speaking) {
            speechSynthesis.cancel();
            this.resetSpeakButton();
            return;
        }

        if (speechSynthesis.speaking) {
            speechSynthesis.cancel();
        }

        const plainText = this.stripMarkdownForSpeech(content);

        const utterance = new SpeechSynthesisUtterance(plainText);
        this.currentUtterance = utterance;

        // Detect content language so the TTS engine picks the right phonetics.
        // Without this, Chinese text read by an English voice produces garbled
        // output and vice-versa.
        utterance.lang = this.detectLanguage(plainText);

        if (this.selectedVoiceURI) {
            const voice = speechSynthesis.getVoices().find(v => v.voiceURI === this.selectedVoiceURI);
            if (voice) utterance.voice = voice;
        }

        utterance.onend = () => this.resetSpeakButton();
        utterance.onerror = () => this.resetSpeakButton();

        btn.innerHTML = '';
        setIcon(btn, BubbleRenderer.STOP_ICON_NAME);
        btn.classList.add('session-bubble__action-btn--speaking');
        this.speakingBtn = btn;

        speechSynthesis.speak(utterance);
    }

    /**
     * Strip markdown formatting from content to produce clean speech text.
     */
    private stripMarkdownForSpeech(content: string): string {
        return content
            // Remove HTML comments (e.g. <!--suggestions ...-->)
            .replace(/<!--[\s\S]*?-->/g, '')
            // Remove HTML tags
            .replace(/<[^>]+>/g, '')
            // Remove fenced code blocks
            .replace(/```[\s\S]*?```/g, ' code block ')
            // Remove inline code
            .replace(/`([^`]+)`/g, '$1')
            // Remove bold
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            // Remove italic
            .replace(/\*([^*]+)\*/g, '$1')
            // Remove images (keep alt text)
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
            // Remove links (keep link text)
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Remove headings markers
            .replace(/^#{1,6}\s+/gm, '')
            // Remove horizontal rules
            .replace(/^[-*_]{3,}\s*$/gm, '')
            // Remove blockquote markers
            .replace(/^>\s?/gm, '')
            // Remove unordered list markers
            .replace(/^[-*+]\s+/gm, '')
            // Remove ordered list markers
            .replace(/^\d+\.\s+/gm, '')
            // Remove table formatting
            .replace(/^\|?.+\|.*$/gm, (line) => {
                return line.replace(/[|]/g, ' ').replace(/[-:]{3,}/g, '');
            })
            // Remove LaTeX math
            .replace(/\$\$[\s\S]*?\$\$/g, ' math expression ')
            .replace(/\$([^$]+)\$/g, '$1')
            // Collapse multiple blank lines into a pause
            .replace(/\n{2,}/g, '. ')
            // Replace remaining newlines with space
            .replace(/\n/g, ' ')
            // Collapse multiple spaces
            .replace(/ {2,}/g, ' ')
            .trim();
    }

    /**
     * Detect the language of the given text.
     * Returns a BCP 47 language tag suitable for SpeechSynthesisUtterance.lang.
     *
     * Uses a simple heuristic: if CJK characters dominate, tag as Chinese;
     * if Japanese kana are present, tag as Japanese; if Hangul is present,
     * tag as Korean; otherwise default to the user's locale.
     */
    private detectLanguage(text: string): string {
        const sample = text.slice(0, 500);
        let cjkCount = 0;
        let hiraganaKatakanaCount = 0;
        let hangulCount = 0;

        for (const ch of sample) {
            const code = ch.codePointAt(0)!;
            // CJK Unified Ideographs (common to Chinese & Japanese)
            if ((code >= 0x4E00 && code <= 0x9FFF) ||
                (code >= 0x3400 && code <= 0x4DBF) ||
                (code >= 0xF900 && code <= 0xFAFF)) {
                cjkCount++;
            }
            // Hiragana & Katakana (Japanese)
            if ((code >= 0x3040 && code <= 0x309F) ||
                (code >= 0x30A0 && code <= 0x30FF)) {
                hiraganaKatakanaCount++;
            }
            // Hangul (Korean)
            if ((code >= 0xAC00 && code <= 0xD7AF) ||
                (code >= 0x1100 && code <= 0x11FF) ||
                (code >= 0x3130 && code <= 0x318F)) {
                hangulCount++;
            }
        }

        if (hangulCount > 0 && hangulCount >= cjkCount) return 'ko';
        if (hiraganaKatakanaCount > 0) return 'ja';
        if (cjkCount > 0) return 'zh-CN';

        // Default: use the Obsidian locale if available, otherwise 'en'
        const locale = window.localStorage.getItem('language') || 'en';
        return locale;
    }

    resetSpeakButton(): void {
        if (this.speakingBtn) {
            this.speakingBtn.innerHTML = '';
            setIcon(this.speakingBtn, BubbleRenderer.SPEAK_ICON_NAME);
            this.speakingBtn.classList.remove('session-bubble__action-btn--speaking');
        }
        this.speakingBtn = null;
        this.currentUtterance = null;
    }

    cancelSpeech(): void {
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        this.resetSpeakButton();
    }

    private openFile(file: TFile): void {
        openFileInWorkspace(this.app, file);
    }

    private revealInExplorer(target: TFile | TFolder): void {
        revealInNavigation(this.app, target);
    }

    // ── Context menu handlers ────────────────────────────────────────────────

    private attachImageContextMenu(container: HTMLElement): void {
        const images = container.querySelectorAll('img');
        images.forEach((img) => {
            const getVaultPath = (): string | null => {
                const srcAttr = img.getAttribute('src') || '';
                if (srcAttr.startsWith('data:')) return null;
                if (srcAttr.startsWith('http')) return null;

                const match = srcAttr.match(/^app:\/\/[^/]+\/(.+?)(?:\?\d+)?$/);
                if (match && match[1]) {
                    const absolutePath = decodeURIComponent(match[1]);
                    const vaultBasePath = (this.app.vault.adapter as any).basePath as string;
                    if (vaultBasePath && absolutePath.startsWith(vaultBasePath)) {
                        let relativePath = absolutePath.slice(vaultBasePath.length);
                        relativePath = relativePath.replace(/^[\/\\]+/, '');
                        return relativePath;
                    }
                    const vaultName = this.app.vault.getName();
                    const vaultNameIndex = absolutePath.lastIndexOf(vaultName);
                    if (vaultNameIndex !== -1) {
                        let relativePath = absolutePath.slice(vaultNameIndex + vaultName.length);
                        relativePath = relativePath.replace(/^[\/\\]+/, '');
                        return relativePath;
                    }
                }
                return null;
            };

            img.addEventListener('click', (e: MouseEvent) => {
                const vaultPath = getVaultPath();
                if (vaultPath) {
                    e.preventDefault();
                    e.stopPropagation();
                    const file = this.app.vault.getAbstractFileByPath(vaultPath);
                    if (file instanceof TFile) {
                        const leaf = this.app.workspace.getLeaf(false);
                        leaf.openFile(file);
                    }
                }
            });

            img.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                const vaultPath = getVaultPath();
                const srcAttr = img.getAttribute('src') || '';
                const menu = new Menu();

                menu.addItem((item) => {
                    item.setTitle(t('view.copyLink'));
                    item.onClick(async () => {
                        const textToCopy = vaultPath || srcAttr;
                        await navigator.clipboard.writeText(textToCopy);
                    });
                });

                if (vaultPath) {
                    const file = this.app.vault.getAbstractFileByPath(vaultPath);
                    if (file instanceof TFile) {
                        menu.addItem((item) => {
                            item.setTitle(t('view.revealInExplorer'));
                            item.onClick(() => {
                revealInNavigation(this.app, file);
                            });
                        });
                    }
                }

                if (srcAttr.startsWith('http')) {
                    menu.addItem((item) => {
                        item.setTitle(t('view.openInBrowser'));
                        item.onClick(() => {
                            window.open(srcAttr, '_blank');
                        });
                    });
                }

                menu.showAtPosition({ x: e.clientX, y: e.clientY });
            });

            img.addClass('session-image-clickable');
        });
    }

    private attachLinkContextMenu(container: HTMLElement): void {
        const links = container.querySelectorAll('a');
        links.forEach((link) => {
            const hrefAttr = link.getAttribute('href') || '';

            const resolveVaultFile = (): TFile | null => {
                if (!hrefAttr) return null;

                if (hrefAttr.startsWith('app://')) {
                    const match = hrefAttr.match(/^app:\/\/[^/]+\/(.+?)(?:\?\d+)?$/);
                    if (match && match[1]) {
                        const absolutePath = decodeURIComponent(match[1]);
                        const vaultBasePath = (this.app.vault.adapter as any).basePath as string;
                        if (vaultBasePath && absolutePath.startsWith(vaultBasePath)) {
                            let relativePath = absolutePath.slice(vaultBasePath.length);
                            relativePath = relativePath.replace(/^[\/\\]+/, '');
                            const file = this.app.vault.getAbstractFileByPath(relativePath);
                            if (file instanceof TFile) return file;
                        }
                        const vaultName = this.app.vault.getName();
                        const vaultNameIndex = absolutePath.lastIndexOf(vaultName);
                        if (vaultNameIndex !== -1) {
                            let relativePath = absolutePath.slice(vaultNameIndex + vaultName.length);
                            relativePath = relativePath.replace(/^[\/\\]+/, '');
                            const file = this.app.vault.getAbstractFileByPath(relativePath);
                            if (file instanceof TFile) return file;
                        }
                    }
                    return null;
                }

                if (!hrefAttr.includes('://') && !hrefAttr.startsWith('#')) {
                    let pathToTry = hrefAttr;
                    if (!pathToTry.includes('.')) {
                        pathToTry = pathToTry + '.md';
                    }
                    const file = this.app.vault.getAbstractFileByPath(pathToTry);
                    if (file instanceof TFile) return file;

                    const fileNoExt = this.app.vault.getAbstractFileByPath(hrefAttr);
                    if (fileNoExt instanceof TFile) return fileNoExt;
                }

                return null;
            };

            const isExternalLink = hrefAttr.startsWith('http://') || hrefAttr.startsWith('https://');
            const vaultFile = resolveVaultFile();
            const isInternalLink = vaultFile !== null;

            if (isInternalLink && vaultFile) {
                // Add hover preview
                link.addEventListener('mouseenter', (evt) => {
                    this.app.workspace.trigger('hover-link', {
                        event: evt,
                        source: 'ai-assistant',
                        hoverParent: container,
                        targetEl: link,
                        linktext: vaultFile.path,
                    });
                });

                link.addEventListener('click', (e: MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.openFile(vaultFile);
                });
            }

            link.addEventListener('contextmenu', (e: MouseEvent) => {
                e.preventDefault();
                const menu = new Menu();

                if (isInternalLink && vaultFile) {
                    menu.addItem((item) => {
                        item.setTitle(t('view.openNoteInNewTab'));
                        item.onClick(() => {
                            const leaf = this.app.workspace.getLeaf('tab');
                            leaf.openFile(vaultFile);
                        });
                    });
                } else if (isExternalLink) {
                    menu.addItem((item) => {
                        item.setTitle(t('view.openInBrowser'));
                        item.onClick(() => {
                            this.app.workspace.openLinkText(hrefAttr, '', false);
                        });
                    });

                    menu.addItem((item) => {
                        item.setTitle(t('view.openInSystemBrowser'));
                        item.onClick(() => {
                            window.open(hrefAttr, '_blank');
                        });
                    });
                }

                menu.addItem((item) => {
                    item.setTitle(t('view.copyLink'));
                    item.onClick(async () => {
                        await navigator.clipboard.writeText(hrefAttr);
                    });
                });

                menu.showAtPosition({ x: e.clientX, y: e.clientY });
            });

            link.addClass('session-link-clickable');
        });
    }

    onunload(): void {
        this.cancelSpeech();
        this.disposeAllControllers();
    }
}
