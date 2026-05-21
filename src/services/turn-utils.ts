/**
 * Small helpers for working with `ChatMessage` arrays — the in-memory
 * transcript exposed by every {@link IChatAgent}. Lives outside
 * `chat-stream.ts` to keep that file focused on the streaming pipeline.
 */

import type { ChatMessage } from './chat-stream';

/**
 * Walk back from the tail of the message log to find the most recent
 * NON-streaming assistant message and the user message that anchored
 * it (skipping intermediate tool calls / sub-agent traffic).
 *
 * Used by post-finish auxiliary passes (insight extraction, memory
 * extraction, prompt refinement) that all share the same anchoring
 * rule — "the last completed Q→A pair in the session".
 *
 * Filtering rules:
 *   - the assistant must have `streaming === false` so an in-flight
 *     reply never anchors a feature against partial content;
 *   - both messages must have non-empty `content` so degenerate
 *     placeholder entries don't surface as the "anchor".
 *
 * Aborted assistants are intentionally NOT filtered out here:
 *   - the post-finish callers only run on a successfully-finished
 *     turn so the tail is guaranteed clean;
 *   - older mid-conversation aborts are still useful as context
 *     anchors for refinement-style features.
 */
export function findTailTurn(messages: ReadonlyArray<ChatMessage>): {
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
