import type { ChatMessage } from '../../services/chat-stream';
import type { BubbleContext } from './bubble-context';
import {
    createActionsContainer,
    addIconAction,
    type IconActionOptions,
    ACTION_BTN_CLS,
} from './action-bar';
import { getSubAgentLabel } from './sub-agent';
import { renderThinkingSection } from './thinking-section';
import { renderToolCallContent } from './tool-call';
import { renderUserContent } from './user-content';
import { renderCollapsibleCodeBlock } from './collapsible-code-block';
import { createCopyButton } from '../../utils/copy-button';
import { SpeechController } from './speech-controller';
import { stripStructuredBlock } from '../../services/suggestions';
import { t } from '../../i18n';

// ── Re-export for callers that construct these class strings ──────────
export const BUBBLE_BASE_CLS = 'session-bubble';
export const BUBBLE_BODY_CLS = 'session-bubble__body';
export const BUBBLE_CONTENT_CLS = 'session-bubble__content';
export const BUBBLE_ROLE_CLS = 'session-bubble__role';
export const BUBBLE_HIDDEN_CLS = 'session-bubble--hidden';
export const BUBBLE_HIGHLIGHT_CLS = 'session-bubble--highlight';

// ── Bubble component options ──────────────────────────────────────────

export interface ChatBubbleOptions {
    /** Preserve the thinking section's previous expanded state across re-renders. */
    wasThinkingExpanded?: boolean;
    /** Preserve the tool detail section's previous expanded state across re-renders. */
    wasToolDetailExpanded?: boolean;
    /** Message IDs that were aborted mid-stream. */
    abortedMessageIds?: Set<string>;
    /** Map of messageId → resolver for pending tool confirmations. */
    pendingConfirmations?: Map<string, (approved: boolean) => void>;
    /** Whether the runtime is actively streaming. */
    isBusy?: boolean;
    /** Shared speech controller (single instance across all assistant bubbles). */
    speechController?: SpeechController;
    /** Error bubble: optional "continue" handler. */
    onContinue?: () => void;
    /** User message: edit handler. */
    onEdit?: (msg: ChatMessage) => void;
    /** User message: branch handler. */
    onBranch?: (msg: ChatMessage) => void;
    /** Jump navigation: scroll to previous user message. */
    onJumpToPrevUser?: (msg: ChatMessage) => void;
    /** Jump navigation: scroll to next user message. */
    onJumpToNextUser?: (msg: ChatMessage) => void;
    /** Whether this message has a previous user message to jump to (ID-based, not DOM). */
    canJumpToPrevUser?: (msg: ChatMessage) => boolean;
    /** Whether this message has a next user message to jump to (ID-based, not DOM). */
    canJumpToNextUser?: (msg: ChatMessage) => boolean;
    /** Host callback for insight extraction (assistant bubbles). */
    onExtractInsights?: (msg: ChatMessage) => void;
}

// ── Role label lookup ─────────────────────────────────────────────────

function getDefaultRoleLabel(role: ChatMessage['role']): string {
    switch (role) {
        case 'user': return t('view.roleYou');
        case 'assistant': return t('view.roleAI');
        case 'tool_call': return t('view.roleTool');
        case 'tool_result': return t('view.roleResult');
        default: return '';
    }
}

// ── CSS class computation ─────────────────────────────────────────────

/**
 * Compute the full CSS class string for a bubble given its ChatMessage.
 * This is the **single source of truth** for bubble class computation —
 * no other module should duplicate this logic.
 */
export function computeBubbleClasses(msg: ChatMessage): string {
    const parts = [BUBBLE_BASE_CLS, `${BUBBLE_BASE_CLS}--${msg.role}`];

    if (msg.role === 'tool_call' && msg.toolCallResult) {
        parts.push(`${BUBBLE_BASE_CLS}--tool-${msg.toolCallResult.status}`);
    }

    if (msg.subAgent) {
        parts.push(`${BUBBLE_BASE_CLS}--subagent`);
        parts.push(`${BUBBLE_BASE_CLS}--subagent-${msg.subAgent.agentName}`);
    }

    if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'delegate_task') {
        parts.push(`${BUBBLE_BASE_CLS}--delegate-task`);
    }

    return parts.join(' ');
}

