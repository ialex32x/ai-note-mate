import type NoteAssistantPlugin from 'main';
import { createChatAgent, buildDynamicTools, createSummarizerConfig } from '../../views/session-view/chat-factory';
import { maybeGenerateSessionTitle } from '../../views/session-view/session-title-editor';
import { deriveArtifactStoreOptions } from '../../settings/helpers';
import { SessionRuntime } from './session-runtime';
import type { ChatMessage } from '../chat-stream';

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
 *   - No follow-up suggestions / insight extraction / title generation.
 *     Those are post-turn side-effects routed through the SessionView's
 *     event listener (see SessionView.onRuntimeEvent). The runtime
 *     itself only owns persistence — UI work is the view's job.
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
    const runtime = new SessionRuntime(
        sessionId,
        plugin.sessionManager,
        deriveArtifactStoreOptions(plugin.settings),
    );

    const chat = createChatAgent(plugin, {
        // No generation guard at the runtime layer; identity = runtime instance.
        generationMatches: () => true,
        getDynamicTools: () => buildDynamicTools(plugin, {
            hasContextCompressed: runtime.hasContextCompressed,
        }),
        // Surface the runtime's per-session artifact store to the chat
        // factory so the main agent's `recall_artifact` tool can be
        // bound to it. Returning the runtime's own field keeps the
        // store's lifetime perfectly aligned with the runtime.
        getArtifactStore: () => runtime.artifactStore,
        onStart: () => {
            runtime.markBusy();
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
                );
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
        onConfirmToolCall: (messageId: string) => {
            // Build a promise pinned to the runtime's pending map. The
            // chat awaits this promise; if no view is attached the
            // promise simply doesn't resolve until the user later
            // re-attaches and decides. This is the explicit, intended
            // back-pressure mechanism for background tool confirmation.
            return new Promise<boolean>((resolve) => {
                runtime.enqueueConfirmation(messageId, resolve);
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
