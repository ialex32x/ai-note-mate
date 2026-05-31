import { Menu, setIcon } from 'obsidian';
import { t } from '../../i18n';
import { prettifyIfJson } from '../../utils/json-format';
import { copyToClipboard } from '../../utils/clipboard';
import { safeSliceHead } from '../../utils/string-safe';
import { addIconAction, createActionsContainer } from '../../components/bubble/action-bar';
import {
    BUBBLE_BASE_CLS,
    BUBBLE_CONTENT_CLS,
    BUBBLE_ROLE_CLS,
} from '../../components/bubble/chat-bubble';

/**
 * Class string for action buttons inside an error bubble.
 *
 * Intentionally narrower than the assistant / user bubble action buttons
 * (no `session-icon-btn`): error bubbles render inline as a notification
 * rather than as a hover-revealed toolbar, so they don't need the
 * `session-icon-btn` baseline (which carries hover-only opacity rules).
 * Kept alongside the helper invocation so the visual decision is
 * documented next to the call site.
 */
const ERROR_ACTION_BTN_CLS = 'session-bubble__action-btn';

export interface AppendErrorBubbleOptions {
    messagesEl: HTMLElement;
    /** Called after the bubble is appended so the singleton streaming loader stays pinned to tail. */
    pinStreamingLoaderToEnd: () => void;
    /** Optional auto-scroll trigger. */
    maybeScrollToBottom: () => void;
    /**
     * When provided, render an inline "continue" action that resends a
     * user prompt to resume the interrupted turn. The handler runs on
     * click; the caller is responsible for the "only the latest error
     * bubble carries this button" invariant — see {@link AppendErrorBubbleResult}.
     */
    onContinue?: () => void;
}

export interface AppendErrorBubbleResult {
    /** The bubble element appended to the message list. */
    bubble: HTMLElement;
    /**
     * The continue-button element when `onContinue` was provided, else null.
     * Callers track this reference so they can detach it the moment the
     * conversation moves past this error (i.e. any new bubble appends or
     * a fresh error replaces it). Detaching is what enforces "the button
     * appears only on the conversation-tail error bubble".
     */
    continueBtn: HTMLElement | null;
}

/**
 * Maximum number of UTF-16 code units rendered inside an error bubble.
 *
 * Some errors carry very long payloads (e.g. an unparseable tool-call
 * `arguments` blob that includes the full document being edited). Rendering
 * those verbatim makes the chat unreadable. We truncate the visible text
 * but keep the full text available via the copy button so the user can still
 * inspect the entire error if needed.
 */
const ERROR_DISPLAY_MAX_CHARS = 100;

/**
 * Append an error bubble to the message list.
 *
 * Now uses the same CSS class vocabulary as all other chat bubbles
 * (`session-bubble`, `session-bubble__role`, `session-bubble__content`)
 * so the styling stays consistent with user/assistant/tool bubbles.
 */