// ── Main ChatBubble component ─────────────────────────────────────────

/**
 * Unified chat bubble component.
 *
 * All chat bubbles — user, assistant, tool_call, tool_result, system,
 * error, delegate_task — are rendered through this single component.
 *
 * ## Design
 *
 * - **Model**: {@link ChatMessage} — the data shape understood by every caller.
 * - **View**: DOM structure (role label, body wrapper, content sections, action bar).
 * - **Control**: event handlers, collapsible toggles, tool confirmations, copy, speech.
 *
 * Callers only pass the model + a dependency context; the bubble handles
 * everything else. No other module should duplicate bubble DOM creation.
 */
export class ChatBubble {
    /**
     * Create a new detached bubble element.
     *
     * The returned element is fully rendered and ready to be inserted into
     * the message list. Its internal state (collapsible sections, event
     * listeners) is self-contained and does not leak.
     */
    static create(
        ctx: BubbleContext,
        msg: ChatMessage,
        opts: ChatBubbleOptions = {},
    ): HTMLElement {
        const bubble = createEl('div', { cls: computeBubbleClasses(msg) });
        ChatBubble.renderIntoBubble(bubble, ctx, msg, opts);
        return bubble;
    }

    /**
     * Create a bubble and append it as a child of `parentEl`.
     *
     * Convenience wrapper around {@link create} — preferred when the
     * caller already has a parent element at hand (e.g. during streaming
     * appends inside the auto-follow envelope).
     */
    static createIn(
        parentEl: HTMLElement,
        ctx: BubbleContext,
        msg: ChatMessage,
        opts: ChatBubbleOptions = {},
    ): HTMLElement {
        const bubble = parentEl.createEl('div', { cls: computeBubbleClasses(msg) });
        ChatBubble.renderIntoBubble(bubble, ctx, msg, opts);
        return bubble;
    }

    /**
     * Re-render message content into an existing bubble element.
     *
     * Clears the bubble and rebuilds its internal DOM. Used for
     * non-streaming updates (history loads, tool-result arrivals,
     * abort state changes, etc.).
     *
     * State preservation (thinking/tool-detail expanded states) is
     * handled by the caller passing {@link ChatBubbleOptions} — the
     * bubble component itself is stateless for these toggles.
     */
    static renderInto(
        bubble: HTMLElement,
        ctx: BubbleContext,
        msg: ChatMessage,
        opts: ChatBubbleOptions = {},
    ): void {
        // Update class list to reflect current message state
        bubble.className = computeBubbleClasses(msg);

        // Clear and rebuild
        bubble.empty();
        ChatBubble.renderIntoBubble(bubble, ctx, msg, opts);
    }

    // ── Internal rendering ──────────────────────────────────────────

