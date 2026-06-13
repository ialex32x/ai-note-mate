import type { ChatMessageParam } from "../llm-provider";

/**
 * Last-line-of-defense sanitization of an outgoing chat-message array
 * before it is handed to a provider's native message-format converter.
 *
 * The {@link import("../context-compression").ContextCompressor} is supposed to
 * keep tool_call / tool_result pairs balanced and prune empty assistant
 * turns, but bugs there have historically surfaced as opaque provider
 * 400s ("messages: an assistant message with 'tool_calls' must be
 * followed by tool messages…"). This helper drops the two specific
 * shapes that every supported provider rejects, so a leak in the
 * reducer degrades to a console warning rather than a hard failure.
 *
 * Behaviour:
 *  - Drops `assistant` messages that have no content, no tool calls,
 *    and no thinking content (purely empty — would be a protocol error).
 *  - Drops `tool_result` messages whose `toolCallId` does not match any
 *    in-flight tool call from a preceding `assistant` message in this
 *    array. (Each `tool_result` consumes exactly one pending id; the
 *    leftover ids are tracked so duplicates also get pruned.)
 *  - Forwards every other message unchanged.
 *
 * Why duplicated previously: each provider used to ship its own copy
 * of this loop, which started drifting (different `console.warn` tags,
 * subtle ordering differences). Centralising here keeps the contract
 * uniform — when the reducer is fixed for one provider, every provider
 * benefits.
 *
 * @param messages   The raw message array assembled by ChatStream.
 * @param providerTag Short label used in the `console.warn` prefix so
 *   logs from concurrent providers stay distinguishable. Convention:
 *   the provider's source-file slug, e.g. `"openai-provider"`.
 *
 * @returns A new array containing only the messages that are safe to
 *   forward; the original array is not mutated.
 *
 * @see docs/context-compression-fix-plan.md §4.3
 */
export function sanitizeChatMessages(
    messages: ChatMessageParam[],
    providerTag: string,
): ChatMessageParam[] {
    const sanitized: ChatMessageParam[] = [];
    const pendingToolCallIds = new Set<string>();
    for (const m of messages) {
        if (m.role === "assistant") {
            const hasToolCalls = !!(m.toolCalls && m.toolCalls.length > 0);
            const hasContent = typeof m.content === "string" && m.content.length > 0;
            const hasThinking = typeof m.thinkingContent === "string"
                && m.thinkingContent.length > 0;
            if (!hasToolCalls && !hasContent && !hasThinking) {
                console.warn(`[${providerTag}] dropping empty assistant message`);
                continue;
            }
            if (hasToolCalls) {
                for (const tc of m.toolCalls!) pendingToolCallIds.add(tc.id);
            }
            sanitized.push(m);
            continue;
        }
        if (m.role === "tool_result") {
            const tcId = m.toolCallId;
            if (!tcId || !pendingToolCallIds.has(tcId)) {
                console.warn(`[${providerTag}] dropping orphan tool_result (toolCallId=`, tcId, ")");
                continue;
            }
            pendingToolCallIds.delete(tcId);
            sanitized.push(m);
            continue;
        }
        sanitized.push(m);
    }
    return sanitized;
}
