/**
 * Runtime-level suggestion extraction runner.
 *
 * Wired into {@link SessionRuntime}'s `onFinish` callback so background
 * runtimes (no view attached) still produce + persist suggestions.
 * Mirrors `insight-runner.ts` in structure and lifecycle.
 *
 * The view runs deterministic extraction (structured block + heuristic)
 * for instant feedback; this runner provides the LLM-backed fallback
 * that may arrive 1–3 s later.
 */

import type NoteAssistantPlugin from 'main';
import { extractSuggestions, extractSuggestionsViaLLM, type SuggestionCardState } from '../suggestions';
import { createSummarizerConfig } from '../chat-factory';
import { findTailTurn } from '../turn-utils';
import type { SessionRuntime } from './session-runtime';
import { isAbortError } from '../../utils/abortable-request';

/** Minimum assistant reply length (chars) to trigger LLM fallback. */
const MIN_REPLY_CHARS = 50;

/**
 * Auto-extraction path: run on `onFinish` for the most recent
 * user → assistant turn. First tries deterministic extraction
 * (cheap, instant); only fires the LLM fallback when that produces
 * nothing AND the reply is long enough to justify the token cost.
 *
 * Returns a promise that resolves once persistence has been requested.
 * Fire-and-forget — errors are logged internally and must never block
 * the turn.
 */
export async function maybeExtractSuggestionsAfterFinish(
    plugin: NoteAssistantPlugin,
    runtime: SessionRuntime,
): Promise<void> {
    const settings = plugin.settings;
    if (!settings.followUpSuggestionsEnabled) return;

    const suggestionsModel = createSummarizerConfig(plugin);
    if (!suggestionsModel) return;

    const { user, assistant } = findTailTurn(runtime.chat.messages);
    if (!assistant) return;

    const assistantContent = assistant.content ?? '';
    const replyText = assistantContent.trim();
    if (replyText.length < MIN_REPLY_CHARS) return;

    // ── 1) Try deterministic extraction first ──────────────────────
    const deterministic = extractSuggestions(assistantContent, {
        allowStructured: settings.followUpSuggestionsStructured === true,
    });
    if (deterministic.length > 0) return; // view already has results

    // ── 2) LLM fallback ────────────────────────────────────────────
    const gen = runtime.beginSuggestionExtraction(assistant.id, 'auto');

    let suggestions: SuggestionCardState['suggestions'] = [];
    let failed = false;
    try {
        suggestions = await extractSuggestionsViaLLM(
            suggestionsModel,
            user?.content ?? '',
            assistantContent,
            runtime.disposeSignal,
        );
    } catch (err) {
        if (isAbortError(err)) return;
        console.warn('[Suggestions] LLM extraction failed:', err);
        failed = true;
    }

    const terminal: SuggestionCardState | null = failed
        ? { messageId: assistant.id, phase: 'error', suggestions: [], cause: 'auto' }
        : suggestions.length === 0
            ? { messageId: assistant.id, phase: 'empty', suggestions: [], cause: 'auto' }
            : { messageId: assistant.id, phase: 'results', suggestions, cause: 'auto' };

    runtime.commitSuggestionResult(gen, terminal);
    // Flush metadata so a plugin reload doesn't lose the result.
    void plugin.sessionManager.saveMetadata();
}
