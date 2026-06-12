import { createOpenAICompletion } from "../providers/openai-provider";
import { createGeminiCompletion } from "../providers/gemini-provider";
import { createAnthropicCompletion } from "../providers/anthropic-provider";
import type { MinimalModelConfig } from "../llm-provider";
import { isAbortError } from "../../utils/abortable-request";
import type { HistoryMessage, PromptConfig } from "./types";
import { collapseToolMessagesForSummary } from "./tool-collapse";

/**
 * Simple single-turn non-streaming chat completion.
 * Used for lightweight tasks like context summarization where streaming is unnecessary.
 *
 * @param modelConfig API config including provider type
 * @param inputMessages Messages to send to the LLM
 * @param signal Optional AbortSignal forwarded to the underlying provider
 *   SDK so the call can be interrupted mid-flight (e.g. when the user
 *   hits the global stop button during a long summarization round).
 *   Without this the surrounding `compress()` could block the abort
 *   response by 15–40 s on large contexts.
 * @returns The assistant's reply content
 */
export function createChatCompletion(
    modelConfig: MinimalModelConfig,
    inputMessages: { role: string, content: string }[],
    signal?: AbortSignal,
): Promise<string> {
    const providerType = modelConfig.type;
    switch (providerType) {
        case "openai":
            return createOpenAICompletion(
                { baseURL: modelConfig.baseURL, apiKey: modelConfig.apiKey, model: modelConfig.model },
                inputMessages,
                signal,
            );
        case "gemini":
            return createGeminiCompletion(
                { apiKey: modelConfig.apiKey, model: modelConfig.model },
                inputMessages,
                signal,
            );
        case "anthropic":
            return createAnthropicCompletion(
                { baseURL: modelConfig.baseURL, apiKey: modelConfig.apiKey, model: modelConfig.model },
                inputMessages,
                signal,
            );
        default:
            throw new Error(`Unknown provider type: ${String(providerType)}`);
    }
}

/**
 * Run the summarizer LLM and return its trimmed output, or null on
 * empty/failed responses. Aborts propagate to the caller.
 *
 * Shared low-level helper for both context-compression summaries and
 * title generation; centralizes the empty-response and abort handling
 * so the two public entry points stay focused on prompt construction.
 */
export async function runSummarizerLLM(
    modelConfig: MinimalModelConfig,
    summarizerMessages: { role: string; content: string }[],
    signal: AbortSignal | undefined,
    logTag: string,
): Promise<string | null> {
    try {
        const summary = await createChatCompletion(modelConfig, summarizerMessages, signal);
        const trimmed = summary.trim();
        if (!trimmed) {
            console.warn(`[ContextCompressor] ${logTag}: summarizer returned empty content; treating as failure`);
            return null;
        }
        return trimmed;
    } catch (e) {
        // User-initiated aborts must propagate, NOT degrade to the
        // "summarization failed → fallback" path — the whole turn is
        // being torn down, so silently returning null here would just
        // defer the abort response until the next aborted step trips
        // a check. Re-throw so the calling loop unwinds immediately.
        if (isAbortError(e)) throw e;
        console.error(`[ContextCompressor] ${logTag}: summarization failed:`, e);
        console.warn(`[ContextCompressor] ${logTag}: returning null to signal fallback to the caller`);
        return null;
    }
}

/**
 * Summarize old messages for **context compression** (internal pipeline).
 *
 * The output is consumed only by the summarizer LLM on subsequent turns,
 * never shown to the user, so we keep the original simple shape: system
 * prompt + conversation + trailing English user instruction. Recency
 * bias from the English trailing instruction is acceptable here because
 * the summary is not user-facing; what matters is that the model
 * actually executes the "summarize" instruction.
 *
 * @param modelConfig API config including provider type
 * @param prompt System prompt for the summarizer
 * @param messages Messages to summarize (can be raw messages or existing summaries)
 * @param level Summary level (1 = first-level summary of raw messages,
 *              2+ = summary of summaries)
 */
