import type { SessionManager } from '../session-manager';
import { summarizeConversationToTitle } from './context-reducer';
import { TITLE_SUMMARIZE_PROMPT } from './prompts/session-prompts';
import type { MinimalModelConfig } from './llm-provider';
import { stripMarkdownToPlainText } from '../utils/markdown-sanitizer';
import { isAbortError } from '../utils/abortable-request';

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
        const generatedTitle = await summarizeConversationToTitle(
            summarizerConfig,
            { content: TITLE_SUMMARIZE_PROMPT },
            summarySource,
            signal,
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
        if (isAbortError(e)) return;
        console.warn('Failed to generate session title:', e);
    }
}
