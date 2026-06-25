import { setIcon, setTooltip } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';

/**
 * Default class string applied to every assistant / user action-bar
 * icon button. Kept as a constant rather than inlined so the action-bar
 * helpers and any external callers (error bubble, future bubble variants)
 * can opt in to the same baseline visual without copy-pasting the class
 * list — and so a single edit here updates every action button at once.
 */
const ICON_ACTION_BTN_CLS = 'session-icon-btn session-bubble__action-btn';

/**
 * Whether a message should be treated as interrupted ("Response stopped").
 *
 * True when either:
 *  - it was aborted live in this session (tracked in `abortedMessageIds`), or
 *  - it carries the persisted {@link ChatMessage.wasInterrupted} flag.
 *
 * The persisted flag is the authoritative signal that survives a reload and
 * also covers cases the runtime set never captured: thinking-only aborts
 * (empty content) and stream errors. Deriving the UI state from both keeps the
 * "stopped" label, insights gating, and follow-up suppression consistent across
 * live aborts, error paths, and reloaded sessions.
 */
export function isMessageInterrupted(
    msg: ChatMessage,
    abortedMessageIds: Set<string>,
): boolean {
    return msg.wasInterrupted === true || abortedMessageIds.has(msg.id);
}

/** Options for {@link addIconAction}. */
export interface IconActionOptions {
    /** Lucide icon name (e.g. 'pencil', 'git-branch'). */
    icon: string;
    /** Localised label used as both `aria-label` and tooltip. */
    label: string;
    /** Click handler. The event is already `stopPropagation()`'d for you. */
    onClick: (e: MouseEvent) => void;
    /**
     * Override the default icon-button class. Used by callers (e.g. the
     * error bubble) that need a different button family than the standard
     * assistant / user action bar.
     */
    cls?: string;
    /**
     * Extra class(es) appended after `cls`. Useful for adding modifier
     * classes such as `session-bubble__action-btn--primary` without having
     * to repeat the base class list.
     */
    extraCls?: string;
    /**
     * Optional `data-action` attribute value. Enables stable DOM selection
     * of specific action buttons regardless of localised aria-label text.
     * For example, `"quick-ask"` → `[data-action="quick-ask"]`.
     */
    dataAction?: string;
}

/**
 * Append a single icon action button to an actions row.
 *
 * Centralises the otherwise-repeated `createEl + setIcon + setTooltip +
 * addEventListener` ritual used by every action-bar variant in the project
 * (user, assistant, error bubble). Returns the element so callers can
 * keep a reference for later detachment (the error bubble's continue
 * button leans on this).
 */
export function addIconAction(
    actions: HTMLElement,
    opts: IconActionOptions,
): HTMLButtonElement {
    const cls = opts.cls ?? ICON_ACTION_BTN_CLS;
    const finalCls = opts.extraCls ? `${cls} ${opts.extraCls}` : cls;
    const attrs: Record<string, string> = {
        'aria-label': opts.label,
        type: 'button',
    };
    if (opts.dataAction) {
        attrs['data-action'] = opts.dataAction;
    }
    const btn = actions.createEl('button', {
        cls: finalCls,
        attr: attrs,
    });
    setIcon(btn, opts.icon);
    setTooltip(btn, opts.label);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onClick(e);
    });
    return btn;
}

/**
 * Create the standard `<div class="session-bubble__actions">` container
 * inside a bubble. Extracted so action-bar variants share a single
 * source of truth for the container class — keeps the CSS hover-reveal
 * selector working uniformly.
 */
export function createActionsContainer(bubble: HTMLElement): HTMLElement {
    return bubble.createEl('div', { cls: 'session-bubble__actions' });
}

/** Class shared by all default icon-action buttons; exported for callers
 *  that need it on a non-button element (e.g. when creating a copy button
 *  via {@link createCopyButton}, which builds its own element). */
export const ACTION_BTN_CLS = ICON_ACTION_BTN_CLS;
