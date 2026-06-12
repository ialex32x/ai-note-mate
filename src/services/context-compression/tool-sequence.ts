import type { HistoryMessage } from "./types";

/**
 * Exclusive end index of the `tool_result` run that belongs to the
 * assistant(toolCalls) at `assistantIndex` — i.e. the index of the next
 * `assistant` message, or `messages.length` if none follows.
 *
 * Why a shared helper: a tool-call turn is
 * `assistant(toolCalls) → tool_result* → (next assistant)`, but ChatStream
 * legitimately injects a synthetic `user(media)` message in the middle of
 * the `tool_result*` run (right after a media-returning tool_result, so the
 * LLM can perceive the bytes — see chat-stream where `mediaAttachment` is
 * unpacked). Any walk that stops at the *first non-`tool_result`* therefore
 * mis-partitions the batch around that user message and falsely reports the
 * trailing siblings as missing.
 *
 * Stopping at the next `assistant` is safe: a brand-new user turn cannot
 * appear before the assistant has answered the outstanding tool calls, so
 * the only non-`tool_result` messages inside the run are media injections.
 *
 * Centralised here so `validateAndSanitizeForLLM`, `ensureToolSequenceIntegrity`
 * and `collapseToolMessagesForSummary` share one definition instead of three
 * subtly-different walks (docs/context-compression-bug-report.md §2, Bug 3/4).
 */
export function toolResultRunEnd(messages: HistoryMessage[], assistantIndex: number): number {
    let j = assistantIndex + 1;
    while (j < messages.length && messages[j]!.role !== "assistant") j++;
    return j;
}

/**
 * Ensures that tool message sequences remain intact in the message list.
 * 
 * Rules enforced:
 * 1. A tool_result message must have a preceding assistant message with toolCalls
 *    (or a tool_call message in the internal format)
 * 2. An assistant message with toolCalls must be followed by corresponding tool_result messages
 * 
 * If the sequence is broken at the beginning of the list (due to sliding window),
 * the orphaned messages are dropped to prevent API validation errors.
 */
export function ensureToolSequenceIntegrity<T extends HistoryMessage>(messages: T[]): T[] {
    if (messages.length === 0) return messages;

    // Skip any leading messages that are part of an incomplete turn
    let startIndex = 0;
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;
        if (msg.role === 'user') {
            // A user message is always a valid starting point
            startIndex = i;
            break;
        } else if (msg.role === 'assistant' && !msg.toolCalls?.length) {
            // A plain assistant message (no tool calls) is also valid
            startIndex = i;
            break;
        } else if (msg.role === 'tool_result' || msg.role === 'tool_call') {
            // Orphaned tool messages at the start - skip them
            console.warn(`ContextCompressor: Dropping orphaned ${msg.role} message at index ${i}`);
            continue;
        } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
            // An assistant message with tool_calls at the very start:
            // Check if all required tool_results follow. Walk the whole
            // run (skipping any interleaved user(media) injection) instead
            // of a fixed `toolCalls.length` window, which a media message
            // would otherwise push the trailing sibling results out of.
            const toolCalls = msg.toolCalls;
            const requiredIds = new Set(toolCalls.map(tc => tc.id));
            const runEnd = toolResultRunEnd(messages, i);
            for (let j = i + 1; j < runEnd; j++) {
                const next = messages[j];
                if (next?.role === 'tool_result' && next.toolCallId) {
                    requiredIds.delete(next.toolCallId);
                }
            }
            if (requiredIds.size === 0) {
                // All tool results are present, this is a valid start
                startIndex = i;
                break;
            } else {
                // Missing tool results - skip this assistant message and its partial results
                console.warn('ContextCompressor: Dropping assistant message with incomplete tool_results');
                continue;
            }
        } else {
            startIndex = i;
            break;
        }
    }

    // Now validate from startIndex forward:
    // Check for trailing assistant messages with toolCalls that lack their tool_results
    const result = messages.slice(startIndex);
    
    // Validate from the end: if the last assistant message has toolCalls,
    // ensure all tool_results are present
    for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]!;
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
            const toolCalls = msg.toolCalls;
            const requiredIds = new Set(toolCalls.map(tc => tc.id));
            // Check subsequent messages for matching tool_results. Walk the
            // full run up to the next assistant so an interleaved
            // user(media) message does not prematurely stop the scan and
            // make us falsely truncate a complete batch (Bug 3).
            const runEnd = toolResultRunEnd(result, i);
            for (let j = i + 1; j < runEnd; j++) {
                const next = result[j];
                if (next?.role === 'tool_result' && next.toolCallId) {
                    requiredIds.delete(next.toolCallId);
                }
            }
            if (requiredIds.size > 0) {
                // Incomplete tool_results - truncate from this point
                console.warn('ContextCompressor: Truncating incomplete tool call sequence at end');
                return result.slice(0, i);
            }
            break; // Only need to check the last assistant-with-toolCalls
        }
    }

    return result;
}
