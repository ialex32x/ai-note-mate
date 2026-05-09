import { setIcon } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';

/**
 * Sub-agent presentation helpers.
 *
 * Sub-agent bubbles (and the `delegate_task` handoff bubble produced by the
 * main agent) share the same visual vocabulary: a colored badge with an
 * icon + human-readable label, plus an optional collapsible wrapper around
 * the reply body. This module centralises that vocabulary so the bubble
 * renderer and the delegate-task bubble stay in lockstep.
 *
 * The functions here are intentionally framework-free: no `BubbleContext`,
 * no renderer state — just DOM mutation driven by the agent name. That
 * keeps them trivially reusable if a third surface ever needs to render a
 * sub-agent badge.
 */

/** Return a human-readable label for a sub-agent (e.g. `vault` → "Vault agent"). */
export function getSubAgentLabel(agentName: string): string {
    switch (agentName) {
        case 'vault': return t('view.subAgentVault');
        case 'web': return t('view.subAgentWeb');
        case 'code': return t('view.subAgentCode');
        default: return agentName;
    }
}

/** Return the Lucide icon name used to visually identify a sub-agent. */
export function getSubAgentIcon(agentName: string): string {
    switch (agentName) {
        case 'vault': return 'vault';
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
 * Wrap a sub-agent's final assistant reply in a collapsible section.
 *
 * Default state:
 *   - First render (no previous expanded marker on bubble): collapsed
 *   - Re-render (user had manually expanded): preserve that state via the
 *     `data-sub-agent-reply-expanded` attribute on the outer bubble element
 *
 * The pre-created `contentEl` is moved inside the collapsible body rather
 * than being recreated, so upstream markdown rendering (which targets
 * `contentEl` directly) still works — only its parent changes.
 */
export function wrapInSubAgentCollapsible(
    bubble: HTMLElement,
    contentEl: HTMLElement,
    msg: ChatMessage,
): void {
    const agentName = msg.subAgent?.agentName ?? 'agent';
    const agentLabel = getSubAgentLabel(agentName);

    // Preserve the user's manual toggle across re-renders within the same
    // DOM bubble (the caller has already emptied the bubble before calling
    // render, so we check for a data attribute that survives).
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
    header.createEl('span', { cls: 'session-bubble__subagent-reply-arrow', text: arrow });
    header.appendText(' ');
    header.createEl('span', {
        cls: 'session-bubble__subagent-reply-summary',
        text: t('view.subAgentReplySummary', { agent: agentLabel }),
    });

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
 * Render a `delegate_task` tool-call as a plain conversational bubble.
 *
 * Visual treatment: target sub-agent badge + assistant role label + the
 * task text as bubble content. The tool result and any internal tool-call
 * progress are intentionally omitted — the sub-agent's own replies and
 * tool bubbles (rendered as sibling messages) already convey that
 * information, so duplicating it here would only add clutter.
 */
export function renderDelegateTaskBubble(bubble: HTMLElement, msg: ChatMessage): void {
    const agentName = (msg.toolCallMeta?.toolArgs?.['agent'] as string | undefined) ?? 'agent';
    const taskText = (msg.toolCallMeta?.toolArgs?.['task'] as string | undefined) ?? '';

    // Agent badge (same visual treatment as sub-agent bubbles so the
    // "main agent → sub-agent" handoff reads naturally).
    renderSubAgentBadge(bubble, agentName);

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
