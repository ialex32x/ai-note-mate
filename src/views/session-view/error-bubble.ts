import { Menu, setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import { prettifyIfJson } from '../../utils/json-format';
import { copyToClipboard } from '../../utils/clipboard';

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
    const errorText = prettifyIfJson(message);

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

export async function copyErrorToClipboard(text: string): Promise<void> {
    await copyToClipboard(text, { logLevel: 'warn' });
}
