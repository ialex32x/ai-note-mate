import type NoteAssistantPlugin from 'main';
import type { ChatMessage } from '../chat-stream';
import {
    collectVaultTags,
    extractInsights,
    type ConversationInsight,
    type InsightCardState,
} from '../insights';
import { stripStructuredBlock } from '../suggestions';
import { createInsightsConfig } from '../chat-factory';
import { findTailTurn } from '../turn-utils';
import type { SessionRuntime } from './session-runtime';
import { isAbortError } from '../../utils/abortable-request';

/**
 * Auto-extraction path: run on `onFinish` for the most recent
 * user → assistant turn. Honours the user's `insightExtractionEnabled`
 * toggle and the minimum reply-length gate, both of which are read at
 * call time (live tuning works without restart).
 *
 * Returns a promise that resolves once persistence has been requested.
 * The extractor call itself runs in the background; callers are not
 * expected to await it for ordering with later runtime hooks.
 *
 * Silent on missing insights profile / disabled feature / too-short reply —
 * the auto path never surfaces Notices to the user. The manual path
 * ({@link extractInsightsForMessage}) is responsible for visible
 * feedback when it can't proceed. When `insightsProfileId` is empty,
 * insight extraction is disabled.
 */
export async function maybeExtractInsightsAfterFinish(
    plugin: NoteAssistantPlugin,
    runtime: SessionRuntime,
): Promise<void> {
    if (!plugin.settings.insightExtractionEnabled) return;

    const insightsModel = createInsightsConfig(plugin);
    if (!insightsModel) return;

    const { user, assistant } = findTailTurn(runtime.chat.messages);
    if (!assistant) return;

    // Threshold guard: skip very short replies to avoid token waste.
    const replyText = stripStructuredBlock(assistant.content ?? '').trim();
    const minLen = Math.max(0, plugin.settings.insightExtractionMinReplyChars | 0);
    if (replyText.length < minLen) return;

    await runExtraction(plugin, runtime, user, assistant, 'auto');
}

/**
 * Manual extraction path: called from the per-bubble "Extract insights"
 * action. Unlike {@link maybeExtractInsightsAfterFinish} this bypasses
 * the `insightExtractionEnabled` toggle and the minimum reply length —
 * it is an explicit user gesture and should always proceed when an
 * insights profile is configured.
 *
 * Caller (the view) is responsible for surfacing the "no profile"
 * Notice when {@link createInsightsConfig} returns undefined. This
 * function silently bails in that case so it stays safe to invoke
 * from background paths.
 */
export async function extractInsightsForMessage(
    plugin: NoteAssistantPlugin,
    runtime: SessionRuntime,
    assistantMsg: ChatMessage,
): Promise<void> {
    const insightsModel = createInsightsConfig(plugin);
    if (!insightsModel) return;

    const messages = runtime.chat.messages;
    const idx = messages.findIndex(m => m.id === assistantMsg.id);
    let user: ChatMessage | undefined;
    if (idx > 0) {
        for (let i = idx - 1; i >= 0; i--) {
            const m = messages[i];
            if (m && m.role === 'user' && m.content) {
                user = m;
                break;
            }
        }
    }

    await runExtraction(plugin, runtime, user, assistantMsg, 'manual');
}

/**
 * Shared extraction pipeline. Transitions the runtime's insight state
 * through `loading` → terminal, dropping the result if a newer
 * generation has been started in the meantime (e.g. user manually
 * re-extracted on a different bubble, or a new turn began).
 */
async function runExtraction(
    plugin: NoteAssistantPlugin,
    runtime: SessionRuntime,
    user: ChatMessage | undefined,
    assistant: ChatMessage,
    cause: 'auto' | 'manual',
): Promise<void> {
    const insightsModel = createInsightsConfig(plugin);
    if (!insightsModel) return;

    const gen = runtime.beginInsightExtraction(assistant.id, cause);

    let insights: ConversationInsight[] = [];
    let failed = false;
    try {
        const tags = collectVaultTags(plugin.app);
        const opts = tags.length > 0 ? { availableTags: tags } : undefined;
        insights = await extractInsights(
            insightsModel,
            {
                userMessage: user?.content ?? '',
                assistantMessage: assistant.content ?? '',
            },
            opts,
            // Forward the runtime's lifecycle signal so a session
            // being closed / evicted / unloaded mid-extraction stops
            // burning summarizer tokens instead of running to
            // completion in the background.
            runtime.disposeSignal,
        );
    } catch (err) {
        // Disposal-cancellation isn't a real failure — the runtime is
        // gone, its UI state is being torn down, and committing a
        // terminal here would either be a no-op or (worse) wake the
        // pool to persist a misleading 'error' phase. Bail silently.
        if (isAbortError(err)) return;
        console.warn('[Insights] extraction failed:', err);
        failed = true;
    }

    const terminal: InsightCardState = failed
        ? { messageId: assistant.id, phase: 'error', insights: [], cause }
        : insights.length === 0
            ? { messageId: assistant.id, phase: 'empty', insights: [], cause }
            : { messageId: assistant.id, phase: 'results', insights, cause };

    runtime.commitInsightResult(gen, terminal);
    // Flush the metadata change to disk so a plugin reload (or other
    // out-of-band saveToCache trigger) doesn't lose the result. We
    // fire-and-forget — if the write fails the warning surfaces inside
    // saveMetadata; the in-memory state is still correct.
    void plugin.sessionManager.saveMetadata();
}