    /**
     * Core rendering logic (used by both `create` and `renderInto`).
     * Assumes the bubble element already has correct CSS classes.
     * Appends role label, body wrapper, content, and action bar as
     * children of the given `bubble` element.
     */
    private static renderIntoBubble(
        bubble: HTMLElement,
        ctx: BubbleContext,
        msg: ChatMessage,
        opts: ChatBubbleOptions,
    ): void {
        const {
            wasThinkingExpanded = false,
            wasToolDetailExpanded = false,
            abortedMessageIds = new Set(),
            pendingConfirmations = new Map<string, (approved: boolean) => void>(),
            isBusy = false,
            speechController,
            onEdit,
            onBranch,
            onJumpToPrevUser,
            onJumpToNextUser,
            onExtractInsights,
            canJumpToPrevUser,
            canJumpToNextUser,
        } = opts;

        // ── System message (special layout: no body wrapper) ──────────
        if (msg.role === 'system' && msg.content === 'aborted') {
            const bodyEl = bubble.createEl('div', { cls: BUBBLE_BODY_CLS });
            const divider = bodyEl.createEl('div', { cls: 'session-bubble__abort-divider' });
            divider.createEl('span', { cls: 'session-bubble__abort-text', text: t('view.responseAborted') });
            return;
        }

        if (msg.role === 'system') {
            ChatBubble.renderRole(bubble, 'System');
            const bodyEl = bubble.createEl('div', { cls: BUBBLE_BODY_CLS });
            const contentEl = bodyEl.createEl('div', { cls: BUBBLE_CONTENT_CLS });
            contentEl.setText(msg.content);
            return;
        }

        // ── Hidden bubbles (manage_todos, empty sub-agent) ────────────
        if (
            msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'manage_todos'
        ) {
            bubble.addClass(BUBBLE_HIDDEN_CLS);
            return;
        }

        // ── Render role label ─────────────────────────────────────────
        const showRole = ChatBubble.shouldRenderRole(msg);
        if (showRole) {
            const roleText = ChatBubble.resolveRoleLabel(msg);
            ChatBubble.renderRole(bubble, roleText);
        }

        // ── Body wrapper (background box) ─────────────────────────────
        const bodyEl = bubble.createEl('div', { cls: BUBBLE_BODY_CLS });

        // ── Thinking section ─────────────────────────────────────────
        if (msg.role === 'assistant' && msg.thinkingContent) {
            const thinkingComplete = msg.thinkingComplete === true || msg.streaming === false;
            renderThinkingSection(bodyEl, msg.thinkingContent, thinkingComplete, wasThinkingExpanded);
        }

        // ── Content area ──────────────────────────────────────────────
        const contentEl = bodyEl.createEl('div', { cls: BUBBLE_CONTENT_CLS });

        switch (msg.role) {
            case 'tool_call':
                if (msg.toolCallMeta?.toolName === 'delegate_task') {
                    renderDelegateTaskContent(contentEl, msg);
                } else {
                    renderToolCallContent(ctx, contentEl, msg, wasToolDetailExpanded, pendingConfirmations);
                }
                break;
            case 'assistant':
                // Content is filled by the caller via streaming controller
                // or markdown final render — the bubble just creates the
                // content container here.
                break;
            case 'user':
                renderUserContent(ctx, contentEl, msg.content);
                break;
            case 'tool_result':
                contentEl.setText(msg.content);
                break;
            default:
                contentEl.setText(msg.content);
                break;
        }

        // ── Action bar (always inside the bubble — same position for all types) ──
        ChatBubble.renderToolbar(bubble, ctx, msg, {
            abortedMessageIds,
            speechController,
            onExtractInsights,
            isBusy,
            onJumpToPrevUser,
            onJumpToNextUser,
            onEdit,
            onBranch,
            canJumpToPrevUser,
            canJumpToNextUser,
        });

        ctx.onScrollNeeded();
    }

    // ── Toolbar (single source of truth for all bubble types) ─────────

