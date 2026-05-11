import { createOpenAICompletion } from "./providers/openai-provider";
import { createGeminiCompletion } from "./providers/gemini-provider";
import { ChatMessageRole, CompleteToolCall, MediaAttachment, MinimalModelConfig } from "./llm-provider";
import { safeSliceHead } from "../utils/string-safe";

// ─────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────
//
// Each of these can be overridden per call via `ContextReduceOptions`
// (see below) which is the path used by ChatStream to honour the active
// profile's `contextCompressionThreshold` / `slidingWindowSize` /
// `maxSummariesThreshold` settings. Values <= 0 in the override fall back
// to these built-in defaults — the same convention as `maxTokens: 0` on
// the profile.

/**
 * Token threshold that triggers context compression.
 * When the estimated token count of non-system messages exceeds this value,
 * the reducer will summarize older messages and keep recent ones.
 *
 * Sized for modern mainstream models (64k+ context windows). The actual
 * payload sent to the provider is roughly:
 *   threshold (history+summary) + ~2k (system prompt + tool schemas) + input
 * Plus an estimation drift of ~20% from `estimateTokens` being a coarse
 * char-based heuristic. So 32000 here corresponds to ~45k real tokens at the
 * upper bound — well within the 128k window of current flagship models, while
 * still leaving headroom for older 64k models. Profiles targeting 32k-or-less
 * windows should override this via per-profile config.
 */
const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 32000;

/**
 * Minimum number of most recent messages to retain after compression
 * (sliding window).
 *
 * Semantics: this is a **lower bound**, not an exact count. The real number
 * of retained messages can be larger because the split point is always
 * snapped backward to the nearest turn boundary (start of a `user` message),
 * so the entire final turn — including its tool_call / tool_result chain —
 * stays intact.
 *
 * Default of 10 is chosen to comfortably cover one typical tool-using turn
 * (user → assistant → tool_call → tool_result → …), which empirically runs
 * 3–10 messages. A smaller value risks "nothing to snap to" inside the
 * window and degenerates into no-compression.
 *
 * Only applies to non-system messages.
 */
const DEFAULT_SLIDING_WINDOW_SIZE = 10;

/**
 * Maximum number of summaries to retain before triggering second-level compression.
 * When total summaries exceed this value, all summaries are re-summarized into
 * a single higher-level summary.
 *
 * Raised in tandem with `DEFAULT_CONTEXT_COMPRESSION_THRESHOLD`: a larger
 * primary threshold means each Level-1 summary covers more conversation, so
 * triggering Level-2 ("summary of summaries", which is lossier) too eagerly
 * hurts recall. 8 lets the conversation accumulate substantially before a
 * second-order compression kicks in.
 */
const DEFAULT_MAX_SUMMARIES_THRESHOLD = 8;

interface PromptConfig {
    content: string;
}

/**
 * Per-call overrides for the reducer's tunables.
 *
 * Each numeric override is interpreted with the "<= 0 means use default"
 * convention used everywhere else in the plugin (see e.g. `maxTokens` on
 * the provider profile). This keeps the wire format on disk simple — the
 * settings UI persists `0` for "I don't care, follow the plugin default" so
 * a future bump to the built-in defaults takes effect for every existing
 * profile without forcing users to re-tune their numbers.
 */
export interface ContextReduceOptions {
    /** Override DEFAULT_CONTEXT_COMPRESSION_THRESHOLD. <=0 falls back to built-in default. */
    compressionThreshold?: number;
    /** Override DEFAULT_SLIDING_WINDOW_SIZE. <=0 falls back to built-in default. */
    slidingWindowSize?: number;
    /** Override DEFAULT_MAX_SUMMARIES_THRESHOLD. <=0 falls back to built-in default. */
    maxSummariesThreshold?: number;
    /**
     * Optional accessory token estimate to fold into the threshold check —
     * typically the size of tool-schema JSON. System messages are already
     * present in `rawMessages` (and counted into the threshold internally),
     * so this option is mainly for tool schemas which never enter
     * `rawMessages` but still consume the model's real prompt budget.
     */
    accessoryTokens?: number;
}

export interface HistoryMessage {
    role: ChatMessageRole;
    content: string;
    turn?: number;
    media?: MediaAttachment[];
    /** Optional message ID for tracking purposes (e.g., debugging summaries) */
    id?: string;
    /**
     * Thinking/reasoning text produced by the model on a previous turn.
     * Preserved through context reduction so that thinking-mode APIs
     * (e.g. DeepSeek, Qwen) receive the `reasoning_content` they require.
     */
    thinkingContent?: string;
    /**
     * For assistant messages: the structured tool calls emitted by the model.
     * Required for downstream providers to replay the tool-calling turn.
     */
    toolCalls?: CompleteToolCall[];
    /**
     * For tool_result messages: the id of the tool call this result responds to.
     * Used to pair tool_result with its owning assistant(toolCalls).
     */
    toolCallId?: string;
}

/**
 * @deprecated Use {@link HistoryMessage}. Kept as an alias because earlier
 * versions of this module exported the typo'd name.
 */
export type HistroyMessage = HistoryMessage;

/**
 * Represents a conversation summary with its metadata.
 * These are stored separately from the original messages to keep the UI clean.
 */
export interface ConversationSummary {
    content: string;
    /** Summary level: 1 = first-level summary, 2 = summary of summaries, etc. */
    level: number;
    /** Timestamp when this summary was created */
    createdAt: number;
    /**
     * The index of the first message that was NOT summarized by this summary.
     * E.g., if lastMessageIndex = 20, this summary covers messages from 0 to 19.
     * Used to determine which messages are still raw (not yet summarized).
     */
    lastMessageIndex: number;
    /**
     * Redundant field: the message ID of the last message that was summarized.
     * Useful for manual debugging and tracing.
     */
    messageId?: string;
}

