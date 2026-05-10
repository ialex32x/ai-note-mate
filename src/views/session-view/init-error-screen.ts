/**
 * Render a full-screen initialization error surface inside the session
 * view's content element. Used when {@link SessionView.onOpen} throws so
 * the user gets a visible, copyable error report with a retry button.
 *
 * Extracted from SessionView to keep the view file focused on lifecycle
 * and coordination.
 */
import { copyToClipboard } from '../../utils/clipboard';

export function showInitializationError(
    contentEl: HTMLElement,
    error: unknown,
    onRetry: () => void,
): void {
    contentEl.empty();
    contentEl.addClass('session-view');

    const errorContainer = contentEl.createEl('div', { cls: 'session-error-container' });

    errorContainer.createEl('div', {
        cls: 'session-error-title',
        text: 'Session view initialization error',
    });

    const errorMessage = errorContainer.createEl('div', { cls: 'session-error-message' });
    const errorText = error instanceof Error
        ? `${error.name}: ${error.message}\n\nStack trace:\n${error.stack}`
        : String(error);

    errorMessage.createEl('pre', { cls: 'session-error-stack', text: errorText });

    const copyBtn = errorContainer.createEl('button', { cls: 'session-error-copy-btn', text: 'Copy error' });
    copyBtn.addEventListener('click', () => {
        void (async () => {
            const ok = await copyToClipboard(errorText, { showNotice: false });
            if (!ok) return;
            copyBtn.setText('Copied!');
            setTimeout(() => copyBtn.setText('Copy error'), 2000);
        })();
    });

    const retryBtn = errorContainer.createEl('button', { cls: 'session-error-retry-btn', text: 'Retry' });
    retryBtn.addEventListener('click', () => onRetry());

    console.error('SessionView initialization error:', error);
}
