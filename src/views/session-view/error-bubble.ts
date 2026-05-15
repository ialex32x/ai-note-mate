import { Menu, setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import { prettifyIfJson } from '../../utils/json-format';
import { copyToClipboard } from '../../utils/clipboard';
import { safeSliceHead } from '../../utils/string-safe';

export interface AppendErrorBubbleOptions {
    messagesEl: HTMLElement;
    /** Called after the bubble is appended so the singleton streaming loader stays pinned to tail. */
    pinStreamingLoaderToEnd: () => void;
    /** Optional auto-scroll trigger. */
    maybeScrollToBottom: () => void;
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
 * Append an error bubble to the message list. Extracted from SessionView.
 */
export function appendErrorBubble(message: string, opts: AppendErrorBubbleOptions): void {
    const fullText = prettifyIfJson(message);
    // Surrogate-aware truncation: never split an emoji / non-BMP character
    // pair when chopping the display string.
    const truncated = fullText.length > ERROR_DISPLAY_MAX_CHARS;
    const displayText = truncated
        ? safeSliceHead(fullText, ERROR_DISPLAY_MAX_CHARS) + '…'
        : fullText;

    const bubble = opts.messagesEl.createEl('div', {
        cls: 'session-bubble session-bubble--error',
    });

    const role = bubble.createEl('div', { cls: 'session-bubble__role' });
    const roleIcon = role.createEl('span', { cls: 'session-bubble__error-icon' });
    setIcon(roleIcon, 'alert-triangle');
    role.createEl('span', { text: t('view.roleError') });

    const content = bubble.createEl('div', { cls: 'session-bubble__content' });
    content.createEl('pre', {
        cls: 'session-bubble__error-text',
        text: displayText,
    });

    const actions = bubble.createEl('div', { cls: 'session-bubble__actions' });
    const copyBtn = actions.createEl('button', {
        cls: 'session-bubble__action-btn',
        attr: { 'aria-label': t('view.copyError') },
    });
    setIcon(copyBtn, 'copy');
    setTooltip(copyBtn, t('view.copyError'));
    copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Always copy the full, untruncated text so the user can paste it
        // into an issue / debugger even if the bubble itself is shortened.
        void copyErrorToClipboard(fullText);
    });

    bubble.addEventListener('contextmenu', (ev: MouseEvent) => {
        ev.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => {
            item.setTitle(t('view.copyError'));
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
}

export async function copyErrorToClipboard(text: string): Promise<void> {
    await copyToClipboard(text, { logLevel: 'warn' });
}