// ─────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────

/** Token threshold for shrinking a single tool result in historical messages. */
const TOOL_RESULT_COLLAPSE_THRESHOLD = 500;

/**
 * Rough token count estimation.
 * Uses a simple heuristic: ~4 characters per token for Latin text,
 * ~1.5 characters per token for CJK (Chinese/Japanese/Korean).
 * This is intentionally conservative — actual token counts may vary
 * by tokenizer, but the estimate is good enough for threshold comparison.
 */
export function estimateTokens(text: string): number {
    const cjkMatches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g);
    const cjkCount = cjkMatches ? cjkMatches.length : 0;
    const nonCjkCount = Math.max(0, text.length - cjkCount);
    return Math.ceil(cjkCount / 1.5 + nonCjkCount / 4);
}

/** Estimate total tokens for an array of messages. */
function estimateMessagesTokens(messages: HistoryMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(msg.content);
        if (msg.media?.length) {
            // Rough flat estimate per attachment. Image budget per OpenAI's
            // tile model averages ~170; audio/video/pdf vary widely so we use
            // the same flat factor as a placeholder until per-kind estimates
            // become a measurable problem.
            total += msg.media.length * 170;
        }
    }
    return total;
}

// ─────────────────────────────────────────────
// Tool result collapsing
// ─────────────────────────────────────────────

/**
 * Collapse a single tool call + result into a concise narrative summary line.
 *
 * The output is intentionally written as a human-readable, past-tense
 * narrative rather than anything that resembles a tool-call syntax. This
 * matters because long conversations may include many of these collapsed
 * lines in the assistant's chat history, and if they look like a callable
 * syntax (e.g. `[Tool: foo({...})]`) the model tends to imitate the style
 * and emit fake "tool calls" as plain text instead of using the real
 * function-calling channel. Phrasing them as past events of "what the
 * assistant previously did" makes it clear they are archival notes, not
 * a format to mimic.
 *
 * Strategy:
 * 1. Error results: kept verbatim (usually short and important for reasoning).
 * 2. Below threshold: full result is included.
 * 3. Structured JSON above threshold: extract key statistics.
 * 4. Plain text above threshold: keep first 200 chars + truncation note.
 *
 * @param toolName  Name of the tool that was called
 * @param rawArgs   Raw JSON string of the tool arguments
 * @param result    The full tool result string
 * @returns A narrative summary line describing the past tool invocation.
 */
function collapseToolResult(toolName: string, rawArgs: string, result: string): string {
    const tokens = estimateTokens(result);

    // Parse args for display (show abbreviated version)
    let argsDisplay: string;
    try {
        const parsed = JSON.parse(rawArgs) as unknown;
        // Show only the first 2 keys to keep it short
        const keys = Object.keys(parsed as object);
        const entries = keys.slice(0, 2).map(k => {
            const v = (parsed as Record<string, unknown>)[k];
            const vs = typeof v === 'string'
                ? (v.length > 30 ? `"${safeSliceHead(v, 30)}..."` : `"${v}"`)
                : JSON.stringify(v);
            return `${k}=${vs}`;
        });
        argsDisplay = entries.join(', ') + (keys.length > 2 ? ', ...' : '');
    } catch {
        argsDisplay = rawArgs.length > 60 ? safeSliceHead(rawArgs, 60) + '...' : rawArgs;
    }

    const head = argsDisplay
        ? `Earlier I called the \`${toolName}\` tool (with ${argsDisplay})`
        : `Earlier I called the \`${toolName}\` tool`;

    // Error results: always keep full text (usually short)
    if (result.startsWith('Error:')) {
        return `${head} and it returned an error: ${result}`;
    }

    // Below threshold: include full result in the summary
    if (tokens <= TOOL_RESULT_COLLAPSE_THRESHOLD) {
        return `${head} and it returned: ${result}`;
    }

    // Try to parse as JSON for structured summary
    try {
        const parsed = JSON.parse(result) as unknown;
        if (Array.isArray(parsed)) {
            return `${head}; it returned a JSON array of ${parsed.length} items (${result.length} chars total, omitted here).`;
        } else if (typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed);
            const keyPreview = keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', ...' : '');
            return `${head}; it returned a JSON object with keys {${keyPreview}} (${result.length} chars total, omitted here).`;
        }
    } catch {
        // Not JSON, fall through to plain text handling
    }

    // Plain text: keep first 200 chars
    const preview = safeSliceHead(result, 200).replace(/\n/g, ' ');
    return `${head}; it returned (truncated, original ${result.length} chars): ${preview}...`;
}

/**
 * Produce a compact replacement for a single oversized tool_result `content`.
 *
 * Used by {@link ContextReducer.shrinkLargeToolResults} to reduce the token
 * footprint of historical `tool_result` messages **without changing the
 * protocol shape**: the resulting string is still returned as the `content`
 * of a `tool_result` message, keeping `toolCallId` and the assistant→tool
 * pairing intact. This is deliberately different from
 * {@link collapseToolResult}, which produces a past-tense narrative line for
 * inclusion inside a synthetic assistant message during summarization.
 *
 * Rules mirror {@link collapseToolResult}'s strategy but the wording is
 * strictly meta (brackets + "truncated"/"omitted") so nothing in the output
 * looks like free-form assistant prose the model might imitate.
 */
