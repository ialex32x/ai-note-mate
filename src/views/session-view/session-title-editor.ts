import { setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { SessionManager } from '../../session-manager';
import { summarizeConversation } from '../../services/context-reducer';
import { TITLE_SUMMARIZE_PROMPT } from '../../services/prompts/session-prompts';
import type { MinimalModelConfig } from '../../services/llm-provider';
import { stripMarkdownToPlainText } from '../../utils/markdown-sanitizer';

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
        setTooltip(sessionTitleEl, fullTitle);
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

/**
 * Automatically generate a session title from the conversation content
 * after enough rounds, using the summarizer profile. No-op if already
 * titled, too few rounds, or no summarizer configured.
 */
export async function maybeGenerateSessionTitle(
    sessionManager: SessionManager,
    summarizerConfig: MinimalModelConfig | undefined,
    onAfter: () => void,
): Promise<void> {
    const session = await sessionManager.getActiveSession();
    if (!session) return;

    if (session.title) return;
    const rounds = session.messages.filter(m => m.role === 'user').length;
    if (rounds <= 2) return;

    if (!summarizerConfig) return;

    try {
        const summarySource = session.messages.filter(msg => msg.role === 'user' || msg.role === 'assistant');
        const generatedTitle = await summarizeConversation(
            summarizerConfig,
            { content: TITLE_SUMMARIZE_PROMPT },
            summarySource,
        );
        if (!generatedTitle) return;
        // Strip any markdown formatting the model may have emitted
        // despite the prompt's plain-text instruction, then cap length.
        const trimmedTitle = stripMarkdownToPlainText(generatedTitle).slice(0, 150);
        if (trimmedTitle) {
            sessionManager.setTitle(trimmedTitle);
            onAfter();
        }
    } catch (e) {
        console.warn('Failed to generate session title:', e);
    }
}
