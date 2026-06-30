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

const TITLE_INPUT_CLASS = 'session-toolbar__title-input';

/**
 * Handle click on session title to enable inline renaming.
 */
export function handleTitleClick(opts: TitleClickOptions): void {
    const { container, sessionTitleEl, sessionManager, isStreaming, refreshDisplay } = opts;

    // Don't allow renaming while streaming
    if (isStreaming()) return;

    // Guard against double-click / re-entry: if an editing input already
    // exists in the container (possibly orphaned from a previous rapid
    // double-click), reject the attempt so we don't leak more elements.
    if (container.querySelector(`.${TITLE_INPUT_CLASS}`)) return;

    // Get current full title
    const session = sessionManager.getActiveSessionSync();
    const currentTitle = session?.title || session?.firstUserMessage || '';

    // Hide the title element
    sessionTitleEl.addClass('is-hidden');

    // Create input element for editing
    const input = container.createEl('input', {
        cls: TITLE_INPUT_CLASS,
        attr: {
            type: 'text',
            value: currentTitle,
            placeholder: t('view.sessionTitlePlaceholder'),
        },
    });

    input.focus();
    input.select();

    const cleanup = () => {
        // Remove all title-input elements in the container defensively,
        // so any orphaned inputs from prior race conditions are also
        // cleaned up.
        const allInputs = container.querySelectorAll(`.${TITLE_INPUT_CLASS}`);
        allInputs.forEach(el => el.remove());
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