function shrinkToolResultContent(result: string): string {
    // Error results: always keep full text (usually short and meaningful).
    if (result.startsWith('Error:')) return result;

    // Below threshold: keep the original content untouched.
    if (estimateTokens(result) <= TOOL_RESULT_COLLAPSE_THRESHOLD) return result;

    // Try to parse as JSON for a structured meta summary.
    try {
        const parsed = JSON.parse(result) as unknown;
        if (Array.isArray(parsed)) {
            return `[Tool result truncated: JSON array of ${parsed.length} items, ${result.length} chars total, original content omitted to save context budget.]`;
        } else if (typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed);
            const keyPreview = keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', ...' : '');
            return `[Tool result truncated: JSON object with keys {${keyPreview}}, ${result.length} chars total, original content omitted to save context budget.]`;
        }
    } catch {
        // Not JSON, fall through to plain text handling.
    }

    // Plain text: keep first 200 chars as a preview inside the meta wrapper.
    const preview = safeSliceHead(result, 200).replace(/\n/g, ' ');
    return `[Tool result truncated: original ${result.length} chars, preview: ${preview}...]`;
}

// ─────────────────────────────────────────────
// ContextReducer
// ─────────────────────────────────────────────

/**
 * Result of context reduction.
 * - messagesToSend: The message list to send to the LLM (may include summaries)
 * - newSummary: If compression happened, this contains the new summary to persist externally
 * - compressed: Whether any compression was performed
 * - lastMessageIndex: The index in rawMessages up to which has been summarized.
 *                     Only meaningful when compressed is true.
 */
export interface ContextReduceResult<T extends HistoryMessage> {
    messagesToSend: T[];
    newSummary: ConversationSummary | null;
    compressed: boolean;
    /** Index of the last message in rawMessages that is now covered by summaries */
    lastMessageIndex: number;
}

export class ContextReducer {
    /**
     * Build the message list to send to the LLM with hierarchical context compression.
     *
     * Key design:
     * - The original `rawMessages` is NEVER modified. It's used for UI display only.
     * - Summaries are stored separately and passed in via `existingSummaries`.
     * - Each summary tracks `lastMessageIndex` — the position in rawMessages where
     *   summarization stopped. Only messages AFTER this index are eligible for new summaries.
     *
     * @param rawMessages - Complete original messages (for UI display, not modified)
     * @param existingSummaries - Previously generated summaries (stored externally)
     * @returns Messages to send to LLM, plus any new summary that should be persisted
     */
    static async reduce<T extends HistoryMessage>(
        modelConfig: MinimalModelConfig,
        prompt: PromptConfig,
        rawMessages: T[],
        existingSummaries: ConversationSummary[] = [],
        options?: ContextReduceOptions,
    ): Promise<ContextReduceResult<T>> {
        // ── 0. Resolve effective tunables ─────────────────────────────────
        // Each option follows the "<=0 = use built-in default" convention so
        // the on-disk profile shape stays trivial (0 means "I don't care").
        const threshold = (options?.compressionThreshold && options.compressionThreshold > 0)
            ? options.compressionThreshold
            : DEFAULT_CONTEXT_COMPRESSION_THRESHOLD;
        const windowSize = (options?.slidingWindowSize && options.slidingWindowSize > 0)
            ? options.slidingWindowSize
            : DEFAULT_SLIDING_WINDOW_SIZE;
        const maxSummaries = (options?.maxSummariesThreshold && options.maxSummariesThreshold > 0)
            ? options.maxSummariesThreshold
            : DEFAULT_MAX_SUMMARIES_THRESHOLD;
        const accessoryTokens = options?.accessoryTokens && options.accessoryTokens > 0
            ? options.accessoryTokens
            : 0;

        // ── 1. Separate system messages (always preserved) ────────────────
        const systemMessages = rawMessages.filter(msg => msg.role === "system");
        const nonSystemMessages = rawMessages.filter(msg => msg.role !== "system");

        // ── 2. Find the starting point for new summarization ────────────
        // Only summarize messages that haven't been summarized yet.
        //
        // Primary anchor: the `messageId` recorded on the most-recent summary.
        // This is stable even if the message array is rebuilt (e.g. after a
        // session reload with newly-materialized tool_result messages that
        // shift positional indices). The old `lastMessageIndex` is kept as a
        // fallback for (a) summaries produced before `messageId` was
        // populated, and (b) defensive recovery when the id can no longer be
        // located (user deleted messages mid-conversation, etc.).
        let cutoffIndex = 0;
        if (existingSummaries.length > 0) {
            const lastSummary = existingSummaries.reduce(
                (a, b) => (a.lastMessageIndex >= b.lastMessageIndex ? a : b),
            );
            const anchorId = lastSummary.messageId;
            let resolvedByID = -1;
            if (anchorId) {
                const idx = nonSystemMessages.findIndex(m => m.id === anchorId);
                if (idx >= 0) {
                    // `lastMessageIndex` represents the first UN-summarized
                    // position; the anchor message IS summarized, so the new
                    // cutoff is one past it.
                    resolvedByID = idx + 1;
                }
            }
            if (resolvedByID >= 0) {
                cutoffIndex = resolvedByID;
                if (resolvedByID !== lastSummary.lastMessageIndex) {
                    console.debug("[ContextReducer] cutoff anchored by id (", anchorId,
                        ") →", resolvedByID, "(recorded index was", lastSummary.lastMessageIndex, ")");
                }
            } else {
                cutoffIndex = Math.max(...existingSummaries.map(s => s.lastMessageIndex));
                if (anchorId) {
                    console.warn("[ContextReducer] cutoff anchor id", anchorId,
                        "not found; falling back to recorded index", cutoffIndex);
                }
            }
            // Defensive clamp: the recorded index may point past the current
            // array length if messages were pruned externally.
            if (cutoffIndex > nonSystemMessages.length) cutoffIndex = nonSystemMessages.length;
            if (cutoffIndex < 0) cutoffIndex = 0;
        }

        // Get only the non-system messages that are AFTER the cutoff
        const unsummarizedMessages = nonSystemMessages.slice(cutoffIndex);

        // ── 3. Estimate tokens ─────────────────────────────────────────────
        const systemTokens = estimateMessagesTokens(systemMessages);
        const unsummarizedTokens = estimateMessagesTokens(unsummarizedMessages);
        const summaryTokens = existingSummaries.reduce((sum, s) => sum + estimateTokens(s.content), 0);

        // ── 4. Decide whether compression is needed ───────────────────────
        // The threshold is checked against an **approximation of the real
        // payload** sent to the LLM:
        //   - system messages (prompt + skills, persistent overhead)
        //   - the unsummarized tail (the actual conversation tail we will
        //     forward verbatim)
        //   - existing summaries (assistant messages we will replay)
        //   - accessoryTokens supplied by the caller, typically the JSON
        //     size of tool schemas which never enter `rawMessages`.
        // Without `systemTokens + accessoryTokens` the threshold drifts
        // from what the provider actually receives and we either compress
        // way too late (small windows) or way too eagerly (large windows).
        const effectiveTokens = systemTokens + unsummarizedTokens + summaryTokens + accessoryTokens;

        // Two independent triggers:
        //   - `overThreshold`  → the conversation is genuinely large enough
        //                        that we should fold older history into a
        //                        Level-1 summary;
        //   - `needsLevel2`    → summaries themselves have piled up to the
        //                        point that the next compression pass should
        //                        merge them into a Level-2+ summary instead
        //                        of producing yet another peer Level-1 entry.
        // Previously `needsLevel2` was only inspected when `overThreshold`
        // was already true, which meant a long-running session with a large
        // threshold could accumulate dozens of Level-1 summaries forever
        // without ever triggering Level-2. Splitting the two conditions
        // here fixes that slow leak.
        const overThreshold = effectiveTokens > threshold;
        const needsLevel2 = existingSummaries.length >= maxSummaries;

        if (!overThreshold && !needsLevel2) {
            // console.log(`ContextReducer: No compression needed (effective tokens: ${effectiveTokens}, threshold: ${threshold})`);
            // No new compression needed - send summaries + unsummarized messages
            // (skip the raw messages that are already covered by existing summaries)
            const summaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));

