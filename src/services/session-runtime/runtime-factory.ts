import type NoteAssistantPlugin from 'main';
import { createChatAgent, buildDynamicTools, createSummarizerConfig } from '../chat-factory';
import { maybeGenerateSessionTitle } from '../session-title-generator';
import { deriveArtifactStoreOptions } from '../../settings/helpers';
import { SessionRuntime } from './session-runtime';
import { maybeExtractInsightsAfterFinish } from './insight-runner';
import { maybeExtractSuggestionsAfterFinish } from './suggestion-runner';
import { maybeExtractMemoriesAfterFinish } from '../memory';
import { CheckpointStore } from '../vault';
import type { ChatMessage, ContextBreakdown } from '../chat-stream';

/**
 * Build a fully-wired {@link SessionRuntime} for the given sessionId.
 *
 * The factory:
 *   1. Constructs the SessionRuntime shell.
 *   2. Asks `createChatAgent` (the existing main-agent/orchestrator
 *      builder) for an IChatAgent whose callbacks route into the
 *      runtime's event bus instead of directly into a SessionView.
 *   3. Binds the chat onto the runtime so external code can use
 *      `runtime.chat` thereafter.
 *
 * Callback routing rules:
 *   - Most events forward verbatim into `runtime.emit(...)`. The
 *     runtime mutates its own state where relevant (busy flag,
 *     pendingConfirmations) BEFORE emitting, so listeners observe a
 *     consistent state when they react.
 *   - `onFinish` / `onAbort` / `onError` additionally persist via
 *     `runtime.persist()` keyed by THIS sessionId — independent of
 *     whichever session the active SessionView is currently showing.
 *     This is the central reason the runtime can outlive the view.
 *
 * What is deliberately NOT done here:
 *   - No `generationMatches()` guard. The runtime IS the unit of
 *     identity; switching sessions detaches listeners but does not
 *     invalidate the runtime, so there is no "stale generation" to
 *     guard against. Per-turn aborts are handled by IChatAgent's own
 *     state machine.
 *   - No DOM access of any kind. The runtime stays free of
 *     view-private references so a background continuation cannot
 *     leak into a detached DOM tree.
 *   - Follow-up-suggestion deterministic extraction runs in the view
 *     for instant feedback; the LLM fallback runs here (same as
 *     insights) so background turns produce + persist suggestions even
 *     when no view is attached.
 *   - Title generation and insight extraction, by contrast, both call
 *     out to an LLM and are not idempotent / cheap. Those run here in
 *     `onFinish` so background continuations correctly produce + persist
 *     them even while no view is attached. The SessionView then just
 *     re-renders from runtime state when re-attached.
 */