    /**
     * Build a flat list of action definitions based on the message context.
     * External callers do NOT decide which buttons appear — ChatBubble owns
     * that decision based on the message model.
     */
    private static buildToolbarActions(
        bubble: HTMLElement,
        msg: ChatMessage,
        opts: Pick<
            ChatBubbleOptions,
            'abortedMessageIds' | 'onExtractInsights'
            | 'isBusy' | 'onJumpToPrevUser' | 'onJumpToNextUser'
            | 'onEdit' | 'canJumpToPrevUser' | 'canJumpToNextUser'
        >,
    ): IconActionOptions[] {
        const {
            abortedMessageIds = new Set(),
            onExtractInsights,
            isBusy = false,
            onJumpToPrevUser,
            onJumpToNextUser,
            onEdit,
            canJumpToPrevUser,
            canJumpToNextUser,
        } = opts;

        const defs: IconActionOptions[] = [];

        switch (msg.role) {
            case 'user': {
                if (onJumpToPrevUser && canJumpToPrevUser?.(msg)) {
                    defs.push({ icon: 'arrow-up', label: t('view.jumpToPrevUser'), onClick: () => onJumpToPrevUser(msg) });
                }
                if (onJumpToNextUser && canJumpToNextUser?.(msg)) {
                    defs.push({ icon: 'arrow-down', label: t('view.jumpToNextUser'), onClick: () => onJumpToNextUser(msg) });
                }
                if (onEdit) {
                    defs.push({ icon: 'pencil', label: t('view.editMessage'), onClick: (e) => { e.preventDefault(); onEdit(msg); } });
                }
                // Copy button handled separately (not an icon action)
                break;
            }
            case 'assistant': {
                if (onJumpToPrevUser && canJumpToPrevUser?.(msg)) {
                    defs.push({ icon: 'arrow-up', label: t('view.jumpToPrevUser'), onClick: () => onJumpToPrevUser(msg) });
                }
                if (onJumpToNextUser && canJumpToNextUser?.(msg)) {
                    defs.push({ icon: 'arrow-down', label: t('view.jumpToNextUser'), onClick: () => onJumpToNextUser(msg) });
                }
                // Copy button handled separately
                if (onExtractInsights && !abortedMessageIds.has(msg.id) && !isBusy) {
                    defs.push({ icon: 'lightbulb', label: t('view.extractInsights'), onClick: () => onExtractInsights(msg) });
                }
                break;
            }
            case 'tool_call': {
                if (onJumpToPrevUser && canJumpToPrevUser?.(msg)) {
                    defs.push({ icon: 'arrow-up', label: t('view.jumpToPrevUser'), onClick: () => onJumpToPrevUser(msg) });
                }
                if (onJumpToNextUser && canJumpToNextUser?.(msg)) {
                    defs.push({ icon: 'arrow-down', label: t('view.jumpToNextUser'), onClick: () => onJumpToNextUser(msg) });
                }
                // Copy button handled separately
                break;
            }
        }

        return defs;
    }

    private static renderToolbar(
        bubble: HTMLElement,
        ctx: BubbleContext,
        msg: ChatMessage,
        opts: Pick<
            ChatBubbleOptions,
            'abortedMessageIds' | 'speechController' | 'onExtractInsights'
            | 'isBusy' | 'onJumpToPrevUser' | 'onJumpToNextUser'
            | 'onEdit' | 'onBranch' | 'canJumpToPrevUser' | 'canJumpToNextUser'
        >,
    ): void {
        const {
            abortedMessageIds = new Set(),
            speechController,
            onBranch,
        } = opts;

        const actions = createActionsContainer(bubble);

        // 1. Render standard icon actions (purely data-driven)
        const defs = ChatBubble.buildToolbarActions(bubble, msg, opts);
        for (const def of defs) {
            addIconAction(actions, def);
        }

        // 2. Copy button (every non-system bubble gets one)
        if (msg.role !== 'system') {
            const copyText = msg.role === 'tool_call'
                ? () => {
                    if (msg.toolCallMeta?.toolName === 'delegate_task') {
                        return (msg.toolCallMeta?.toolArgs?.['task'] as string | undefined) ?? msg.content;
                    }
                    const parts: string[] = [];
                    if (msg.toolCallMeta?.toolName) {
                        parts.push('toolName: ' + msg.toolCallMeta.toolName);
                    }
                    if (msg.toolCallMeta?.toolArgs && Object.keys(msg.toolCallMeta.toolArgs).length > 0) {
                        parts.push('toolArgs: ' + JSON.stringify(msg.toolCallMeta.toolArgs, null, 2));
                    }
                    if (msg.toolCallResult?.result) {
                        parts.push('result: ' + msg.toolCallResult.result);
                    }
                    return parts.length > 0 ? parts.join('\n') : msg.content;
                  }
                : () => stripStructuredBlock(msg.content);
            const copyCls = msg.role === 'tool_call' && msg.toolCallMeta?.toolName !== 'delegate_task'
                ? 'session-bubble__action-btn'
                : ACTION_BTN_CLS;
            const copyBtn = createCopyButton(t('common.copy'), copyText, copyCls);
            actions.appendChild(copyBtn);
        }

        // 3. User branch button (rendered after copy, same as before)
        if (msg.role === 'user' && onBranch) {
            addIconAction(actions, {
                icon: 'git-branch',
                label: t('view.branchFromHere'),
                onClick: (e) => { e.preventDefault(); onBranch(msg); },
            });
        }

        // 4. Speech controls (stateful — owned by SpeechController)
        if (msg.role === 'assistant' && msg.content.trim() && speechController && SpeechController.isSupported()) {
            speechController.renderSpeakButtonGroup(actions, msg.content);
        }

        // 5. Aborted indicator (text span, not a button)
        if (abortedMessageIds.has(msg.id)) {
            actions.createEl('span', {
                cls: 'session-bubble__abort-label',
                text: t('view.responseStopped'),
            });
        }
    }

