import type NoteAssistantPlugin from 'main';
import type { ChatMessage } from '../chat-stream';
import {
    collectVaultTags,
    extractInsights,
    type ConversationInsight,
    type InsightCardState,
} from '../insights';
import { stripStructuredBlock } from '../suggestions';
import { createSummarizerConfig } from '../../views/session-view/chat-factory';
import type { SessionRuntime } from './session-runtime';

/**
 * Auto-extraction path: run on `onFinish` for the most recent
 * user → assistant turn. Honours the user's `insightExtractionEnabled`
 * toggle and the minimum reply-length gate, both of which are read at
 * call time (live tuning works without restart).
 *
 * Returns a promise that resolves once persistence has been requested.
 * The summarizer call itself runs in the background; callers are not
 * expected to await it for ordering with later runtime hooks.
 *
 * Silent on missing summarizer / disabled feature / too-short reply —
 * the auto path never surfaces Notices to the user. The manual path
 * ({@link extractInsightsForMessage}) is responsible for visible
 * feedback when it can't proceed.
 */
export async function maybeExtractInsightsAfterFinish(
    plugin: NoteAssistantPlugin,
    runtime: SessionRuntime,
): Promise<void> {
    if (!plugin.settings.insightExtractionEnabled) return;

    const summarizer = createSummarizerConfig(plugin);
    if (!summarizer) return;

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
 * it is an explicit user gesture and should always proceed when there
 * is a summarizer profile to call.
 *
 * Caller (the view) is responsible for surfacing the "no summarizer"
 * Notice when {@link createSummarizerConfig} returns undefined. This
 * function silently bails in that case so it stays safe to invoke
 * from background paths.
 */
export async function extractInsightsForMessage(
    plugin: NoteAssistantPlugin,
    runtime: SessionRuntime,
    assistantMsg: ChatMessage,
): Promise<void> {
    const summarizer = createSummarizerConfig(plugin);
    if (!summarizer) return;

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
    const summarizer = createSummarizerConfig(plugin);
    if (!summarizer) return;

    const gen = runtime.beginInsightExtraction(assistant.id, cause);

    let insights: ConversationInsight[] = [];
    let failed = false;
    try {
        const tags = collectVaultTags(plugin.app);
        const opts = tags.length > 0 ? { availableTags: tags } : undefined;
        insights = await extractInsights(
            summarizer,
            {
                userMessage: user?.content ?? '',
                assistantMessage: assistant.content ?? '',
            },
            opts,
        );
    } catch (err) {
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

/**
 * Walk back from the tail of the message log to find the most recent
 * non-streaming assistant message and the user message that preceded
 * it (skipping intermediate tool calls / sub-agent traffic).
 *
 * Used by the auto path only; the manual path takes the assistant
 * message explicitly from the caller. We don't filter by
 * `abortedMessageIds` here because:
 *   - on `onFinish` the just-completed assistant is guaranteed clean
 *   - older aborted assistants in mid-conversation are fine to anchor
 *     against in principle, but the auto path only runs at the end of
 *     a clean turn so this case can't happen in practice.
 */
function findTailTurn(messages: ReadonlyArray<ChatMessage>): {
    user: ChatMessage | undefined;
    assistant: ChatMessage | undefined;
} {
    let assistant: ChatMessage | undefined;
    let user: ChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m) continue;
        if (!assistant) {
            if (m.role === 'assistant' && !m.streaming && m.content) {
                assistant = m;
            }
            continue;
        }
        if (m.role === 'user' && m.content) {
            user = m;
            break;
        }
    }
    return { user, assistant };
}
