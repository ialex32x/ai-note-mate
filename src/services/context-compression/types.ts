import type { ChatMessageRole, CompleteToolCall, MediaAttachment } from "../llm-provider";
import type { ArtifactStore } from "../artifact-store";

export interface PromptConfig {
    content: string;
}

/**
 * Per-call overrides for the compressor's tunables.
 *
 * Each numeric override is interpreted with the "<= 0 means use default"
 * convention used everywhere else in the plugin (see e.g. `maxTokens` on
 * the provider profile). This keeps the wire format on disk simple — the
 * settings UI persists `0` for "I don't care, follow the plugin default" so
 * a future bump to the built-in defaults takes effect for every existing
 * profile without forcing users to re-tune their numbers.
 */
export interface ContextCompressionOptions {
    /** Override the default compression threshold. <=0 falls back to a computed
     * default proportional to the model's context window (~45%). */
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
    /**
     * Per-session artifact store used by the shrink stage to spill
     * historical delegate-envelope `result` / `extras` fields out of
     * the prompt (B-1, plan §1.5).
     *
     * When provided, an envelope tool_result that is large enough to
     * trigger shrinking is rewritten in place: each inline `result` /
     * `extras[k]` field above {@link ENVELOPE_FIELD_SPILL_MIN_BYTES}
     * is moved to the store and replaced with an {@link ArtifactRef}
     * in `payload.artifacts`. The envelope's `text`, discriminator
     * markers, `omitted`, and any pre-existing `artifacts` entries
     * (from E-3 build-time promotion) are kept verbatim. The
     * `tool_result.toolCallId` is still used as a gate for safety
     * (without it we cannot confirm the result belongs to a known
     * tool-call chain), but the artifact keys are now auto-generated
     * by the store itself.
     *
     * When omitted (or null), the compressor's behaviour is unchanged:
     * envelopes that exceed the shrink threshold get the same opaque
     * `[Tool result truncated: …]` replacement as any other oversized
     * tool_result. This is the path used by tests and by single-agent
     * mode (which never produces envelopes anyway).
     */
    artifactStore?: ArtifactStore | null;
    /**
     * Real-token context window of the target model, used by
     * {@link ContextCompressor.emergencyShrink} to compute an adaptive
     * emergency line: the shrink is triggered at
     * `min(threshold × 1.5, modelContextWindow × 0.85 / 1.2)`, so
     * small-window models (e.g. legacy GPT-3.5 16k, Llama-2 4k) get
     * the safety net **before** the prompt overflows even when the
     * user's threshold is set for a much larger model.
     *
     * Conventions:
     *   - Value is the model's **real** context window (not estimated
     *     `estimateTokens()` units); the compressor applies the standard
     *     ~1.2× drift factor internally.
     *   - `<= 0` / `undefined` falls back to the original "threshold
     *     × 1.5 only" rule. Useful for tests and ad-hoc callers that
     *     don't have model metadata handy.
     *   - Producers typically use the helper in
     *     `src/services/model-context-window.ts` to derive this from
     *     the profile's model identifier.
     */
    modelContextWindow?: number;
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
    /**
     * Token-budget view of {@link content} after {@link ContextCompressor.shrinkLargeToolResults}.
     * The full payload stays in `content` (UI / summarizer / persistence); this field
     * records what was (or will be) sent to the main chat LLM so threshold checks do not
     * re-count megabyte tool bodies on every agent loop iteration.
     *
     * Valid only together with {@link contentBudgetHintForLength}: when the live
     * `content.length` differs, the hint is treated as stale and ignored.
     */
    contentBudgetHint?: string;
    /** `content.length` at the time {@link contentBudgetHint} was recorded. */
    contentBudgetHintForLength?: number;
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

/**
 * Result of context reduction.
 * - messagesToSend: The message list to send to the LLM (may include summaries)
 * - newSummary: If compression happened, this contains the new summary to persist externally
 * - compressed: Whether any compression was performed
 * - lastMessageIndex: The index in rawMessages up to which has been summarized.
 *                     Only meaningful when compressed is true.
 * - emergencyShrunk: Whether the {@link ContextCompressor.emergencyShrink}
 *                    safety net actually rewrote any tool_result on this
 *                    turn. Surfaces upward so the caller can show a one-
 *                    shot Notice / event (the underlying content loss is
 *                    a user-perceivable trade-off, not a silent fix).
 */
export interface ContextCompressionResult<T extends HistoryMessage> {
    messagesToSend: T[];
    newSummary: ConversationSummary | null;
    /**
     * Full replacement set for the externally-stored summaries.
     *
     * Used by the Level-2+ merge path: when existing summaries are
     * consolidated into a single higher-level summary, the old summaries
     * must be **replaced** (not appended), otherwise they keep piling up in
     * the prompt and in storage forever (see
     * docs/context-compression-bug-report.md §2, Bug 1).
     *
     * Semantics for the caller:
     *   - non-null  → `summaries = summariesReplacement` (replace wholesale).
     *   - null/undefined → fall back to the append rule using `newSummary`.
     *
     * `newSummary` and `summariesReplacement` are mutually exclusive: the
     * Level-1 path sets `newSummary` (append), the Level-2+ path sets
     * `summariesReplacement` (replace) with `newSummary === null`.
     */
    summariesReplacement?: ConversationSummary[] | null;
    compressed: boolean;
    /** Index of the last message in rawMessages that is now covered by summaries */
    lastMessageIndex: number;
    /** True if emergency shrink force-collapsed the unconsumed tool tail to fit budget. */
    emergencyShrunk: boolean;
}
