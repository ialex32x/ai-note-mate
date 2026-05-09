import { Menu, Notice, setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';

export interface AppendErrorBubbleOptions {
    messagesEl: HTMLElement;
    /** Called after the bubble is appended so the singleton typing indicator stays pinned to tail. */
    pinTypingIndicatorToEnd: () => void;
    /** Optional auto-scroll trigger. */
    maybeScrollToBottom: () => void;
}

/**
 * Append an error bubble to the message list. Extracted from SessionView.
 */
export function appendErrorBubble(message: string, opts: AppendErrorBubbleOptions): void {
    const errorText = formatErrorMessage(message);

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
        text: errorText,
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
        void copyErrorToClipboard(errorText);
    });

    bubble.addEventListener('contextmenu', (ev: MouseEvent) => {
        ev.preventDefault();
        const menu = new Menu();
        menu.addItem((item) => {
            item.setTitle(t('view.copyError'));
            item.setIcon('copy');
            item.onClick(() => {
                void copyErrorToClipboard(errorText);
            });
        });
        menu.showAtMouseEvent(ev);
    });

    // Keep singleton typing indicator pinned to tail even when we insert
    // an error bubble via a different code path than `appendBubble`.
    opts.pinTypingIndicatorToEnd();
    opts.maybeScrollToBottom();
    console.error('Error:', message);
}

/**
 * Best-effort prettify error messages so JSON payloads embedded in the
 * message are easier to read inside the bubble. Falls back to the original
 * string when the input is not a recognisable JSON object.
 */
export function formatErrorMessage(message: string): string {
    if (!message) return '';
    const trimmed = message.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
            const parsed = JSON.parse(trimmed);
            return JSON.stringify(parsed, null, 2);
        } catch {
            /* not valid JSON — fall through */
        }
    }
    return message;
}

export async function copyErrorToClipboard(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        new Notice(t('view.copied'));
    } catch (err) {
        console.warn('Failed to copy error message:', err);
    }
}
