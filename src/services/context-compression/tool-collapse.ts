import type { ChatMessageRole } from "../llm-provider";
import type { HistoryMessage } from "./types";
import { collapseToolResult } from "./envelope-shrink";
import { toolResultRunEnd } from "./tool-sequence";

/**
 * Collapse ALL tool call sequences into narrative assistant messages
 * **for summarizer input only**.
 *
 * Folds every `assistant(toolCalls) + tool_result*` chain into a single
 * synthetic assistant message whose content is a past-tense recap (see
 * {@link collapseToolResult}). This output is designed to be fed to
 * `summarizeConversation`'s summarizer LLM — it is NEVER returned to
 * the main chat LLM, because the recap style would otherwise tempt the
 * model into emitting fake tool calls as plain text. Within the main
 * chat path we use {@link shrinkLargeToolResults} instead, which keeps
 * the protocol structure intact.
 *
 * This is necessary because the summarizer filters messages down to
 * `role === 'user' | 'assistant'` only — without this pre-pass, all
 * tool_call / tool_result content would be silently dropped from the
 * summary input and the summary would lose the entire tool-interaction
 * history.
 */
export function collapseToolMessagesForSummary<T extends HistoryMessage>(messages: T[]): T[] {
    if (messages.length === 0) return messages;

    const result: T[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i]!;

        // Check if this is an assistant message with tool calls
        const toolCalls = msg.toolCalls;
        if (msg.role === 'assistant' && toolCalls && toolCalls.length > 0) {
            // Collect all tool_result messages that follow
            const toolCallIds = new Set(toolCalls.map(tc => tc.id));
            const collapsedParts: string[] = [];

            // If the assistant message has text content, preserve it
            if (msg.content && msg.content.trim()) {
                collapsedParts.push(msg.content.trim());
            }

            // Walk the whole tool-result run up to the next assistant,
            // skipping any interleaved synthetic user(media) message so its
            // sibling tool_results still make it into the summary (Bug 4).
            const runEnd = toolResultRunEnd(messages, i);
            let j = i + 1;
            for (; j < runEnd; j++) {
                const resultMsg = messages[j]!;
                if (resultMsg.role !== 'tool_result') continue;
                const resultToolCallId = resultMsg.toolCallId;

                if (resultToolCallId && toolCallIds.has(resultToolCallId)) {
                    // Find the matching tool call to get name and args
                    const matchingCall = toolCalls.find(tc => tc.id === resultToolCallId);
                    if (matchingCall) {
                        const summary = collapseToolResult(
                            matchingCall.function.name,
                            matchingCall.function.arguments,
                            resultMsg.content,
                        );
                        collapsedParts.push(summary);
                    }
                    toolCallIds.delete(resultToolCallId);
                }
            }

            // Create a collapsed assistant message replacing the entire sequence
            const collapsedContent = collapsedParts.join('\n');
            const collapsedMsg = {
                role: 'assistant' as ChatMessageRole,
                content: collapsedContent,
                id: msg.id,
                // Preserve thinkingContent so thinking-mode APIs receive
                // the reasoning_content they require on replay.
                ...(msg.thinkingContent ? { thinkingContent: msg.thinkingContent } : {}),
            } as T;
            result.push(collapsedMsg);
            i = j; // Skip past all consumed tool_result messages
        } else {
            result.push(msg);
            i++;
        }
    }

    return result;
}