export function appendErrorBubble(
    message: string,
    opts: AppendErrorBubbleOptions,
): AppendErrorBubbleResult {
    const fullText = prettifyIfJson(message);
    // Surrogate-aware truncation: never split an emoji / non-BMP character
    // pair when chopping the display string.
    const truncated = fullText.length > ERROR_DISPLAY_MAX_CHARS;
    const displayText = truncated
        ? safeSliceHead(fullText, ERROR_DISPLAY_MAX_CHARS) + '…'
        : fullText;

    const bubble = opts.messagesEl.createEl('div', {
        cls: `${BUBBLE_BASE_CLS} ${BUBBLE_BASE_CLS}--error`,
    });

    // Role label — same position as "AI" / "You" labels, but with an icon
    const role = bubble.createEl('div', { cls: BUBBLE_ROLE_CLS });
    const roleIcon = role.createEl('span', { cls: 'session-bubble__error-icon' });
    setIcon(roleIcon, 'alert-triangle');
    role.createEl('span', { text: t('view.roleError') });

    // Body wrapper — same pattern as regular bubbles (background box)
    const bodyEl = bubble.createEl('div', { cls: 'session-bubble__body' });
    const content = bodyEl.createEl('div', { cls: BUBBLE_CONTENT_CLS });
    content.createEl('pre', {
        cls: 'session-bubble__error-text',
        text: displayText,
    });

    // Action bar — same position as assistant/user action bars
    const actions = createActionsContainer(bubble);

    let continueBtn: HTMLElement | null = null;
    if (opts.onContinue) {
        // Rendered before the copy button so the primary recovery
        // affordance reads first in the action row.
        const onContinue = opts.onContinue;
        continueBtn = addIconAction(actions, {
            icon: 'play',
            label: t('view.continueAfterError'),
            cls: ERROR_ACTION_BTN_CLS,
            extraCls: 'session-bubble__action-btn--primary',
            onClick: () => onContinue(),
        });
    }

    addIconAction(actions, {
        icon: 'copy',
        label: t('common.copy'),
        cls: ERROR_ACTION_BTN_CLS,
        // Always copy the full, untruncated text so the user can paste it
        // into an issue / debugger even if the bubble itself is shortened.
        onClick: () => { void copyErrorToClipboard(fullText); },
    });

    bubble.addEventListener('contextmenu', (ev: MouseEvent) => {
        ev.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => {
            item.setTitle(t('common.copy'));
            item.setIcon('copy');
            item.onClick(() => {
                void copyErrorToClipboard(fullText);
            });
        });
        menu.showAtMouseEvent(ev);
    });

    // Keep singleton streaming loader pinned to tail even when we insert
    // an error bubble via a different code path than `appendBubble`.
    opts.pinStreamingLoaderToEnd();
    opts.maybeScrollToBottom();
    // Always log the full message so it remains debuggable from the dev console.
    console.error('Error:', message);

    return { bubble, continueBtn };
}

export async function copyErrorToClipboard(text: string): Promise<void> {
    await copyToClipboard(text, { logLevel: 'warn' });
}

/**
 * Tracker that owns the "only the conversation-tail error bubble carries
 * an inline `continue` button" invariant on behalf of {@link SessionView}.
 *
 * The view used to inline this state as a `lastErrorContinueBtn` field
 * plus two private methods (`appendErrorBubble`, `clearLastErrorContinueBtn`).
 * Folding both into a tiny class here keeps the invariant — and the rules
 * for when it must be re-asserted — in a single file alongside the bubble
 * renderer that produces the button. The view just calls `append()` /
 * `clearContinueBtn()` / `forgetContinueBtn()` at the appropriate
 * lifecycle points.
 *
 * The tracker does **not** own the bubble DOM or the message list. It
 * only remembers the most recent continue-button element so it can be
 * detached when the conversation tail moves past that error.
 */
export class ErrorBubbleTracker {
    private lastContinueBtn: HTMLElement | null = null;

    constructor(private readonly opts: Omit<AppendErrorBubbleOptions, 'onContinue'> & {
        /** Optional click handler for the inline continue button. Omit to disable the affordance entirely. */
        onContinue?: () => void;
    }) {}

    /**
     * Append an error bubble. Before adding the new tail bubble, any
     * previously-tracked continue button is detached so the invariant
     * "only the latest tail error carries a continue button" is upheld
     * even momentarily.
     */
    append(message: string): void {
        this.clearContinueBtn();
        const { continueBtn } = appendErrorBubble(message, {
            messagesEl: this.opts.messagesEl,
            pinStreamingLoaderToEnd: this.opts.pinStreamingLoaderToEnd,
            maybeScrollToBottom: this.opts.maybeScrollToBottom,
            onContinue: this.opts.onContinue,
        });
        this.lastContinueBtn = continueBtn;
    }

    /**
     * Detach the inline continue button from the previous tail error
     * bubble, if any. Idempotent. The error bubble itself is preserved
     * (it remains in conversation history); only the action button is
     * removed because the conversation has moved past the error.
     */
    clearContinueBtn(): void {
        if (this.lastContinueBtn) {
            this.lastContinueBtn.remove();
            this.lastContinueBtn = null;
        }
    }

    /**
     * Drop the tracked reference without touching the DOM. Used when
     * the entire message list is about to be torn down (view close,
     * session switch, full DOM clear) — the parent has already invalidated
     * or will invalidate the DOM nodes; we just need to forget the
     * dangling pointer so the next session starts clean.
     */
    forgetContinueBtn(): void {
        this.lastContinueBtn = null;
    }
}