export function createSessionRuntime(
    plugin: NoteAssistantPlugin,
    sessionId: string,
): SessionRuntime {
    // Read settings ONCE at construction. Live re-tuning of the
    // store knobs is intentionally not supported: existing entries
    // would need re-balancing across the new caps, which is not
    // worth the complexity for a knob users touch rarely. New
    // sessions pick up the new values automatically.
    // Per-session checkpoint state machine. Wired into every AI vault
    // mutation via VaultMutator; auto-accepted on runtime dispose so
    // tearing down a session never leaves cross-session locks dangling.
    const checkpointStore = new CheckpointStore({
        sessionId,
        lockManager: plugin.fileLockManager,
        snapshotManager: plugin.snapshotManager,
        app: plugin.app,
    });

    // Derive artifact store options and inject persistence dependencies.
    const artifactStoreOpts = deriveArtifactStoreOptions(plugin.settings);
    // Vault-relative artifacts directory for this session.
    artifactStoreOpts.artifactsDir = `${plugin.paths.sessions()}/${sessionId}/artifacts`;
    artifactStoreOpts.adapter = plugin.app.vault.adapter;

    const runtime = new SessionRuntime(
        sessionId,
        plugin.sessionManager,
        checkpointStore,
        artifactStoreOpts,
    );

    const chat = createChatAgent(plugin, {
        // No generation guard at the runtime layer; identity = runtime instance.
        generationMatches: () => true,
        getDynamicTools: () => buildDynamicTools(plugin, {
            hasContextCompressed: runtime.hasContextCompressed,
            getArtifactStore: () => runtime.artifactStore,
        }),
        // Surface the runtime's per-session artifact store to the chat
        // factory so the main agent's `recall_artifact` tool can be
        // bound to it. Returning the runtime's own field keeps the
        // store's lifetime perfectly aligned with the runtime.
        getArtifactStore: () => runtime.artifactStore,
        // Surface a thin adapter over the runtime's TODO state to the
        // chat factory so the main agent's `manage_todos` tool can
        // reach the live snapshot for every operation. The adapter is
        // recreated on each call but its methods all delegate to the
        // same long-lived runtime instance, so identity equality is
        // irrelevant — what matters is that every method ultimately
        // hits `runtime`. This mirrors how `getArtifactStore` works.
        getTodoStateSource: () => ({
            get: () => runtime.getTodoState(),
            replaceAll: (items) => runtime.replaceTodos(items),
            update: (id, patch) => runtime.updateTodo(id, patch),
            clear: () => runtime.clearTodos(),
        }),
        onStart: () => {
            runtime.markBusy();
            // A new turn supersedes any previously-extracted insights
            // (they were anchored to a now-stale assistant message id).
            // Clearing both in-memory and persisted state here keeps
            // metadata in sync; the next clean finish will repopulate.
            runtime.clearInsightState();
            // Same for follow-up suggestions — a new turn makes the
            // old assistant reply's suggestions stale.
            runtime.clearSuggestionState();
            runtime.emit({ type: 'start' });
        },
        onMessageUpdate: (msg: ChatMessage) => {
            runtime.emit({ type: 'message-update', msg });
        },
        onSubAgentMessageUpdate: (agentName: string, msg: ChatMessage) => {
            runtime.emit({ type: 'sub-agent-message-update', agentName, msg });
        },
        onToolCallEnd: () => {
            runtime.emit({ type: 'tool-call-end' });
        },
        onAssetGenerated: (assets) => {
            runtime.assetCollection.addAssets(assets);
        },
        onFinish: () => {
            // Mark idle BEFORE persistence so pool compaction sees the
            // current state if persist triggers reentrancy (it does not
            // today, but the ordering keeps things obvious).
            runtime.markIdle();
            // Persist by id. Errors here are non-fatal — we still need
            // to notify the view so it can update UI; the next
            // saveToCache call will retry from in-memory state.
            void runtime.persist().catch(err => {
                console.warn('[SessionRuntime] persist on finish failed:', err);
            }).finally(() => {
                runtime.emit({ type: 'finish' });
                // Schedule the global cache flush. The view used to do
                // this in chat-callbacks.onFinish; moving it here keeps
                // background-finished runtimes correctly flushing too.
                void plugin.sessionManager.saveToCache();
                // Title generation belongs to the session itself (not
                // the view), so run it here unconditionally — including
                // for runtimes whose view has detached. When a title
                // is actually written we emit `title-updated` so any
                // attached view can refresh its display.
                void maybeGenerateSessionTitle(
                    plugin.sessionManager,
                    createSummarizerConfig(plugin),
                    () => { runtime.emit({ type: 'title-updated' }); },
                    runtime.sessionId,
                    // Tie the summarizer LLM call to the runtime
                    // lifecycle so a session being closed / evicted /
                    // unloaded mid-titling stops the call instead of
                    // running to completion in the background.
                    runtime.disposeSignal,
                );
                // Insight extraction: also runs here so a background
                // turn that finishes while the view is on another
                // session still produces (and persists) insights. The
                // runtime drives its own state machine + emits
                // 'insight-update'; an attached view re-renders, a
                // detached one will read via getInsightState() on next
                // attach. Fire-and-forget — errors are logged inside.
                void maybeExtractInsightsAfterFinish(plugin, runtime);
                // Suggestion extraction (LLM fallback): mirrors the
                // insight pattern. Determines if the deterministic
                // extraction produced nothing, then fires a separate
                // LLM call to generate suggestions. Persisted so the
                // bar survives view detach and plugin reload.
                void maybeExtractSuggestionsAfterFinish(plugin, runtime);
                // Memory auto-extraction. Gated by `memoryAutoExtract`
                // (off by default), so users who don't opt in pay
                // nothing. Failures are swallowed internally — memory
                // must NEVER block or alter the chat turn.
                void maybeExtractMemoriesAfterFinish(plugin, runtime);
                // Persist context breakdown once per turn (instead of
                // on every LLM round inside a tool-call loop). Only
                // active when debug mode is on; I/O errors are silently
                // swallowed.
                const breakdown = chat.contextBreakdown;
                if (plugin.settings.debugEnabled && breakdown) {
                    persistContextBreakdownCache(plugin, sessionId, breakdown);
                }
            });
        },
        onAbort: (msg: ChatMessage) => {
            runtime.markIdle();
            // Mirror onFinish: abort is a terminal state for the turn,
            // and the partial output is worth persisting.
            void runtime.persist().catch(err => {
                console.warn('[SessionRuntime] persist on abort failed:', err);
            }).finally(() => {
                runtime.emit({ type: 'abort', msg });
                void plugin.sessionManager.saveToCache();
            });
        },
        onUsageUpdate: () => {
            runtime.emit({ type: 'usage-update' });
        },
        onError: (err: Error) => {
            runtime.markIdle();
            // Errors don't necessarily produce a clean message snapshot,
            // but we still persist whatever progress was made.
            void runtime.persist().catch(persistErr => {
                console.warn('[SessionRuntime] persist on error failed:', persistErr);
            }).finally(() => {
                runtime.emit({ type: 'error', err });
            });
        },
        onContextCompressed: () => {
            runtime.hasContextCompressed = true;
            runtime.emit({ type: 'context-compressed' });
        },
        onSummarizing: () => {
            // Summarization is about to begin — surface a transient
            // status update so the user knows why there is a pause
            // before the assistant reply starts streaming.
            runtime.emit({ type: 'context-summarizing' });
        },
        onEmergencyShrink: () => {
            // Always forward the event so listeners that care (e.g. a
            // future telemetry sink) can observe every occurrence. The
            // `hasEmergencyShrunk` flag is the per-session "have we
            // already told the user?" gate consulted by the view layer
            // — it is NOT a guard on the emit itself.
            const firstTime = !runtime.hasEmergencyShrunk;
            runtime.hasEmergencyShrunk = true;
            runtime.emit({ type: 'emergency-shrink-applied' });
            if (firstTime) {
                console.warn('[SessionRuntime] emergency shrink triggered for the first time in this session');
            }
        },
        onConfirmToolCall: (messageId: string, signal?: AbortSignal) => {
            // Build a promise pinned to the runtime's pending map. The
            // chat awaits this promise; if no view is attached the
            // promise simply doesn't resolve until the user later
            // re-attaches and decides. This is the explicit, intended
            // back-pressure mechanism for background tool confirmation.
            //
            // The chat-stream forwards its per-turn AbortSignal here so
            // we can break the await when the user hits the global stop
            // button instead of clicking Allow / Reject. Without this,
            // the surrounding `await onConfirmToolCall(...)` blocks
            // forever — `abort()` flips `signal.aborted` but the promise
            // never settles, so `isBusy` stays true and the UI shows
            // ⏹ but nothing ever moves. See chat-stream.ts for the
            // matching contract on `ChatStreamConfig.onConfirmToolCall`.
            return new Promise<boolean>((resolve, reject) => {
                if (signal?.aborted) {
                    // Already aborted before we even queued; bail without
                    // touching `pendingConfirmations` so we never leak an
                    // entry that nothing will ever resolve.
                    reject(new DOMException('Aborted', 'AbortError'));
                    return;
                }
                const onAbort = () => {
                    // Drop the queued resolver so future re-renders don't
                    // see a stale pending entry, and unblock the awaiting
                    // chat-stream with an AbortError it already knows how
                    // to clean up around the tool_call bubble.
                    runtime.pendingConfirmations.delete(messageId);
                    reject(new DOMException('Aborted', 'AbortError'));
                };
                // { once: true } guarantees the listener is auto-removed
                // after firing once, so dispose() does not need to
                // manually call removeEventListener here — resolving the
                // pending confirmation and clearing the map is sufficient.
                signal?.addEventListener('abort', onAbort, { once: true });
                runtime.enqueueConfirmation(messageId, (approved) => {
                    // Normal resolution path — detach the abort listener
                    // so a later abort on the same (now-idle) signal
                    // cannot retroactively try to delete the (already
                    // removed) map entry or double-settle the promise.
                    signal?.removeEventListener('abort', onAbort);
                    resolve(approved);
                });
            });
        },
    });

    runtime.bindChat(chat);
    // Tag the chat agent with our sessionId so downstream side-effect
    // logs (e.g. the AI file-changes audit log) can attribute each
    // recorded mutation back to the session it was performed in.
    chat.contextTag = sessionId;
    return runtime;
}

