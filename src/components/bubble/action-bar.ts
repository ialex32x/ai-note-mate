import { setIcon, setTooltip } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { createCopyButton } from '../../utils/copy-button';
import { stripStructuredBlock } from '../../services/suggestions';
import type { BubbleContext } from './bubble-context';
import { SpeechController } from './speech-controller';

/**
 * Default class string applied to every assistant / user action-bar
 * icon button. Kept as a constant rather than inlined so the action-bar
 * helpers and any external callers (error bubble, future bubble variants)
 * can opt in to the same baseline visual without copy-pasting the class
 * list — and so a single edit here updates every action button at once.
 */
const ICON_ACTION_BTN_CLS = 'session-icon-btn session-bubble__action-btn';

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
    const btn = actions.createEl('button', {
        cls: finalCls,
        attr: {
            'aria-label': opts.label,
            type: 'button',
        },
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

/** Check whether a user bubble has a preceding user bubble (i.e. it's not the first turn). */
function hasPreviousUserBubble(bubble: HTMLElement): boolean {
    let el: Element | null = bubble.previousElementSibling;
    while (el) {
        if (el.classList.contains('session-bubble--user')) return true;
        el = el.previousElementSibling;
    }
    return false;
}

/** Check whether any user bubble follows this bubble in the DOM. */
export function hasNextUserBubble(bubble: HTMLElement): boolean {
    let el: Element | null = bubble.nextElementSibling;
    while (el) {
        if (el.classList.contains('session-bubble--user')) return true;
        el = el.nextElementSibling;
    }
    return false;
}

/**
 * Render a minimal action bar for a user message bubble.
 *
 * Provides Copy, Edit and (optionally) Branch-from-here actions — the
 * operations that were previously exposed only via right-click context menu.
 * The bar uses the same hover-driven reveal pattern as the assistant
 * action bar: hidden until the bubble is hovered.
 *
 * @param bubble    The user bubble element to append the action bar into.
 * @param msg       The user message whose content is used for copy/edit/branch.
 * @param onBranch  Optional callback invoked when "Branch from here" is
 *                  clicked. When omitted the button is not rendered.
 * @param onEdit    Optional callback invoked when "Edit message" is
 *                  clicked. When omitted the button is not rendered.
 */
export function renderUserActionBar(
    bubble: HTMLElement,
    msg: ChatMessage,
    onBranch?: (msg: ChatMessage) => void,
    onEdit?: (msg: ChatMessage) => void,
    onJumpToPrevUser?: (msg: ChatMessage) => void,
    onJumpToNextUser?: (msg: ChatMessage) => void,
): void {
    const actions = createActionsContainer(bubble);

    // Jump to previous user message — only show if a preceding user bubble exists
    if (onJumpToPrevUser && hasPreviousUserBubble(bubble)) {
        addIconAction(actions, {
            icon: 'arrow-up',
            label: t('view.jumpToUser'),
            onClick: () => onJumpToPrevUser(msg),
        });
    }

    // Jump to next user message
    if (onJumpToNextUser) {
        addIconAction(actions, {
            icon: 'arrow-down',
            label: t('view.jumpToNextUser'),
            onClick: () => onJumpToNextUser(msg),
        });
    }

    // Edit button — restores this message to the input and rolls back
    // the conversation to before this point
    if (onEdit) {
        addIconAction(actions, {
            icon: 'pencil',
            label: t('view.editMessage'),
            onClick: (e) => {
                e.preventDefault();
                onEdit(msg);
            },
        });
    }

    // Copy button — reuses createCopyButton for consistent flash-feedback
    const copyBtn = createCopyButton(
        t('common.copy'),
        () => msg.content,
        ACTION_BTN_CLS,
    );
    actions.appendChild(copyBtn);

    // Branch button — only shown when the host has wired a branch handler
    if (onBranch) {
        addIconAction(actions, {
            icon: 'git-branch',
            label: t('view.branchFromHere'),
            onClick: (e) => {
                e.preventDefault();
                onBranch(msg);
            },
        });
    }
}

/**
 * Minimal action bar for a `delegate_task` handoff bubble (task text only).
 * Mirrors the copy affordance on user / assistant bubbles; the bar is
 * externalised below the bubble by {@link BubbleRenderer.externalizeActionBar}.
 */
export function renderDelegateTaskActionBar(
    bubble: HTMLElement,
    taskText: string,
    onJumpToUser?: (msg: ChatMessage) => void,
    delegateMsg?: ChatMessage,
    onJumpToNextUser?: (msg: ChatMessage) => void,
): void {
    const actions = createActionsContainer(bubble);
    if (onJumpToUser && delegateMsg) {
        addIconAction(actions, {
            icon: 'arrow-up',
            label: t('view.jumpToUser'),
            onClick: () => onJumpToUser(delegateMsg),
        });
    }
    if (onJumpToNextUser && delegateMsg) {
        addIconAction(actions, {
            icon: 'arrow-down',
            label: t('view.jumpToNextUser'),
            onClick: () => onJumpToNextUser(delegateMsg),
        });
    }
    const copyBtn = createCopyButton(t('common.copy'), () => taskText, ACTION_BTN_CLS);
    actions.appendChild(copyBtn);
}

/**
 * Options passed alongside the shared {@link BubbleContext} when rendering
 * an assistant action bar.
 *
 * These fields are intentionally *not* part of `BubbleContext`: they are
 * specific to the action bar and have no reason to be visible to the rest
 * of the bubble sub-modules. Keeping them local avoids widening the shared
 * context surface area unnecessarily.
 */
export interface ActionBarOptions {
    /** Message IDs that were aborted mid-stream; controls the stopped label / insights gating. */
    abortedMessageIds: Set<string>;
    /**
     * Owner of the Web Speech state. The action bar asks it to mount the
     * speak + voice-picker control inline; the renderer still holds the
     * reference so it can cancel playback on unload.
     */
    speechController: SpeechController;
    /**
     * Host-provided callback to trigger a one-shot insight extraction for
     * this particular assistant message. When omitted, the insights action
     * is not rendered at all.
     */
    onExtractInsights?: (msg: ChatMessage) => void;
    /**
     * When true, the runtime is actively producing output (streaming or
     * waiting on tool calls). The insights button is suppressed during
     * this window so the user doesn't trigger an extraction while the
     * conversation is still in-flight.
     */
    isBusy?: boolean;
    /**
     * Host-provided callback to scroll to the user message that started
     * the current turn. When omitted, the jump button is not rendered.
     */
    onJumpToUser?: (msg: ChatMessage) => void;
    /**
     * Host-provided callback to scroll to the next (following) user
     * message. When omitted, the down-jump button is not rendered.
     */
    onJumpToNextUser?: (msg: ChatMessage) => void;
}

/**
 * Render the footer action bar for an assistant bubble (copy / speak /
 * extract-insights / aborted indicator).
 *
 * Kept as a plain function: there is no cross-call state worth owning —
 * the one stateful concern (TTS) already lives inside {@link SpeechController},
 * and the copy button's short-lived "✓" feedback is self-contained on the
 * element via `setTimeout`.
 */
export function renderActionBar(
    _ctx: BubbleContext,
    bubble: HTMLElement,
    msg: ChatMessage,
    opts: ActionBarOptions
): void {
    const { abortedMessageIds, speechController, onExtractInsights, onJumpToUser, onJumpToNextUser } = opts;
    const actions = createActionsContainer(bubble);

    // Jump-to-user button — scrolls to the user message that started this turn
    if (onJumpToUser) {
        addIconAction(actions, {
            icon: 'arrow-up',
            label: t('view.jumpToUser'),
            onClick: () => onJumpToUser(msg),
        });
    }

    // Jump-to-next-user button — scrolls to the following user message
    if (onJumpToNextUser && hasNextUserBubble(bubble)) {
        addIconAction(actions, {
            icon: 'arrow-down',
            label: t('view.jumpToNextUser'),
            onClick: () => onJumpToNextUser(msg),
        });
    }

    // Copy button — uses unified createCopyButton for consistent flash-feedback.
    // Strip the structured suggestions block so the copied text is clean and
    // ready to paste elsewhere without exposing the internal markup.
    const copyBtn = createCopyButton(t('common.copy'), () => stripStructuredBlock(msg.content), ACTION_BTN_CLS);
    actions.appendChild(copyBtn);

    // Speak button group
    if (SpeechController.isSupported()) {
        speechController.renderSpeakButtonGroup(actions, msg.content);
    }

    // Extract-insights button — only meaningful for non-aborted replies
    // when a host callback is wired and the runtime is not busy.
    // Mirrors Copy/Speak as a plain icon button (rather than a menu) to
    // stay consistent with the rest of the action bar and remain
    // tap-friendly on mobile.
    if (onExtractInsights && !abortedMessageIds.has(msg.id) && !opts.isBusy) {
        addIconAction(actions, {
            icon: 'lightbulb',
            label: t('view.extractInsights'),
            onClick: () => onExtractInsights(msg),
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
