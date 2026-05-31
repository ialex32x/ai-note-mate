import { setIcon } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { renderDelegateTaskActionBar } from './action-bar';
import { renderCollapsibleCodeBlock } from './collapsible-code-block';

/**
 * Sub-agent presentation helpers.
 *
 * Sub-agent bubbles (and the `delegate_task` handoff bubble produced by the
 * main agent) share the same visual vocabulary: a colored badge with an
 * icon + human-readable label. This module centralises that vocabulary so
 * the bubble renderer and the delegate-task bubble stay in lockstep.
 *
 * The functions here are intentionally framework-free: no `BubbleContext`,
 * no renderer state — just DOM mutation driven by the agent name. That
 * keeps them trivially reusable if a third surface ever needs to render a
 * sub-agent badge.
 */

/** Return a human-readable label for a sub-agent (e.g. `vault_inspector` → "Vault Reader"). */
export function getSubAgentLabel(agentName: string): string {
    switch (agentName) {
        case 'vault_inspector': return 'Vault Reader';
        case 'vault_editor': return 'Vault Editor';
        case 'web': return 'Web';
        case 'code': return 'Code';
        default: return agentName;
    }
}

/**
 * Whether a bubble should show the generic role label (e.g. "AI").
 * Sub-agent-origin messages and the `delegate_task` handoff bubble already
 * identify the speaker via the agent badge, so the role line is redundant.
 */
export function shouldShowRoleLabel(msg: ChatMessage): boolean {
    // Sub-agent tool_call messages show the role label with the sub-agent
    // name appended (e.g. "Tools (Vault Reader)"), so we allow them through.
    if (msg.subAgent && msg.role !== 'tool_call') return false;
    if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'delegate_task') {
        return false;
    }
    return true;
}

/** Return the Lucide icon name used to visually identify a sub-agent. */
export function getSubAgentIcon(agentName: string): string {
    switch (agentName) {
        case 'vault_inspector': return 'vault';
        case 'vault_editor': return 'pencil';
        case 'web': return 'globe';
        case 'code': return 'code';
        default: return 'bot';
    }
}

/**
 * Render a sub-agent identification badge (icon + label) into the given
 * parent. Used both by regular sub-agent bubbles and the `delegate_task`
 * bubble (where the badge represents the handoff target).
 */
export function renderSubAgentBadge(parent: HTMLElement, agentName: string): void {
    const badge = parent.createEl('span', {
        cls: `session-bubble__subagent-badge session-bubble__subagent-badge--${agentName}`,
    });
    const badgeIcon = badge.createEl('span', { cls: 'session-bubble__subagent-badge-icon' });
    setIcon(badgeIcon, getSubAgentIcon(agentName));
    badge.createEl('span', {
        cls: 'session-bubble__subagent-badge-text',
        text: getSubAgentLabel(agentName),
    });
}

/**
 * Render a `delegate_task` tool-call as a plain conversational bubble.
 *
 * Visual treatment: target sub-agent badge + the task text as bubble
 * content. The tool result and any internal tool-call
 * progress are intentionally omitted — the sub-agent's own replies and
 * tool bubbles (rendered as sibling messages) already convey that
 * information, so duplicating it here would only add clutter.
 *
 * If the main agent passed a `handoff` seed to `delegate_task`, it is
 * rendered as a collapsible JSON block beneath the task text. The block
 * defaults to collapsed because the seed is supplementary information
 * (the task prose already references its entries by key); users who
 * want to inspect the literal payload can toggle it open.
 *
 * The lookup falls back to the legacy `exchange` and (even older)
 * `inputs` keys so messages persisted before the rename chain
 * (`inputs` → `exchange` → `handoff`) still render their seed block.
 */
export function renderDelegateTaskBubble(bubble: HTMLElement, msg: ChatMessage): void {
    bubble.addClass('session-bubble--delegate-task');
    const agentName = (msg.toolCallMeta?.toolArgs?.['agent'] as string | undefined) ?? 'agent';
    const taskText = (msg.toolCallMeta?.toolArgs?.['task'] as string | undefined) ?? '';
    const handoffSeed = msg.toolCallMeta?.toolArgs?.['handoff']
        ?? msg.toolCallMeta?.toolArgs?.['exchange']
        ?? msg.toolCallMeta?.toolArgs?.['inputs'];

    // Agent badge (same visual treatment as sub-agent bubbles so the
    // "main agent → sub-agent" handoff reads naturally).
    renderSubAgentBadge(bubble, agentName);

    // Content: render the task text as plain text (no tool-detail chrome).
    const contentEl = bubble.createEl('div', { cls: 'session-bubble__content' });
    if (taskText) {
        contentEl.createEl('div', {
            cls: 'session-bubble__delegate-task-text',
            text: taskText,
        });
        renderDelegateTaskActionBar(bubble, taskText);
    }

    // Handoff seed: only render when we actually have a non-empty plain object.
    if (isNonEmptyPlainObject(handoffSeed)) {
        renderDelegateInputsCollapsible(bubble, handoffSeed);
    }

    // No per-bubble streaming cursor: the single trailing `…` loader at
    // the tail of the message list is the global "AI is working" cue.
}

/**
 * Type guard for "the kind of value we want to render as a JSON
 * handoff-seed block": a non-null, non-array object with at least
 * one own key.
 */
function isNonEmptyPlainObject(v: unknown): v is Record<string, unknown> {
    if (v === null || v === undefined) return false;
    if (typeof v !== 'object') return false;
    if (Array.isArray(v)) return false;
    return Object.keys(v as Record<string, unknown>).length > 0;
}

/**
 * Render the collapsible block that shows the handoff seed.
 *
 * Now uses the unified `renderCollapsibleCodeBlock` component — same
 * arrow toggle, keyboard support, and copy button as every other
 * collapsible code block in the plugin.
 *
 * The persisted-expand state is keyed independently
 * (`data-delegate-inputs-expanded`) so toggling one collapsible does not
 * affect the other.
 */
function renderDelegateInputsCollapsible(
    bubble: HTMLElement,
    seed: Record<string, unknown>,
): void {
    const previouslyExpanded = bubble.dataset['delegateInputsExpanded'] === '1';

    let json: string;
    try {
        json = JSON.stringify(seed, null, 2);
    } catch {
        json = '<unrenderable handoff seed>';
    }

    const collapsible = renderCollapsibleCodeBlock(bubble, {
        label: 'Arguments',
        code: json,
        initiallyExpanded: previouslyExpanded,
        persistKey: 'delegate-inputs',
        persistHost: bubble,
        copyLabel: t('view.copyHandoffArgs'),
    });

    // Mirror the old margin-top on the wrapper
    collapsible.wrapper.addClass('collapsible-block--spaced-top');
}