// ── Context-breakdown cache persistence (debug mode) ──────────────────

const BREAKDOWN_FILE = 'context-breakdown.json';

/**
 * Persist a {@link ContextBreakdown} to
 * `{plugin paths sessions}/{sessionId}/context-breakdown.json`.
 * Only called when debug mode is on; I/O errors are silently swallowed.
 */
export function persistContextBreakdownCache(
    plugin: NoteAssistantPlugin,
    sessionId: string,
    breakdown: ContextBreakdown,
): void {
    try {
        const adapter = plugin.app.vault.adapter;
        const path = `${plugin.paths.sessions()}/${sessionId}/${BREAKDOWN_FILE}`;
        void adapter.write(path, JSON.stringify(breakdown))
            .catch(() => { /* non-critical, ignore */ });
    } catch { /* non-critical, ignore */ }
}

/**
 * Try to load the last persisted context-breakdown for a session.
 * Returns `undefined` when the file doesn't exist, is malformed,
 * or the adapter is unavailable (mobile, etc.).
 *
 * Always safe to call — errors are silently swallowed.
 */
export async function loadContextBreakdownCache(
    plugin: NoteAssistantPlugin,
    sessionId: string,
): Promise<ContextBreakdown | undefined> {
    try {
        const adapter = plugin.app.vault.adapter;
        const path = `${plugin.paths.sessions()}/${sessionId}/${BREAKDOWN_FILE}`;
        const exists = await adapter.exists(path);
        if (!exists) return undefined;
        const raw = await adapter.read(path);
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object'
            && 'systemPrompt' in parsed && 'conversation' in parsed
            && 'summaries' in parsed && 'toolSchemas' in parsed) {
            return parsed as ContextBreakdown;
        }
    } catch { /* non-critical, ignore */ }
    return undefined;
}
