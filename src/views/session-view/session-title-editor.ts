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
 * after the first user message, using the summarizer profile. No-op if
 * already titled, no rounds, or no summarizer configured.
 *
 * When `sessionId` is provided, operates on that specific session
 * (used by background SessionRuntime instances whose finish event
 * fires after the view has switched away). When omitted, falls back
 * to the active session for backwards-compatible callers.
 */
export async function maybeGenerateSessionTitle(
    sessionManager: SessionManager,
    summarizerConfig: MinimalModelConfig | undefined,
    onAfter: () => void,
    sessionId?: string,
    /**
     * Lifecycle-scoped abort signal forwarded to the summarizer LLM
     * call. The runtime path passes `runtime.disposeSignal` so closing /
     * evicting / unloading a session mid-titling stops the call instead
     * of letting another ~5 s of tokens drain in the background. Manual
     * callers (e.g. the view-side wrapper) leave this undefined — there
     * is no analogous lifecycle to attach to.
     */
    signal?: AbortSignal,
): Promise<void> {
    const targetId = sessionId ?? sessionManager.activeSessionId;
    const session = await sessionManager.getSession(targetId);
    if (!session) return;

    if (session.title) return;
    const rounds = session.messages.filter(m => m.role === 'user').length;
    if (rounds < 1) return;

    if (!summarizerConfig) return;

    try {
        const summarySource = session.messages.filter(msg => msg.role === 'user' || msg.role === 'assistant');
        const generatedTitle = await summarizeConversation(
            summarizerConfig,
            { content: TITLE_SUMMARIZE_PROMPT },
            summarySource,
            1,
            signal,
            true, // skipTrailingUserInstruction: fold instruction into system prompt
        );
        if (!generatedTitle) return;
        // Strip any markdown formatting the model may have emitted
        // despite the prompt's plain-text instruction, then cap length.
        const trimmedTitle = stripMarkdownToPlainText(generatedTitle).slice(0, 150);
        if (trimmedTitle) {
            sessionManager.setSessionTitle(targetId, trimmedTitle);
            onAfter();
        }
    } catch (e) {
        // Disposal-cancellation is expected when a session is closed
        // mid-titling — don't spam the console with a misleading
        // "Failed to generate session title" on every such close.
        if (e instanceof DOMException && e.name === 'AbortError') return;
        console.warn('Failed to generate session title:', e);
    }
}
