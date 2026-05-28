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
import { stripStructuredBlock } from '../suggestions';
import { createInsightsConfig } from '../../views/session-view/chat-factory';
import { findTailTurn } from '../turn-utils';
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

    // Reuse the insights profile because both features want a cheap
    // structured-output model and threading a separate "memory profile"
    // through every UI would be overkill.
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
            // Tie the (expensive, multi-second) summarizer LLM call to
            // the runtime lifecycle so closing / evicting / unloading
            // a session mid-extraction stops the call instead of
            // burning tokens to completion in the background.
            runtime.disposeSignal,
        );
    } catch (err) {
        // Disposal-cancellation isn't a real failure — the runtime is
        // gone. Bail silently so the console isn't spammed with a
        // misleading "extractor threw" on every closed session.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        console.warn('[Memory] extractor threw:', err);
        return;
    }
    if (ops.length === 0) return;

    // No mid-loop `disposeSignal.aborted` gate here on purpose. The
    // expensive part (LLM call) is already done; each remaining op is
    // a cheap local file write into the GLOBAL memory note. Discarding
    // those just to honour a disposal-after-extraction would throw
    // away real, paid-for knowledge updates the user is expected to
    // see across all sessions — for no meaningful resource saving.
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

