/**
 * Auto memory extraction runner.
 *
 * Mirrors {@link ./insight-runner.ts}: hooked into `onFinish` so the
 * just-completed user→assistant turn is mined for candidate memory
 * upserts/deletes by a cheap summarizer-class model. The resulting ops
 * are applied to the shared {@link MemoryStore} so subsequent turns
 * (in this session OR any other) immediately see the new entries.
 *
 * Hard guarantees:
 *   - Runs only when BOTH the master `memoryEnabled` flag and the
 *     opt-in `memoryAutoExtract` flag are true, AND the memory note
 *     path is non-empty. Either gate being off short-circuits silently.
 *   - Never throws. All paths are wrapped in try/catch with a console
 *     warning; the chat turn must not fail because memory extraction
 *     hiccuped.
 *   - Skips replies shorter than `memoryExtractMinReplyChars` (after
 *     stripping the structured follow-up block) to avoid wasting tokens
 *     on tiny acknowledgements.
 *   - Respects per-turn upsert/delete caps so a single noisy reply
 *     cannot saturate the memory note.
 */

import type NoteAssistantPlugin from '../../main';
import type { ChatMessage } from '../chat-stream';
import { stripStructuredBlock } from '../suggestions';
import { createInsightsConfig } from '../../views/session-view/chat-factory';
import type { SessionRuntime } from '../session-runtime/session-runtime';
import { extractMemoryOps, type MemoryExtractOp } from './memory-extractor';
import { isMemoryConfigured, MemoryStoreError } from './memory-store';

export async function maybeExtractMemoriesAfterFinish(
    plugin: NoteAssistantPlugin,
    runtime: SessionRuntime,
): Promise<void> {
    const settings = plugin.settings;
    if (!isMemoryConfigured(plugin)) return;
    if (!settings.memoryAutoExtract) return;

    // Reuse the insights profile (or its summarizer fallback) because
    // both features want a cheap structured-output model and threading
    // a separate "memory profile" through every UI would be overkill.
    const modelConfig = createInsightsConfig(plugin);
    if (!modelConfig) return;

    const { user, assistant } = findTailTurn(runtime.chat.messages);
    if (!assistant) return;

    const replyText = stripStructuredBlock(assistant.content ?? '').trim();
    const minLen = Math.max(0, settings.memoryExtractMinReplyChars | 0);
    if (replyText.length < minLen) return;

    const store = plugin.memoryStore;
    let existing;
    try {
        existing = await store.refreshEntries();
    } catch (err) {
        console.warn('[Memory] failed to read existing memory entries before extraction:', err);
        return;
    }

    let ops: MemoryExtractOp[];
    try {
        ops = await extractMemoryOps(
            modelConfig,
            {
                userMessage: user?.content ?? '',
                assistantMessage: assistant.content ?? '',
                existing,
            },
            {
                maxUpserts: settings.memoryExtractMaxUpserts,
                maxDeletes: settings.memoryExtractMaxDeletes,
            },
        );
    } catch (err) {
        console.warn('[Memory] extractor threw:', err);
        return;
    }
    if (ops.length === 0) return;

    for (const op of ops) {
        try {
            if (op.op === 'upsert') {
                await store.upsert(op.heading, op.critical, op.body);
            } else {
                await store.delete(op.heading);
            }
        } catch (err) {
            // Per-op isolation: one failed write must not block the
            // others. Surface a console warning with the store error's
            // stable `kind` when available so the cause is greppable.
            if (err instanceof MemoryStoreError) {
                console.warn(`[Memory] auto-extract op failed (kind=${err.kind}):`, err.message);
            } else {
                console.warn('[Memory] auto-extract op failed:', err);
            }
        }
    }
}

/**
 * Walk back from the message log tail to find the most recent
 * non-streaming assistant message and its anchoring user message.
 * Same shape as the insights runner's helper; duplicated here rather
 * than imported to keep the two features independently evolvable.
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
