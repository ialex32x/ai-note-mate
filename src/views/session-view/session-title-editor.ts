import { setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { SessionManager } from '../../session-manager';

// Re-exported from the service layer so callers in services/ don't
// need to cross into views/.
export { maybeGenerateSessionTitle } from '../../services/session-title-generator';

/**
 * Refresh the toolbar title element from the active session. Truncates the
 * display text to 40 chars and sets the full title as tooltip.
 */
export function updateSessionTitle(
    sessionTitleEl: HTMLElement | undefined,
    sessionManager: SessionManager,
): void {
    const session = sessionManager.getActiveSessionSync();

    // Get full title for tooltip (no truncation)
    const fullTitle = session?.title || session?.firstUserMessage || t('view.newChat');
    // Truncate for display
    const displayTitle = fullTitle.length > 40 ? fullTitle.slice(0, 40) + '…' : fullTitle;

    if (sessionTitleEl) {
        sessionTitleEl.textContent = displayTitle;
        setTooltip(sessionTitleEl, session?.id ?? fullTitle);
    }
}

export interface TitleClickOptions {
    container: HTMLElement;
    sessionTitleEl: HTMLElement;
    sessionManager: SessionManager;
    isStreaming: () => boolean;
    refreshDisplay: () => void;
}

/**
 * Handle click on session title to enable inline renaming.
 */
export function handleTitleClick(opts: TitleClickOptions): void {
    const { container, sessionTitleEl, sessionManager, isStreaming, refreshDisplay } = opts;

    // Don't allow renaming while streaming
    if (isStreaming()) return;

    // Get current full title
    const session = sessionManager.getActiveSessionSync();
    const currentTitle = session?.title || session?.firstUserMessage || '';

    // Hide the title element
    sessionTitleEl.addClass('is-hidden');

    // Create input element for editing
    const input = container.createEl('input', {
        cls: 'session-toolbar__title-input',
        attr: {
            type: 'text',
            value: currentTitle,
            placeholder: t('view.sessionTitlePlaceholder'),
        },
    });

    input.focus();
    input.select();

    const cleanup = () => {
        input.remove();
        sessionTitleEl.removeClass('is-hidden');
    };

    const commit = async () => {
        const newTitle = input.value.trim();
        if (newTitle) {
            sessionManager.setTitle(newTitle);
            await sessionManager.saveMetadata();
            refreshDisplay();
        }
        // If empty, treat as cancel
        cleanup();
    };

    const cancel = () => cleanup();

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    input.addEventListener('blur', () => {
        void commit();
    });
}