            // Build archive note if there are summaries (meaning some messages are archived)
            const archiveNoteMessages: HistoryMessage[] = existingSummaries.length > 0 ? [{
                role: "assistant" as ChatMessageRole,
                content: `[Note: ${cutoffIndex} previous turns archived. Use \`retrieve_chat_history\` tool for details.]`,
            }] : [];

            // When we have existing summaries, the "unsummarized" slice may
            // start mid-turn (e.g. on a tool_result) because the cutoff was
            // anchored on an arbitrary message. Snap it forward to the next
            // turn boundary so the LLM always sees complete turns.
            const snapped = existingSummaries.length > 0
                ? this.sliceFromNextTurnBoundary(unsummarizedMessages)
                : unsummarizedMessages;

            // No compression needed - but if there are existing summaries, context IS compressed
            // Shrink oversized tool_result payloads while keeping the
            // assistant(toolCalls) ↔ tool_result structure intact.
            const shrunkUnsummarized = this.shrinkLargeToolResults(snapped);
            // Ensure tool message sequence integrity in the final messagesToSend
            const finalMessagesToSend = [
                ...systemMessages,
                ...summaryMessages,
                ...archiveNoteMessages,
                ...this.ensureToolSequenceIntegrity(shrunkUnsummarized),
            ] as T[];

