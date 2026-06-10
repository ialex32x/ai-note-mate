/**
 * Constants extracted from chat-stream.ts.
 *
 * Moved here to reduce chat-stream.ts line count (~24% reduction)
 * while keeping each constant easy to find and tune.
 */

/**
 * System prompt used to instruct the summarizer model.
 * Defined here as a constant for easy tuning.
 */
export const SUMMARIZER_SYSTEM_PROMPT = `\
You are a conversation summarization assistant.
Your task is to distill the key points from the conversation below into a concise summary.

Requirements:
- Preserve: key facts, decisions, user preferences, important context
- Omit: redundant details, examples, elaboration, and any meta-commentary
- Output: ONLY the raw summary text, without any prefix, label, or wrapper like "Summary:", "Here is the summary:", etc.
- Language: Match the language of the conversation
- Format: Plain text, preferrably 2-4 sentences
`;

/**
 * System prompt used for QuickAsk (追问) side-turn completions.
 * The model is instructed to answer a follow-up question about a specific
 * previous reply concisely, without re-answering the original question.
 */
export const QUICK_ASK_SYSTEM_PROMPT = `\
You are a helpful assistant answering a follow-up question about a previous response.

Context: the user is asking a follow-up question about a specific AI reply in a longer conversation.
Answer ONLY the follow-up question concisely. Do NOT re-answer the original question.
Keep your response focused and brief.`;

/** Appended to assistant API content when {@link ChatMessage.wasInterrupted} is set. */
export const INTERRUPTED_ASSISTANT_API_NOTE =
    '[Note: this assistant reply was interrupted before completion.]';

/**
 * Per-chunk throttle interval (ms) for streaming UI updates inside
 * {@link ChatStream._processStream}. When a provider emits stream
 * chunks faster than this (e.g. Gemini Flash, Groq, local llama.cpp
 * on a fast model can do hundreds per second), chunks arriving within
 * the same window have their `onMessageUpdate` emit coalesced — only
 * the most-recent state is forwarded downstream, the rest are dropped.
 *
 * Safe to drop intermediate emits because every emit carries the
 * *latest full snapshot* of `streamingMessage` (not a delta), and the
 * post-loop final emit unconditionally fires with the terminal state
 * — so no content is ever lost, and the on-screen "latest text" never
 * lags by more than one window.
 *
 * 30 ms sits well below the rendering controller's own 100 ms (or
 * 400 ms for large content) throttle, so this does NOT change the
 * on-screen update cadence. Its purpose is to cut the per-chunk
 * synchronous callback chain (runtime.emit → view.handleMessageUpdate
 * → bubble re-render dispatch → streaming-controller.update), which
 * fires for every chunk even when the next render is already pending.
 * On hot streams that chain was costing several milliseconds per
 * chunk × hundreds of chunks per second, fully saturating the main
 * thread before the renderer even got a turn.
 */
export const STREAM_EMIT_THROTTLE_MS = 30;
