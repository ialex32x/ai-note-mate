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

/** Return a human-readable label for a sub-agent (e.g. `vault_inspector` → "Vault Inspector"). */
export function getSubAgentLabel(agentName: string): string {
    switch (agentName) {
        case 'vault_inspector': return t('view.subAgentVaultInspector');
        case 'web': return t('view.subAgentWeb');
        case 'code': return t('view.subAgentCode');
        default: return agentName;
    }
}

/** Return the Lucide icon name used to visually identify a sub-agent. */
export function getSubAgentIcon(agentName: string): string {
    switch (agentName) {
        case 'vault_inspector': return 'vault';
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
 *
 * If the main agent passed structured `inputs` to `delegate_task`, they
 * are rendered as a collapsible JSON block beneath the task text. The
 * block defaults to collapsed because `inputs` is supplementary
 * information (the task prose already references it by key); users who
 * want to inspect the literal payload can toggle it open.
 */
export function renderDelegateTaskBubble(bubble: HTMLElement, msg: ChatMessage): void {
    const agentName = (msg.toolCallMeta?.toolArgs?.['agent'] as string | undefined) ?? 'agent';
    const taskText = (msg.toolCallMeta?.toolArgs?.['task'] as string | undefined) ?? '';
    const inputs = msg.toolCallMeta?.toolArgs?.['inputs'];

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

    // Inputs: only render when we actually have a non-empty plain object.
    // - undefined / null → nothing to show
    // - non-object (string, array, etc.) → defensive skip; the orchestrator
    //   already rejects these before dispatch, so reaching this branch
    //   means a stale persisted message; rendering would just be confusing
    // - empty object `{}` → a "0 keys" toggle adds noise without value
    if (isNonEmptyPlainObject(inputs)) {
        renderDelegateInputsCollapsible(bubble, inputs);
    }

    // No per-bubble streaming cursor: the single trailing `…` loader at
    // the tail of the message list is the global "AI is working" cue.
}

/**
 * Type guard for "the kind of value we want to render as a JSON inputs
 * block": a non-null, non-array object with at least one own key.
 *
 * Mirrors (loosely) `buildInitialStore`'s validation so the UI only
 * renders shapes the orchestrator would also accept; arrays / class
 * instances are skipped silently rather than rendered as malformed JSON.
 */
function isNonEmptyPlainObject(v: unknown): v is Record<string, unknown> {
    if (v === null || v === undefined) return false;
    if (typeof v !== 'object') return false;
    if (Array.isArray(v)) return false;
    return Object.keys(v as Record<string, unknown>).length > 0;
}

/**
 * Render the collapsible `inputs` block.
 *
 * Reuses the visual vocabulary of `wrapInSubAgentCollapsible` (same arrow
 * + summary + body classes) so the two collapsibles look consistent in a
 * single bubble. The persisted-expand state is keyed independently
 * (`data-delegate-inputs-expanded`) so toggling one does not affect the
 * other.
 *
 * The body is rendered as a `<pre>` of pretty-printed JSON, NOT through
 * the markdown pipeline:
 *   - `inputs` is structured data; monospaced JSON is the most accurate
 *     visual encoding (preserves whitespace, quotes, key/value alignment).
 *   - Going through markdown would re-interpret strings (auto-links,
 *     headings starting with `#`, etc.), which would lie about what the
 *     sub-agent actually received.
 */
function renderDelegateInputsCollapsible(
    bubble: HTMLElement,
    inputs: Record<string, unknown>,
): void {
    const keyCount = Object.keys(inputs).length;
    const previouslyExpanded = bubble.dataset['delegateInputsExpanded'] === '1';

    const wrapper = bubble.createEl('div', {
        cls: previouslyExpanded
            ? 'session-bubble__delegate-inputs session-bubble__delegate-inputs--expanded'
            : 'session-bubble__delegate-inputs',
    });

    const header = wrapper.createEl('span', {
        cls: previouslyExpanded
            ? 'session-bubble__delegate-inputs-header session-bubble__delegate-inputs-header--expanded'
            : 'session-bubble__delegate-inputs-header',
        attr: {
            'aria-label': t('view.toggleDelegateInputs'),
            role: 'button',
            tabindex: '0',
        },
    });
    header.createEl('span', {
        cls: 'session-bubble__delegate-inputs-arrow',
        text: previouslyExpanded ? '▾' : '▸',
    });
    header.appendText(' ');
    header.createEl('span', {
        cls: 'session-bubble__delegate-inputs-summary',
        text: t('view.delegateInputsSummary', { count: keyCount }),
    });

    // Pretty-print body. Wrapped in `try` because while the orchestrator
    // already validated serializability before dispatch, persisted
    // messages from older sessions might (in theory) contain shapes
    // that JSON.stringify can't handle. Fall back to a short error
    // marker rather than crashing the whole bubble render.
    let json: string;
    try {
        json = JSON.stringify(inputs, null, 2);
    } catch {
        json = '<unrenderable inputs>';
    }
    const body = wrapper.createEl('pre', {
        cls: previouslyExpanded
            ? 'session-bubble__delegate-inputs-body session-bubble__delegate-inputs-body--expanded'
            : 'session-bubble__delegate-inputs-body',
        text: json,
    });

    const toggle = () => {
        const expanded = !header.hasClass('session-bubble__delegate-inputs-header--expanded');
        wrapper.toggleClass('session-bubble__delegate-inputs--expanded', expanded);
        header.toggleClass('session-bubble__delegate-inputs-header--expanded', expanded);
        body.toggleClass('session-bubble__delegate-inputs-body--expanded', expanded);
        header.querySelector('.session-bubble__delegate-inputs-arrow')!.setText(expanded ? '▾' : '▸');
        if (expanded) {
            bubble.dataset['delegateInputsExpanded'] = '1';
        } else {
            delete bubble.dataset['delegateInputsExpanded'];
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