            const sanitizedNoCompress = this.validateAndSanitizeForLLM(finalMessagesToSend);
            ContextReducer.checkFinalBudget(sanitizedNoCompress, accessoryTokens, threshold);
            return {
                messagesToSend: sanitizedNoCompress,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
            };
        }

        // ── 5. Determine what to compress ──────────────────────────────────
        let messagesToSummarize: HistoryMessage[];
        let newSummaryLevel: number;

        if (existingSummaries.length >= maxSummaries) {
            // ── Level 2+: Summarize the existing summaries ─────────────────
            messagesToSummarize = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));
            newSummaryLevel = (existingSummaries[0]?.level ?? 1) + 1;
        } else {
            // ── Level 1: Summarize unsummarized messages ────────────────────
            messagesToSummarize = unsummarizedMessages;
            newSummaryLevel = 1;
        }

        // ── 6. Split into old (to summarize) and recent (sliding window) ─
        // Two strategies depending on which level we are producing:
        //   * Level 1: the input is the raw conversation — we snap backward
        //     to a turn boundary so the recent window always starts at a
        //     `user` message and the final turn (with its tool chain) is
        //     preserved intact.
        //   * Level 2+: the input is entirely synthetic assistant messages
        //     (previous summaries). There are no "turns" or tool chains, so
        //     we simply summarize ALL of them into one higher-level summary
        //     and keep nothing in the recent window.
        let splitIndex: number;
        if (newSummaryLevel === 1) {
            const turnBoundaries = this.findTurnBoundaries(messagesToSummarize);
            splitIndex = Math.max(0, messagesToSummarize.length - windowSize);
            if (splitIndex > 0) {
                let snappedIndex = 0;
                for (const boundary of turnBoundaries) {
                    if (boundary <= splitIndex) snappedIndex = boundary;
                    else break;
                }
                splitIndex = snappedIndex;
            }
        } else {
            // Level 2+ — summarize all existing summaries.
            splitIndex = messagesToSummarize.length;
        }

        // Edge case: if all messages fit in the window, no need to summarize
        if (splitIndex === 0) {
            // console.log("ContextReducer: All messages fit within sliding window, no compression needed");
            // Convert existingSummaries to message format for LLM
            const summaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));
            // All messages fit in window - but if there are existing summaries, context IS compressed
            const assembled = [
                ...systemMessages,
                ...summaryMessages,
                ...messagesToSummarize,
            ] as T[];
            const sanitizedFitsWindow = this.validateAndSanitizeForLLM(assembled);
            ContextReducer.checkFinalBudget(sanitizedFitsWindow, accessoryTokens, threshold);
            return {
                messagesToSend: sanitizedFitsWindow,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
            };
        }

        // Feed the raw old messages to the summarizer. `summarizeConversation`
        // internally calls `collapseToolMessagesForSummary` to fold the tool
        // chains into narrative assistant messages before summarizing, so we
        // must NOT pre-collapse here (doing so would either double-wrap or
        // destroy the toolCalls metadata that collapseToolMessagesForSummary
        // relies on).
        const oldMessages = messagesToSummarize.slice(0, splitIndex);
        const recentMessages = messagesToSummarize.slice(splitIndex);

        // ── 7. Calculate the message index for the new summary ─────────────
        // For Level 1: the new summary covers up to (cutoffIndex + splitIndex)
        // For Level 2+: the new summary covers all existing summaries
        const newSummaryLastIndex = newSummaryLevel === 1
            ? cutoffIndex + splitIndex
            : nonSystemMessages.length; // Level 2+ means we're summarizing summaries

        // ── 8. Get the message ID of the last summarized message ──────────
        // For Level 1: last message in oldMessages (before split)
        // For Level 2+: last existing summary's messageId
        let lastSummarizedMessageId: string | undefined;
        if (newSummaryLevel === 1) {
            const lastMsg = oldMessages[oldMessages.length - 1];
            lastSummarizedMessageId = lastMsg?.id;
        } else {
            // For Level 2+, use the last existing summary's messageId
            const lastSummary = existingSummaries[existingSummaries.length - 1];
            lastSummarizedMessageId = lastSummary?.messageId;
        }

        // ── 9. Generate summary via LLM ─────────────────────────────────────
        // ── 9a. Determine prefix based on summary level ───────────────────
        const summaryPrefix = newSummaryLevel === 1
            ? "[Conversation Summary]\n"
            : `[Summary of Previous Summaries (Level ${newSummaryLevel})]\n`;

        const summaryContent = await summarizeConversation(modelConfig, prompt, oldMessages, newSummaryLevel);

        // ── 9b. Summary generation failed — degrade to "no compression" ───
        // A null return means the summarizer threw; inserting an empty assistant
        // message would be rejected by some OpenAI-compatible gateways. We fall
        // back to sending the raw (non-compressed) context this turn and let the
        // next turn try again.
        if (summaryContent === null) {
            console.warn("[ContextReducer] summarizeConversation returned null; degrading to no-compression for this turn");
            const fallbackSummaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));
            const fallbackArchiveNote: HistoryMessage[] = existingSummaries.length > 0 ? [{
                role: "assistant" as ChatMessageRole,
                content: `[Note: ${cutoffIndex} previous turns archived. Use \`retrieve_chat_history\` tool for details.]`,
            }] : [];
            const fallbackShrunk = this.shrinkLargeToolResults(unsummarizedMessages);
            const fallbackAssembled = [
                ...systemMessages,
                ...fallbackSummaryMessages,
                ...fallbackArchiveNote,
                ...this.ensureToolSequenceIntegrity(fallbackShrunk),
            ] as T[];
            const sanitizedFallback = this.validateAndSanitizeForLLM(fallbackAssembled);
            ContextReducer.checkFinalBudget(sanitizedFallback, accessoryTokens, threshold);
            return {
                messagesToSend: sanitizedFallback,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
            };
        }

        // ── 10. Create new summary to persist ──────────────────────────────
        // Store content WITH prefix so future reduces get it automatically
        const newSummary: ConversationSummary = {
            content: summaryPrefix + summaryContent,
            level: newSummaryLevel,
            createdAt: Date.now(),
            lastMessageIndex: newSummaryLastIndex,
            messageId: lastSummarizedMessageId,
        };

        // ── 11. Build messages to send to LLM ────────────────────────────────
        // existingSummaries already contain prefix in their content
        const summaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
            role: "assistant" as ChatMessageRole,
            content: s.content,
        }));

        const latestSummaryMessage: HistoryMessage = {
            role: "assistant",
            content: newSummary.content, // already has prefix
        };

        // Determine what "recent" messages to keep
        // For Level 1: keep the messages after splitIndex (relative to unsummarizedMessages)
        // For Level 2+: recentMessages are from summaries, keep all
        const keptRecentMessages = newSummaryLevel === 1
            ? recentMessages
            : recentMessages;

        // Build archive note: inform LLM about archived messages before summaries
        const archiveNoteMessage: HistoryMessage = {
            role: "assistant" as ChatMessageRole,
            content: `[Note: previous turns are archived. Use \`retrieve_chat_history\` tool for details.]`,
        };

        // Ensure tool message sequence integrity in the final messagesToSend
        const finalMessagesToSend = [
            ...systemMessages,
            ...summaryMessages,
            latestSummaryMessage as T,
            archiveNoteMessage,
            ...this.ensureToolSequenceIntegrity(keptRecentMessages),
        ] as T[];

        const sanitizedCompressed = this.validateAndSanitizeForLLM(finalMessagesToSend);
        ContextReducer.checkFinalBudget(sanitizedCompressed, accessoryTokens, threshold);
        return {
            messagesToSend: sanitizedCompressed,
            newSummary,
            compressed: true,
            lastMessageIndex: newSummaryLastIndex,
        };
        }

    /**
     * Observability hook — emit a `console.warn` when the assembled
     * `messagesToSend` clearly exceeds the configured threshold even after
     * compression. This is a soft signal: we deliberately do **not** retrigger
     * a second summarization pass here because (a) it would double the
     * latency of a turn that is already over budget, and (b) the provider
     * already errors out cleanly when the prompt is too large for the model
     * window. The warning is meant for the user / developer to notice that
     * the configured threshold is too high for the model in use, and lower
     * it (or upgrade the model) accordingly.
     *
     * Uses a 1.5× multiplier as the "obviously over" line so we don't spam
     * warnings on the normal case where the post-compression payload sits
     * just slightly above the threshold (which is expected — the threshold
     * is the trigger point, not a hard budget).
     */
    private static checkFinalBudget<T extends HistoryMessage>(
        messages: T[],
        accessoryTokens: number,
        threshold: number,
    ): void {
        const total = estimateMessagesTokens(messages) + accessoryTokens;
        if (total > threshold * 1.5) {
            console.warn(
                `[ContextReducer] final messagesToSend estimate ${total} tokens exceeds 1.5x threshold ${threshold}. ` +
                `Consider lowering the threshold or upgrading to a larger-context model.`,
            );
        }
    }

    /**
     * End-to-end validation & sanitization of the final messages list sent to the LLM.
     *
     * Unlike `ensureToolSequenceIntegrity` which only inspects a local slice before
     * concatenation, this runs on the fully-assembled message array (system messages,
     * historical summaries, archive notes, and recent messages all combined) so it
     * can catch orphan tool_results that were introduced by the assembly itself
     * (e.g. a synthetic summary `assistant` message sitting immediately before a
     * `tool_result`).
     *
     * Rules enforced (see docs/context-compression-fix-plan.md §4.1):
     *  1. Tool pairing: each `assistant(toolCalls)` must be followed by N matching
     *     `tool_result` messages. Trailing missing results cause the assistant to
     *     degrade to content-only (or be dropped if it would be empty). Middle
     *     missing results get a synthetic placeholder tool_result.
     *  2. Every `tool_result` must have a directly-preceding `assistant(toolCalls)`
     *     (separated only by other tool_results). Otherwise it is an orphan and
     *     dropped.
     *  3. `assistant` messages with empty content, no toolCalls and no
     *     thinkingContent are dropped (some gateways reject them outright).
     *  4. The first non-system message may not be a `tool_result`.
     *
     * The method returns a new array; the input is never mutated.
     */
    private static validateAndSanitizeForLLM<T extends HistoryMessage>(messages: T[]): T[] {
        if (messages.length === 0) return messages;

        // Debug: dump the assembled sequence before sanitization so any
        // subsequent 400 can be correlated with the exact layout we produced.
        try {
            const summary = messages.map((m, idx) => {
                const tc = m.toolCalls;
                const tcIds = tc && tc.length > 0 ? tc.map((c) => c.id).join(",") : "";
                const tcId = m.toolCallId;
                const len = typeof m.content === "string" ? m.content.length : 0;
                return `[${idx}] ${m.role}${tcIds ? ` toolCalls=${tcIds}` : ""}${tcId ? ` toolCallId=${tcId}` : ""} len=${len}`;
            }).join("\n");
            console.debug("[ContextReducer] validate: pre-sanitize sequence\n" + summary);
        } catch { /* noop */ }

        // Pass 1 \u2014 drop empty assistant messages & leading orphan tool_results,        // and drop any tool_result whose owning assistant(toolCalls) is not the
        // nearest non-tool_result predecessor.
        const pass1: T[] = [];
        let sawNonSystem = false;
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]!;

            if (msg.role === "system") {
                pass1.push(msg);
                continue;
            }

            // Drop empty assistant messages that carry no useful payload.
            if (msg.role === "assistant") {
                const toolCalls = msg.toolCalls;
                const hasContent = typeof msg.content === "string" && msg.content.length > 0;
                const hasThinking = typeof msg.thinkingContent === "string" && msg.thinkingContent.length > 0;
                const hasToolCalls = !!(toolCalls && toolCalls.length > 0);
                if (!hasContent && !hasThinking && !hasToolCalls) {
                    console.warn("[ContextReducer] validate: dropping empty assistant message at index", i);
                    continue;
                }
            }

            if (msg.role === "tool_result") {
                // First non-system message must not be a tool_result.
                if (!sawNonSystem) {
                    console.warn("[ContextReducer] validate: dropping leading orphan tool_result");
                    continue;
                }
                // Find the nearest non-tool_result predecessor already accepted.
                let ownerIdx = pass1.length - 1;
                while (ownerIdx >= 0 && pass1[ownerIdx]!.role === "tool_result") {
                    ownerIdx--;
                }
                const owner = ownerIdx >= 0 ? pass1[ownerIdx] : undefined;
                const ownerToolCalls = owner && owner.role === "assistant"
                    ? owner.toolCalls
                    : undefined;
                const tcId = msg.toolCallId;
                if (!owner || owner.role !== "assistant" || !ownerToolCalls || ownerToolCalls.length === 0
                    || !tcId || !ownerToolCalls.some((tc) => tc.id === tcId)) {
                    console.warn("[ContextReducer] validate: dropping orphan tool_result (toolCallId=", tcId, ")");
                    continue;
                }
            }

            pass1.push(msg);
            sawNonSystem = true;
        }

        // Pass 2 — for each assistant(toolCalls), verify all required tool_results
        // are present. Fill missing middle ones with a placeholder; trim a trailing
        // assistant(toolCalls) that has NO results at all (or degrade it to
        // content-only if it has usable content).
        const pass2: T[] = [];
        for (let i = 0; i < pass1.length; i++) {
            const msg = pass1[i]!;
            pass2.push(msg);

            if (msg.role !== "assistant") continue;
            const toolCalls = msg.toolCalls;
            if (!toolCalls || toolCalls.length === 0) continue;

            // Collect immediately-following tool_results.
            const gathered = new Map<string, T>();
            let j = i + 1;
            while (j < pass1.length && pass1[j]!.role === "tool_result") {
                const tcId = pass1[j]!.toolCallId;
                if (tcId) gathered.set(tcId, pass1[j]!);
                j++;
            }

            const missing = toolCalls.filter((tc) => !gathered.has(tc.id));
            const isTrailing = j >= pass1.length; // no message follows the (incomplete) sequence

            if (missing.length === 0) continue;

            if (isTrailing) {
                // Trailing assistant(toolCalls) without results → degrade to content-only or drop.
                const hasContent = typeof msg.content === "string" && msg.content.length > 0;
                const hasThinking = typeof msg.thinkingContent === "string" && msg.thinkingContent.length > 0;
                // Drop the already-pushed message; we will re-push the degraded form if useful.
                pass2.pop();
                // Also drop any partial tool_results we just gathered — they are orphans now.
                for (let k = i + 1; k < j; k++) {
                    // Nothing to drop from pass2 (we only pushed `msg`). Skip in the outer loop below.
                }
                if (hasContent || hasThinking) {
                    // Strip toolCalls so downstream providers don't try to pair them.
                    const { toolCalls: _droppedToolCalls, ...rest } = msg;
                    void _droppedToolCalls;
                    pass2.push(rest as T);
                    console.warn("[ContextReducer] validate: trailing assistant(toolCalls) missing results — degraded to content-only");
                } else {
                    console.warn("[ContextReducer] validate: trailing assistant(toolCalls) missing results and no content — dropped");
                }
                // Skip over the partial tool_results we already consumed.
                i = j - 1;
                continue;
            }

            // Middle gap → insert placeholder tool_results for each missing id,
            // ordered after the present ones to preserve a stable layout.
            for (let k = i + 1; k < j; k++) {
                pass2.push(pass1[k]!);
            }
            for (const mc of missing) {
                const placeholder = {
                    role: "tool_result",
                    content: "[Error: tool result missing after context compression]",
                    toolCallId: mc.id,
                } as unknown as T;
                pass2.push(placeholder);
                console.warn("[ContextReducer] validate: inserted placeholder tool_result for missing id=", mc.id);
            }
            i = j - 1; // skip consumed results
        }

        return pass2;
    }

    /**
     * Shrink the `content` of oversized `tool_result` messages while preserving
     * the protocol structure (role, toolCallId, assistant→tool pairing).
     *
     * Rationale — earlier versions of this module used to **collapse** the
     * entire assistant(toolCalls) + tool_result chain into a single
     * narrative `assistant` message. That saved tokens but also fed the
     * model out-of-distribution input: the recap lines ("Earlier I called
     * the `foo` tool …") looked enough like a callable syntax that some
     * models started emitting fake "tool calls" as plain text instead of
     * going through the real function-calling channel. The fix there was a
     * long "note to myself" disclaimer, which is a clear smell.
     *
     * This method keeps the structure intact — every assistant(toolCalls) is
     * still followed by its matching tool_result messages with the same ids
     * — and only rewrites the payload of individual `tool_result` messages
     * whose content would otherwise bloat the context (e.g. large
     * `retrieve_chat_history` / file read / search results). Replacement
     * content is a short bracketed `[Tool result truncated: ...]` string
     * which is unambiguously meta.
     *
     * **"Last unconsumed tool_result chain" exemption** — A `tool_result`'s
     * lifecycle has two stages:
     *   1. just produced, not yet digested by any subsequent assistant turn;
     *   2. already followed by an assistant message (text reply OR a new
     *      tool_call) — meaning the LLM has had at least one chance to read
     *      it and react to it.
     * Stage-1 results MUST stay intact: shrinking them before the LLM ever
     * sees them defeats the entire purpose of the tool call (most painfully
     * visible when a sub-agent like `delegate_task` returns a multi-thousand-
     * token digest that is the *whole point* of the call). Stage-2 results
     * are fair game — by the time the next compression pass runs, the
     * relevant signal is already in the assistant's text output.
     *
     * Concretely: locate the index of the **last** `assistant` message in
     * the array. Any `tool_result` strictly after that index belongs to the
     * still-unconsumed tail and is passed through verbatim. All other
     * tool_results follow the regular size-based shrinking rules.
     *
     * This method does NOT modify the input array; it returns a new array
     * (new message objects are only created for the messages that actually
     * get rewritten — others are passed through by reference).
     */
    private static shrinkLargeToolResults<T extends HistoryMessage>(messages: T[]): T[] {
        if (messages.length === 0) return messages;

        // Locate the index of the last assistant message — anything after it
        // is part of the "just-produced, not yet digested" tail.
        // -1 means there is no assistant message at all in this slice; the
        // condition `i > lastAssistantIdx` then evaluates to true for every
        // tool_result, so the entire slice is treated as unconsumed and
        // nothing gets shrunk. This is the safe default — without an
        // assistant anchor we cannot prove the model has read anything yet.
        let lastAssistantIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]!.role === 'assistant') {
                lastAssistantIdx = i;
                break;
            }
        }

        const result: T[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]!;
            if (msg.role === 'tool_result' && typeof msg.content === 'string' && msg.content.length > 0) {
                // Exempt the unconsumed tail: tool_results after the last
                // assistant haven't been read by the model yet.
                if (i > lastAssistantIdx) {
                    result.push(msg);
                    continue;
                }
                const shrunk = shrinkToolResultContent(msg.content);
                if (shrunk !== msg.content) {
                    result.push({ ...msg, content: shrunk } as T);
                    continue;
                }
            }
            result.push(msg);
        }
        return result;
    }

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
    static collapseToolMessagesForSummary<T extends HistoryMessage>(messages: T[]): T[] {
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

                let j = i + 1;
                while (j < messages.length && messages[j]!.role === 'tool_result') {
                    const resultMsg = messages[j]!;
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
                    j++;
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

    /**
     * Find turn boundaries in a message array.
     * A turn starts at a "user" message and includes all subsequent
     * assistant/tool_call/tool_result messages until the next "user" message.
     * Returns an array of indices where each turn starts.
     */
    private static findTurnBoundaries(messages: HistoryMessage[]): number[] {
        const boundaries: number[] = [0]; // First message is always a boundary
        for (let i = 1; i < messages.length; i++) {
            if (messages[i]!.role === 'user') {
                boundaries.push(i);
            }
        }
        return boundaries;
    }

    /**
     * Return the slice of `messages` starting at the first `user` message.
     *
     * Used by the "have-summaries-but-no-compression-needed" branch so the
     * messages sent to the LLM after the summary blocks always begin at a
     * turn boundary. Falls back to the original array when no `user`
     * message is present (rare, but e.g. if the anchor shifted past the end).
     */
    private static sliceFromNextTurnBoundary<T extends HistoryMessage>(messages: T[]): T[] {
        for (let i = 0; i < messages.length; i++) {
            if (messages[i]!.role === "user") {
                if (i > 0) {
                    console.debug("[ContextReducer] sliceFromNextTurnBoundary: dropped", i,
                        "leading non-user messages to align with turn boundary");
                }
                return messages.slice(i);
            }
        }
        return messages;
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
    private static ensureToolSequenceIntegrity<T extends HistoryMessage>(messages: T[]): T[] {
        if (messages.length === 0) return messages;

        // Find the first valid starting point:
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
                console.warn(`ContextReducer: Dropping orphaned ${msg.role} message at index ${i}`);
                continue;
            } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
                // An assistant message with tool_calls at the very start:
                // Check if all required tool_results follow
                const toolCalls = msg.toolCalls;
                const requiredIds = new Set(toolCalls.map(tc => tc.id));
                for (let j = i + 1; j < messages.length && j <= i + toolCalls.length; j++) {
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
                    console.warn('ContextReducer: Dropping assistant message with incomplete tool_results');
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
                // Check subsequent messages for matching tool_results
                for (let j = i + 1; j < result.length; j++) {
                    const next = result[j];
                    if (next?.role === 'tool_result' && next.toolCallId) {
                        requiredIds.delete(next.toolCallId);
                    } else {
                        break; // Stop at first non-tool_result message
                    }
                }
                if (requiredIds.size > 0) {
                    // Incomplete tool_results - truncate from this point
                    console.warn('ContextReducer: Truncating incomplete tool call sequence at end');
                    return result.slice(0, i);
                }
                break; // Only need to check the last assistant-with-toolCalls
            }
        }

        return result;
    }
    }