    // ── Role label helpers ──────────────────────────────────────────

    /** Whether to show a role label above the body wrapper. */
    private static shouldRenderRole(_msg: ChatMessage): boolean {
        return true;
    }

    /** Resolve the display text for the role label. */
    private static resolveRoleLabel(msg: ChatMessage): string {
        // Sub-agent messages show the agent name
        if (msg.subAgent) {
            return getSubAgentLabel(msg.subAgent.agentName);
        }
        // delegate_task shows the target agent name
        if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'delegate_task') {
            const agentName = (msg.toolCallMeta.toolArgs?.['agent'] as string | undefined) ?? 'agent';
            return getSubAgentLabel(agentName);
        }
        if (msg.role === 'tool_call') {
            return t('view.roleTool');
        }
        return getDefaultRoleLabel(msg.role);
    }

    /** Append the role label element. */
    private static renderRole(bubble: HTMLElement, text: string): void {
        bubble.createEl('span', { cls: BUBBLE_ROLE_CLS, text });
    }

}

// ── Delegate-task content (inline — only content area differs) ────────

/**
 * Render delegate_task content inline — uses the SAME DOM structure
 * (inside `.session-bubble__body > .session-bubble__content`) as all
 * other bubble types. The only difference is what goes in the content
 * area: task text + optional handoff seed collapsible.
 */
function renderDelegateTaskContent(contentEl: HTMLElement, msg: ChatMessage): void {
    const taskText = (msg.toolCallMeta?.toolArgs?.['task'] as string | undefined) ?? '';
    const handoffSeed = msg.toolCallMeta?.toolArgs?.['handoff']
        ?? msg.toolCallMeta?.toolArgs?.['exchange']
        ?? msg.toolCallMeta?.toolArgs?.['inputs'];

    if (taskText) {
        contentEl.createEl('div', {
            cls: 'session-bubble__delegate-task-text',
            text: taskText,
        });
    }

    // Handoff seed: only render when we have a non-empty plain object.
    if (isNonEmptyPlainObject(handoffSeed)) {
        let json: string;
        try {
            json = JSON.stringify(handoffSeed, null, 2);
        } catch {
            json = '<unrenderable handoff seed>';
        }
        const collapsible = renderCollapsibleCodeBlock(contentEl, {
            label: 'Arguments',
            code: json,
            initiallyExpanded: false,
            copyLabel: t('view.copyHandoffArgs'),
        });
        collapsible.wrapper.addClass('collapsible-block--spaced-top');
    }
}

function isNonEmptyPlainObject(v: unknown): v is Record<string, unknown> {
    if (v === null || v === undefined) return false;
    if (typeof v !== 'object') return false;
    if (Array.isArray(v)) return false;
    return Object.keys(v as Record<string, unknown>).length > 0;
}