export async function summarizeConversation(
    modelConfig: MinimalModelConfig,
    prompt: PromptConfig,
    messages: HistoryMessage[],
    level: number = 1,
    signal?: AbortSignal,
): Promise<string | null> {
    const userInstruction = level === 1
        ? "Please summarize the conversation above, preserving key information, decisions, and important context. Output ONLY the summary content itself — do NOT include any prefix, label, heading, or meta-commentary such as 'Conversation summary:', 'Summary:', or similar."
        : `These are ${level - 1 > 1 ? `Level ${level - 1} summaries` : 'summaries'} of previous conversations. Please create a higher-level summary that consolidates the key themes and information across all summaries. Preserve all important details, decisions, and context. Output ONLY the summary content itself — do NOT include any prefix, label, heading, or meta-commentary such as 'Summary of summaries:' or similar.`;

    // Collapse tool call sequences into assistant messages BEFORE filtering,
    // so that tool call information is preserved in the summary.
    // Without this, the filter below would discard all tool_call/tool_result messages,
    // causing the summary to lose all tool interaction context.
    const collapsedMessages = collapseToolMessagesForSummary(messages);

    const summarizerMessages = [
        { role: "system", content: prompt.content },
        ...collapsedMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: userInstruction },
    ];

    return runSummarizerLLM(modelConfig, summarizerMessages, signal, `summarize(level ${level})`);
}

/**
 * Summarize a conversation into a short **session title** (user-facing).
 *
 * Differs from `summarizeConversation` in two important ways:
 *
 *   1. The full task framing lives entirely in the caller-provided
 *      system prompt (see `TITLE_SUMMARIZE_PROMPT`), NOT in a trailing
 *      user instruction. The output (title) is shown directly to the
 *      user, and an English trailing instruction containing words like
 *      "summarize" / "title" / "English" tends to bias the model toward
 *      generating English titles even when the conversation is in
 *      Chinese / Japanese / etc. System-prompt instructions sit further
 *      from the generation window and exert weaker recency pressure on
 *      output language. (This was historically a separate
 *      `titleInstruction` folded into the system message at runtime,
 *      but it duplicated the task framing already in
 *      `TITLE_SUMMARIZE_PROMPT` and created a hidden alignment burden;
 *      it has been merged into the prompt constant.)
 *
 *   2. Most LLM providers (OpenAI / Anthropic / Gemini) treat a
 *      sequence ending in an `assistant` message as "continue that
 *      turn" rather than "execute the system instruction". After a
 *      normal user→assistant exchange the conversation already ends in
 *      `assistant`, so we still need a trailing `user` message to flip
 *      the model back into "respond" mode. We use a deliberately
 *      neutral marker — no language hints, no implementation verbs —
 *      that just defers to the system prompt's rules.
 */
export async function summarizeConversationToTitle(
    modelConfig: MinimalModelConfig,
    prompt: PromptConfig,
    messages: HistoryMessage[],
    signal?: AbortSignal,
): Promise<string | null> {
    // Same tool-call collapsing as the context-compression path: keep
    // tool interaction context visible to the titler.
    const collapsedMessages = collapseToolMessagesForSummary(messages);

    // Neutral marker: no implementation-specific verbs
    // ("summarize"/"title"), no language hints ("English"/"Chinese"),
    // no ambiguous punctuation that would be parsed as a real
    // question. Reads literally as a request to produce output per the
    // system prompt above. Required because most providers treat an
    // assistant-terminated sequence as "continue", not "execute system
    // instruction" — see doc comment above.
    const NEUTRAL_TRAILING_MARKER = "(produce the output now, following the rules in the system message above)";

    const summarizerMessages = [
        { role: "system", content: prompt.content },
        ...collapsedMessages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: NEUTRAL_TRAILING_MARKER },
    ];

    return runSummarizerLLM(modelConfig, summarizerMessages, signal, 'title');
}