/**
 * Simple single-turn non-streaming chat completion.
 * Used for lightweight tasks like context summarization where streaming is unnecessary.
 *
 * @param modelConfig API config including provider type
 * @param inputMessages Messages to send to the LLM
 * @returns The assistant's reply content
 */export function createChatCompletion(modelConfig: MinimalModelConfig, inputMessages: { role: string, content: string }[]): Promise<string> {
    const providerType = modelConfig.type;
    switch (providerType) {
        case "openai":
            return createOpenAICompletion(
                { baseURL: modelConfig.baseURL, apiKey: modelConfig.apiKey, model: modelConfig.model },
                inputMessages,
            );
        case "gemini":
            return createGeminiCompletion(
                { apiKey: modelConfig.apiKey, model: modelConfig.model },
                inputMessages,
            );
        default:
            throw new Error(`Unknown provider type: ${String(providerType)}`);
    }
}

/**
 * Send old messages to the summarizer and return a concise summary string.
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
    level: number = 1
): Promise<string | null> {
    let userInstruction: string;

    if (level === 1) {
        userInstruction = "Please summarize the conversation above, preserving key information, decisions, and important context. Output ONLY the summary content itself — do NOT include any prefix, label, heading, or meta-commentary such as 'Conversation summary:', 'Summary:', or similar.";
    } else {
        userInstruction = `These are ${level - 1 > 1 ? `Level ${level - 1} summaries` : 'summaries'} of previous conversations. Please create a higher-level summary that consolidates the key themes and information across all summaries. Preserve all important details, decisions, and context. Output ONLY the summary content itself — do NOT include any prefix, label, heading, or meta-commentary such as 'Summary of summaries:' or similar.`;
    }

    // Collapse tool call sequences into assistant messages BEFORE filtering,
    // so that tool call information is preserved in the summary.
    // Without this, the filter below would discard all tool_call/tool_result messages,
    // causing the summary to lose all tool interaction context.
    const collapsedMessages = ContextReducer.collapseToolMessagesForSummary(messages);

    // Build the summarizer request: system prompt + conversation to summarize
    const summarizerMessages = [
        { role: "system", content: prompt.content },
        ...(collapsedMessages.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content }))),
        { role: "user", content: userInstruction },
    ];

    try {
        // console.log(`[ContextReducer] Generating summary (level ${level}) for ${messages.length} messages...`);
        const summary = await createChatCompletion(modelConfig, summarizerMessages);

        // console.log(`[ContextReducer] Generated summary (level ${level}):`, summary);
        const trimmed = summary.trim();
        if (!trimmed) {
            console.warn("[ContextReducer] Summarizer returned empty content; treating as failure");
            return null;
        }
        return trimmed;
    } catch (e) {
        console.error("[ContextReducer] Summarization failed:", e);
        console.warn("[ContextReducer] Returning null to signal fallback (no-compression) to the caller");
        return null;
    }
}