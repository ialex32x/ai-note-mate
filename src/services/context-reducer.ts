import { createOpenAICompletion } from "./providers/openai-provider";
import { createGeminiCompletion } from "./providers/gemini-provider";
import { ChatMessageRole, CompleteToolCall, MediaAttachment, MinimalModelConfig } from "./llm-provider";
import { safeSliceHead } from "../utils/string-safe";
import {
    DELEGATE_ENVELOPE_KIND,
    DELEGATE_ENVELOPE_VERSION,
    type ArtifactRef,
    type DelegatePayload,
} from "./delegate-envelope-shape";
import type { ArtifactStore } from "./artifact-store";

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
 * When the estimated token count of the effective payload (system + history
 * + summaries + tool schemas) exceeds this value, the reducer will summarize
 * older messages and keep recent ones.
 *
 * Sized for modern flagship models (128k+ context windows). Intentionally
 * **conservative** at ~45% of a 128k window so that:
 *   - tool-schema-heavy sessions still have room to grow before compression
 *     fires (a 10–15k schema budget eats meaningfully into the threshold);
 *   - TTFT and prompt-cache hit rates stay better than at higher thresholds
 *     (most providers' first-token latency scales gently with input size);
 *   - the {@link emergencyShrink} safety net at 1.5× threshold lands well
 *     inside the model window rather than at its edge.
 *
 * Reality calibration:
 *   - `estimateTokens` uses 4 chars/token for non-CJK, 1.5 for CJK; modern
 *     tokenizers come out 15–25% denser, so real tokens ≈ threshold × 1.2.
 *   - 48000 here ≈ ~57–60k real tokens, i.e. ~45% of a 128k window.
 *   - Add ~10k tool schemas + ~8k response budget and the no-compression
 *     ceiling is ~75–78k real tokens — leaves ~50k headroom on 128k models.
 *   - The 1.5× emergency line (72000 estimated ≈ ~86k real) is the point
 *     where `emergencyShrink` force-collapses every oversized tool_result,
 *     including the otherwise-exempt unconsumed tail.
 *
 * Verified comfortable on: DeepSeek-V3 (128k), GPT-4.1 (1M), Claude Sonnet
 * /Opus (200k), Gemini 2.x/3.x (1M+), Qwen3 (128k+), Kimi K2 (128k+).
 *
 * **Profiles targeting ≤64k context windows MUST override this downward**
 * via per-profile `contextCompressionThreshold`, otherwise compression
 * fires too late or the assembled prompt may exceed the model window.
 */
const DEFAULT_CONTEXT_COMPRESSION_THRESHOLD = 48000;

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
     * When omitted (or null), the reducer's behaviour is unchanged:
     * envelopes that exceed the shrink threshold get the same opaque
     * `[Tool result truncated: …]` replacement as any other oversized
     * tool_result. This is the path used by tests and by single-agent
     * mode (which never produces envelopes anyway).
     */
    artifactStore?: ArtifactStore | null;
    /**
     * Real-token context window of the target model, used by
     * {@link ContextReducer.emergencyShrink} to compute an adaptive
     * emergency line: the shrink is triggered at
     * `min(threshold × 1.5, modelContextWindow × 0.85 / 1.2)`, so
     * small-window models (e.g. legacy GPT-3.5 16k, Llama-2 4k) get
     * the safety net **before** the prompt overflows even when the
     * user's threshold is set for a much larger model.
     *
     * Conventions:
     *   - Value is the model's **real** context window (not estimated
     *     `estimateTokens()` units); the reducer applies the standard
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
 * Classifies characters into four buckets for a zero-dependency heuristic:
 *   - CJK (Hanzi/Kana/Hangul):    ~1.5 chars / token
 *   - Alphanumeric (a-zA-Z0-9):   ~4.0 chars / token
 *   - Punctuation/symbols:         ~1.0 token each
 *   - Whitespace:                  ignored (essentially free in most tokenizers)
 *
 * Compared to the previous uniform "non-CJK ÷ 4" approach this fixes two
 * systematic errors that mostly cancel out in prose but diverge badly in
 * structured text / code:
 *   1. Punctuation was underestimated (~4× too cheap).
 *   2. Whitespace was overestimated (~5× too expensive).
 *
 * The estimate is still intentionally conservative — actual token counts
 * vary by tokenizer — but the improved per-class ratios are good enough
 * for threshold comparison across a wider variety of content.
 */
export function estimateTokens(text: string): number {
    const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;
    const alphaRe = /[a-zA-Z0-9]/g;
    const punctRe = /[^\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7afa-zA-Z0-9\s]/g;

    const cjkCount = (text.match(cjkRe) || []).length;
    const alphaCount = (text.match(alphaRe) || []).length;
    const punctCount = (text.match(punctRe) || []).length;

    return Math.ceil(cjkCount / 1.5 + alphaCount / 4 + punctCount);
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
 * Cheap precheck: a serialized delegate envelope is always a JSON object
 * starting with `{` and, because `buildDelegatePayload` emits `__kind`
 * as the *first* key (after `JSON.stringify` preserves insertion order
 * per ECMA-262), the substring `"__kind"` reliably appears within the
 * first ~50 bytes. We don't anchor on a strict prefix because future
 * formatters (pretty-printing, key reordering by `JSON.stringify`
 * replacers, etc.) might insert whitespace or shift keys; a small
 * substring scan is robust to those without paying for a full
 * `JSON.parse` on every plain-text or non-envelope JSON tool result.
 *
 * The 64-byte horizon comfortably covers `{"__kind":"delegate_envelope","__v":1,...`
 * (37 chars) plus pretty-print padding, while keeping false-positive
 * scan cost negligible for huge tool results (we only look at the head).
 */
const ENVELOPE_MARKER_SCAN_BYTES = 64;

/**
 * Cheap, allocation-free probe used as a gate before `JSON.parse`.
 * Conservative — false positives here are harmless (the parse step
 * catches them), but false negatives would silently disable envelope
 * recognition, so this only rejects the obvious non-candidates.
 */
function looksLikeEnvelope(s: string): boolean {
    if (s.length < 30) return false; // `{"__kind":"delegate_envelope","__v":1,"text":""}` is 47 chars; anything shorter cannot be a valid envelope.
    if (s.charCodeAt(0) !== 0x7B /* '{' */) return false;
    const idx = s.indexOf("__kind", 0);
    return idx >= 0 && idx < ENVELOPE_MARKER_SCAN_BYTES;
}

/**
 * Recognise a `DelegatePayload` envelope inside a serialized
 * `tool_result` content string.
 *
 * Returns the parsed envelope on success, or `null` if the string is
 * not a recognisable envelope (not JSON, not an object, missing or
 * wrong `__kind`, missing or unknown `__v`). Used by the shrink stage
 * — and, in a later step, by `recall_artifact` — to decide whether a
 * tool result deserves envelope-aware handling versus the generic
 * truncation path.
 *
 * **Why parse-and-return rather than a boolean**: every realistic
 * consumer needs the parsed object immediately after the check (to
 * spill `result` / `extras`, to extract `text`, etc.). Parsing twice
 * — once to decide, once to use — would double the cost on the only
 * path where this helper matters (the shrink hot path). Callers that
 * only need a boolean can `!= null` the result.
 *
 * **Forward compatibility**: an envelope with a `__v` greater than
 * {@link DELEGATE_ENVELOPE_VERSION} is treated as *unrecognised*
 * (returns `null`). This is deliberate: if a future plugin version
 * adds breaking shape changes, an older runtime reading a persisted
 * session should fall through to the safe generic path rather than
 * mis-parse and corrupt the envelope. (See plan doc §6 — "Backward
 * compat with persisted sessions": graceful degradation, no
 * migration needed.)
 *
 * **Performance**: `looksLikeEnvelope` gates the parse so plain text
 * and unrelated JSON tool results pay only a O(64) substring scan,
 * not a full parse. The hot path is the shrink stage which sees every
 * historical tool_result on every prompt assembly.
 *
 * @param raw The exact string that appears as `tool_result.content`.
 * @returns The parsed envelope, or `null` if `raw` is not one.
 */
export function tryParseDelegateEnvelope(raw: string): DelegatePayload | null {
    if (!looksLikeEnvelope(raw)) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
    }

    const obj = parsed as Record<string, unknown>;

    if (obj.__kind !== DELEGATE_ENVELOPE_KIND) return null;
    // Strict equality on version: anything beyond what we know how to
    // handle falls back to the safe generic path. When/if `__v` is
    // bumped, this check is the single point of truth that needs to
    // learn the new version.
    if (obj.__v !== DELEGATE_ENVELOPE_VERSION) return null;
    if (typeof obj.text !== "string") return null;

    // At this point the discriminant + required field have been
    // validated; optional fields (`result`, `extras`, `omitted`) are
    // accepted as-is and structurally typed by the interface. We do
    // *not* validate their inner shape — that would be defensive
    // overreach against `buildDelegatePayload`, which is the only
    // legitimate producer.
    //
    // The double cast (`as unknown as DelegatePayload`) is intentional:
    // we have just dynamically verified the three required fields, but
    // TS cannot flow that knowledge from `Record<string,unknown>` to
    // the literal-typed interface fields (`typeof DELEGATE_ENVELOPE_KIND`
    // etc.). The cast is the canonical escape hatch for this exact
    // "I just runtime-checked it" situation; a custom type predicate
    // would be slightly cleaner but adds noise out of proportion to
    // the size of the function.
    return obj as unknown as DelegatePayload;
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
 *
 * **B-1 — envelope-aware branch**: when `result` is a recognisable
 * {@link DelegatePayload} AND the caller supplied an `artifactStore` and
 * a `toolCallId`, the envelope is **rewritten in place** rather than
 * collapsed: inline `result` and `extras[k]` fields above
 * {@link ENVELOPE_FIELD_SPILL_MIN_BYTES} are moved into the store and
 * replaced with {@link ArtifactRef}s under `payload.artifacts[<field>]`
 * (with `reason: "shrunk"`). This preserves the envelope's discriminator,
 * `text`, `omitted`, and pre-existing `artifacts` entries — so the next
 * turn's main agent still sees an envelope, just with most of the bulk
 * parked in the recall store. Without a store / toolCallId, or for non-
 * envelope JSON, the legacy generic truncation path runs unchanged.
 */
function shrinkToolResultContent(
    result: string,
    toolCallId?: string,
    store?: ArtifactStore | null,
): string {
    // Error results: always keep full text (usually short and meaningful).
    if (result.startsWith('Error:')) return result;

    // Below threshold: keep the original content untouched.
    if (estimateTokens(result) <= TOOL_RESULT_COLLAPSE_THRESHOLD) return result;

    // B-1: envelope branch. Recognise a delegate envelope before the
    // generic JSON path so we can park `result`/`extras` in the store
    // instead of dropping them. Only triggers when both a store and a
    // toolCallId are available; otherwise we fall through to the
    // legacy "JSON object with keys {…}" replacement so the rest of
    // the pipeline (summarizer, persistence) is unchanged.
    if (store && typeof toolCallId === "string" && toolCallId.length > 0) {
        const envelope = tryParseDelegateEnvelope(result);
        if (envelope) {
            const rewritten = shrinkEnvelopeForPrompt(envelope, toolCallId, store);
            if (rewritten !== null) return rewritten;
            // rewritten === null means "nothing worth spilling" — the
            // envelope is mostly `text`, or every spill candidate fell
            // below the per-field min. Returning the original JSON
            // here is safe because `estimateTokens > threshold` already
            // accepted it as "expensive", but keeping it intact is
            // strictly better than collapsing an envelope (we'd lose
            // the structured `result` for no real gain).
            return result;
        }
    }

    // Phase 0: For generic (non-envelope) oversized tool results, store
    // the original content in the artifact store so the LLM can retrieve
    // it later via `recall_artifact`. Only attempts storage when both a
    // store and toolCallId are available; on failure (too large for the
    // store) we fall through to the existing no-key truncation messages
    // so the pipeline behaviour is unchanged.
    let artifactKey: string | undefined;
    if (store && typeof toolCallId === "string" && toolCallId.length > 0) {
        const putResult = store.put(result, result.length);
        if (putResult.stored) {
            artifactKey = putResult.key;
        }
    }

    const artifactHint = artifactKey
        ? ` Full content stored as artifact. Use recall_artifact(key="${artifactKey}") to retrieve it.`
        : "";

    // Try to parse as JSON for a structured meta summary.
    try {
        const parsed = JSON.parse(result) as unknown;
        if (Array.isArray(parsed)) {
            return `[Tool result truncated: JSON array of ${parsed.length} items, ${result.length} chars total, original content omitted to save context budget.${artifactHint}]`;
        } else if (typeof parsed === 'object' && parsed !== null) {
            const keys = Object.keys(parsed);
            const keyPreview = keys.slice(0, 5).join(', ') + (keys.length > 5 ? ', ...' : '');
            return `[Tool result truncated: JSON object with keys {${keyPreview}}, ${result.length} chars total, original content omitted to save context budget.${artifactHint}]`;
        }
    } catch {
        // Not JSON, fall through to plain text handling.
    }

    // Plain text: keep first 200 chars as a preview inside the meta wrapper.
    const preview = safeSliceHead(result, 200).replace(/\n/g, ' ');
    return `[Tool result truncated: original ${result.length} chars, preview: ${preview}...${artifactHint}]`;
}

/**
 * Per-field minimum size (JSON-stringified bytes) below which envelope
 * spilling is a net loss: an {@link ArtifactRef} JSON-serialises to
 * ~80–280 chars (key + size + reason + optional preview), so values
 * smaller than this would inflate the envelope rather than shrink it.
 *
 * 256 bytes is comfortably above the worst-case ref overhead and is
 * the same scale as the `preview` cap embedded in the ref itself, so
 * a spilled value "feels at most as small as its preview" in the
 * resulting envelope. Tunable; not exposed as a setting because the
 * trade-off is purely an internal storage micro-optimization.
 */
const ENVELOPE_FIELD_SPILL_MIN_BYTES = 256;

/**
 * Per-field preview cap for {@link ArtifactRef.preview} produced by the
 * shrink path. Mirrors `ARTIFACT_PREVIEW_MAX_CHARS` in `agent-orchestrator`,
 * deliberately duplicated here (rather than imported) to keep the reducer
 * dependency-light — the orchestrator imports types from this module's
 * sibling `delegate-envelope-shape`, and reaching back across the boundary
 * for a 200-char constant would re-introduce the cycle the shape module
 * was split out to avoid.
 */
const SHRUNK_ARTIFACT_PREVIEW_MAX_CHARS = 200;

/**
 * Build a head preview for a value spilled by the shrink path. Same
 * shape as `agent-orchestrator.buildArtifactPreview` (JSON head + `…`
 * marker, undefined on serialization failure) so the LLM cannot tell
 * whether a given preview was minted at envelope-build or shrink time.
 */
function buildShrunkArtifactPreview(value: unknown): string | undefined {
    let json: string;
    try {
        json = JSON.stringify(value);
    } catch {
        return undefined;
    }
    if (json === undefined) return undefined;
    if (json.length <= SHRUNK_ARTIFACT_PREVIEW_MAX_CHARS) return json;
    return json.slice(0, SHRUNK_ARTIFACT_PREVIEW_MAX_CHARS) + "…";
}

/**
 * Rewrite a parsed {@link DelegatePayload} so that bulky inline fields
 * are moved into the artifact store, returning the new JSON string the
 * caller should use as the `tool_result.content` replacement.
 *
 * Returns `null` when the rewrite would not actually save space — i.e.
 * no inline field exceeded {@link ENVELOPE_FIELD_SPILL_MIN_BYTES} and
 * no field was successfully spilled. The caller treats `null` as "keep
 * the original content as-is" rather than falling through to the
 * generic truncation path: an envelope whose bulk is already in `text`
 * or in pre-existing `artifacts` is cheap enough to leave alone, and
 * collapsing it to a meta string would lose the structured shape for
 * no real budget gain.
 *
 * Mutual exclusion (mirrors `buildDelegatePayload`'s build-time rules):
 *
 *   - `result` / `extras[k]`: deleted from the payload after spill.
 *     The new `artifacts[k]` entry is the only home for the value.
 *   - Pre-existing `artifacts[k]` (from E-3 build-time promotion) is
 *     kept untouched — that field is already in the store under a
 *     different key and we must not double-spill or rename it.
 *   - Pre-existing `omitted[k_*]` is kept untouched — that field's
 *     content was never seen by us and there is nothing to spill.
 *   - When `store.put` rejects with `too_large_for_store`, the field
 *     is moved to `omitted` with `_too_large_for_store: true`,
 *     matching E-3's bucket-3 marker shape.
 */
function shrinkEnvelopeForPrompt(
    envelope: DelegatePayload,
    toolCallId: string,
    store: ArtifactStore,
): string | null {
    // Work on a shallow clone so the caller's `envelope` object — and
    // by transitivity the original `tool_result.content` if anyone
    // re-parses it later — is not mutated. `result` and `extras` are
    // also cloned out before mutation so the original references in
    // chat memory stay intact.
    const next: DelegatePayload = {
        __kind: envelope.__kind,
        __v: envelope.__v,
        text: envelope.text,
    };
    if (envelope.omitted !== undefined) next.omitted = { ...envelope.omitted };
    // Existing artifacts are reused in-place: their values already live
    // in the store under their build-time key, and we do NOT re-spill.
    let nextArtifacts: Record<string, ArtifactRef> | undefined =
        envelope.artifacts !== undefined ? { ...envelope.artifacts } : undefined;

    let didSpill = false;

    /**
     * Per-field spill: try to move `value` into the store. The store
     * auto-generates a unique key. On success, register an
     * {@link ArtifactRef} (with `reason: "shrunk"`) and report
     * `"spilled"`. On rejection, stamp the matching `omitted_*`
     * markers and report `"too_large"`. Below the per-field min,
     * report `"too_small"` so the caller can keep the value inline.
     */
    const trySpill = (
        fieldName: string,
        value: unknown,
    ): "spilled" | "too_large" | "too_small" | "not_serializable" => {
        let json: string;
        try {
            json = JSON.stringify(value);
        } catch {
            // Non-serializable values cannot be stored or previewed.
            // Drop them silently — same defensive default as
            // `buildArtifactPreview` returning undefined at build time.
            return "not_serializable";
        }
        if (json === undefined) return "not_serializable";
        const size = json.length;
        if (size < ENVELOPE_FIELD_SPILL_MIN_BYTES) return "too_small";

        const putResult = store.put(value, size);
        if (putResult.stored) {
            nextArtifacts ??= {};
            nextArtifacts[fieldName] = {
                key: putResult.key,
                size,
                preview: buildShrunkArtifactPreview(value),
                reason: "shrunk",
            };
            return "spilled";
        }
        // Store rejected (oversize for the store itself). Match the
        // build-time bucket-3 markers so the LLM sees a uniform
        // "this slot is unrecoverable" signal regardless of when the
        // drop happened.
        next.omitted ??= {};
        next.omitted[`${fieldName}_omitted`] = true;
        next.omitted[`${fieldName}_size`] = size;
        next.omitted[`${fieldName}_too_large_for_store`] = true;
        return "too_large";
    };

    // Spill `result` if it is currently inline AND not already an
    // artifact. (`envelope.artifacts.result` would mean E-3 already
    // promoted it at build time; `envelope.result === undefined`
    // means the sub-agent never produced one — both → skip.)
    if (envelope.result !== undefined
        && (envelope.artifacts === undefined || !("result" in envelope.artifacts))) {
        const outcome = trySpill("result", envelope.result);
        if (outcome === "spilled" || outcome === "too_large") {
            didSpill = true;
            // Field is gone from inline either way (spilled or marked
            // omitted). Don't put it back into `next.result`.
        } else {
            // too_small / not_serializable: keep inline.
            next.result = envelope.result;
        }
    }

    // Spill each `extras[k]` field individually so a small auxiliary
    // log next to a huge data blob doesn't get unnecessarily uprooted.
    if (envelope.extras !== undefined) {
        let nextExtras: Record<string, unknown> | undefined;
        for (const [k, v] of Object.entries(envelope.extras)) {
            // Skip if this extras key is already represented as an
            // artifact (E-3 build-time promotion). Should not happen
            // — `buildDelegatePayload` enforces mutual exclusion at
            // build — but defensively keep the artifact entry as-is.
            if (envelope.artifacts !== undefined && k in envelope.artifacts) {
                continue;
            }
            const outcome = trySpill(k, v);
            if (outcome === "spilled" || outcome === "too_large") {
                didSpill = true;
                continue;
            }
            nextExtras ??= {};
            nextExtras[k] = v;
        }
        if (nextExtras !== undefined) next.extras = nextExtras;
    }

    if (!didSpill) return null;

    if (nextArtifacts !== undefined) next.artifacts = nextArtifacts;
    return JSON.stringify(next);
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
 * - emergencyShrunk: Whether the {@link ContextReducer.emergencyShrink}
 *                    safety net actually rewrote any tool_result on this
 *                    turn. Surfaces upward so the caller can show a one-
 *                    shot Notice / event (the underlying content loss is
 *                    a user-perceivable trade-off, not a silent fix).
 */
export interface ContextReduceResult<T extends HistoryMessage> {
    messagesToSend: T[];
    newSummary: ConversationSummary | null;
    compressed: boolean;
    /** Index of the last message in rawMessages that is now covered by summaries */
    lastMessageIndex: number;
    /** True if emergency shrink force-collapsed the unconsumed tool tail to fit budget. */
    emergencyShrunk: boolean;
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
        signal?: AbortSignal,
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
        // B-1: artifact store, when provided, lets the shrink stage spill
        // historical envelope `result` / `extras` into out-of-prompt
        // storage. `null` is treated identically to `undefined` —
        // disables spilling, falls back to the legacy generic truncation.
        const artifactStore = options?.artifactStore ?? null;
        // Model-aware emergency line. `<=0` (incl. undefined) keeps the
        // pre-existing "threshold × 1.5 only" behaviour — see
        // {@link emergencyShrink} for the math.
        const modelContextWindow = options?.modelContextWindow && options.modelContextWindow > 0
            ? options.modelContextWindow
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
            const shrunkUnsummarized = this.shrinkLargeToolResults(snapped, artifactStore);
            // Ensure tool message sequence integrity in the final messagesToSend
            const finalMessagesToSend = [
                ...systemMessages,
                ...summaryMessages,
                ...archiveNoteMessages,
                ...this.ensureToolSequenceIntegrity(shrunkUnsummarized),
            ] as T[];

            const sanitizedNoCompress = this.validateAndSanitizeForLLM(finalMessagesToSend);
            const { messages: postEmergencyNoCompress, shrunk: emergencyShrunkNoCompress } =
                ContextReducer.emergencyShrink(sanitizedNoCompress, accessoryTokens, threshold, artifactStore, modelContextWindow);
            return {
                messagesToSend: postEmergencyNoCompress,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
                emergencyShrunk: emergencyShrunkNoCompress,
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
            const { messages: postEmergencyFitsWindow, shrunk: emergencyShrunkFitsWindow } =
                ContextReducer.emergencyShrink(sanitizedFitsWindow, accessoryTokens, threshold, artifactStore, modelContextWindow);
            return {
                messagesToSend: postEmergencyFitsWindow,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
                emergencyShrunk: emergencyShrunkFitsWindow,
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

        const summaryContent = await summarizeConversation(modelConfig, prompt, oldMessages, newSummaryLevel, signal);

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
            const fallbackShrunk = this.shrinkLargeToolResults(unsummarizedMessages, artifactStore);
            const fallbackAssembled = [
                ...systemMessages,
                ...fallbackSummaryMessages,
                ...fallbackArchiveNote,
                ...this.ensureToolSequenceIntegrity(fallbackShrunk),
            ] as T[];
            const sanitizedFallback = this.validateAndSanitizeForLLM(fallbackAssembled);
            const { messages: postEmergencyFallback, shrunk: emergencyShrunkFallback } =
                ContextReducer.emergencyShrink(sanitizedFallback, accessoryTokens, threshold, artifactStore, modelContextWindow);
            return {
                messagesToSend: postEmergencyFallback,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
                emergencyShrunk: emergencyShrunkFallback,
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
        const { messages: postEmergencyCompressed, shrunk: emergencyShrunkCompressed } =
            ContextReducer.emergencyShrink(sanitizedCompressed, accessoryTokens, threshold, artifactStore, modelContextWindow);
        return {
            messagesToSend: postEmergencyCompressed,
            newSummary,
            compressed: true,
            lastMessageIndex: newSummaryLastIndex,
            emergencyShrunk: emergencyShrunkCompressed,
        };
        }

    /**
     * Last-resort budget recovery — applied to the fully-assembled
     * messages list when its estimated token count exceeds the
     * **adaptive emergency line**.
     *
     * Why this exists: primary compression operates on the **history**
     * portion of the prompt (everything older than the recent window).
     * Two narrow paths leak past it:
     *   1. A single `tool_result` in the **unconsumed tail** (newer than
     *      the last assistant message) that happens to be huge — e.g. a
     *      delegate-task envelope or a large file read. This is exempt
     *      from {@link shrinkLargeToolResults} by design because the
     *      LLM hasn't read it yet, but on a tight model window the
     *      exemption can push the prompt over the model's context limit.
     *   2. A recent window whose **last turn** alone is enormous (long
     *      tool chain in a single turn). Primary compression's turn-
     *      boundary snap keeps the whole turn intact, even when that
     *      means the "compressed" prompt is barely smaller than the
     *      uncompressed one.
     *
     * Adaptive emergency line:
     *   `min(threshold × 1.5, modelContextWindow × 0.85 / 1.2)`
     *
     *   - `threshold × 1.5` — the user-tunable knob. Fires when the
     *     post-compression prompt is **clearly** above the configured
     *     trigger point.
     *   - `modelContextWindow × 0.85 / 1.2` — model-aware safety floor:
     *     0.85 leaves 15% of the real window for the response and
     *     provider-side overhead; the /1.2 converts the real-token
     *     ceiling back into the reducer's estimated-token unit. So a
     *     16k-window model fires emergency shrink at ~11k estimated
     *     tokens regardless of how high the user's threshold is.
     *
     *   When `modelContextWindow <= 0` (no metadata supplied — e.g.
     *   tests, unknown model) the model floor is omitted and only
     *   `threshold × 1.5` applies, preserving the original behaviour.
     *
     * Strategy: walk tool_results in **chronological (oldest-first)**
     * order, shrinking each oversized one in turn and stopping as soon
     * as the assembled prompt drops back under the emergency line. This
     * preserves the model's most recent tool_results — the ones it is
     * most likely to be reasoning over right now — and only sacrifices
     * the earliest ones, which the model has had the longest to digest
     * (and which are most likely already paraphrased into the model's
     * own subsequent tool-call arguments anyway).
     *
     * Why incremental beats the previous "force-shrink everything"
     * approach: once the outer reducer's `shrinkLargeToolResults`
     * (which now exempts the entire active reasoning chain — see its
     * JSDoc) leaves the active chain intact, the wholesale variant
     * here would force-truncate every active-chain tool_result the
     * moment the cumulative chain crossed the emergency line. For a
     * sub-agent that legitimately needs to read several large files in
     * one turn (`read_file → write_handoff → read_file → write_handoff
     * → ...`), that's exactly the "走两步就忘 → re-fetch the same
     * file → loop" pathology this entire shrink stage was meant to
     * prevent. Walking oldest-first and stopping at the budget line
     * gives the model the maximum number of recent intact tool_results
     * we can fit while still meeting the provider's window contract.
     *
     * The envelope spill path still preserves recall via the artifact
     * store on every shrink call, so a user who really needs the
     * dropped detail can recover it with `recall_artifact` on the
     * next turn. The structural assistant→tool_result pairing is
     * preserved (only the `content` field of each tool_result is
     * rewritten), so no re-sanitization is needed.
     *
     * Returns the possibly-rewritten messages array (the original is
     * never mutated). The `shrunk` flag in the return value signals to
     * the caller that emergency shrinking actually ran, so a Notice /
     * event can be surfaced once per session.
     *
     * No second LLM summarization is attempted here on purpose:
     *   - it would double the latency of an already-over-budget turn;
     *   - the structural shrink alone is usually enough to bring the
     *     prompt back inside the window;
     *   - if it isn't, the provider's own 400 with a clear "too long"
     *     message is more actionable than a silently-double-compressed
     *     turn whose summary may have dropped the key fact.
     */
    private static emergencyShrink<T extends HistoryMessage>(
        messages: T[],
        accessoryTokens: number,
        threshold: number,
        store: ArtifactStore | null,
        modelContextWindow: number,
    ): { messages: T[]; shrunk: boolean } {
        const total = estimateMessagesTokens(messages) + accessoryTokens;

        // Compute the adaptive emergency line. See JSDoc above for the
        // math; here we just min two upper bounds, omitting the model
        // floor when no metadata was supplied (the historical path).
        const thresholdCeiling = threshold * 1.5;
        // 0.85 / 1.2 ≈ 0.708 — derived constants kept inline to avoid
        // a tiny helper file; they're tuned in tandem and only used here.
        const modelCeiling = modelContextWindow > 0
            ? (modelContextWindow * 0.85) / 1.2
            : Number.POSITIVE_INFINITY;
        const emergencyLine = Math.min(thresholdCeiling, modelCeiling);
        const limitedByModel = modelCeiling < thresholdCeiling;

        if (total <= emergencyLine) return { messages, shrunk: false };

        // Incremental, oldest-first shrink. We keep a running token
        // total and shrink one tool_result at a time until we either
        // dip back under `emergencyLine` or run out of shrinkable
        // material. The running-delta update keeps this O(N) on the
        // common path even for very long histories.
        const working: T[] = messages.slice();
        let runningTotal = total;
        let anyShrunk = false;

        for (let i = 0; i < working.length; i++) {
            if (runningTotal <= emergencyLine) break;
            const msg = working[i]!;
            if (msg.role !== "tool_result") continue;
            const before = msg.content;
            if (typeof before !== "string" || before.length === 0) continue;
            const after = shrinkToolResultContent(before, msg.toolCallId, store);
            if (after === before) continue; // already small / non-shrinkable
            working[i] = { ...msg, content: after } as T;
            // Token delta: `estimateTokens` is cheap (linear in length
            // with a couple of branches) and counting only the changed
            // message keeps the worst case O(total content size)
            // instead of O(N · total content size) we'd get from a
            // full `estimateMessagesTokens` re-count per iteration.
            runningTotal = runningTotal - estimateTokens(before) + estimateTokens(after);
            anyShrunk = true;
        }

        // Nothing left to shrink? Either every tool_result was already
        // small or the over-budget portion lives in the assistant /
        // user messages themselves. Either way, returning `messages`
        // (the original, untouched) keeps the no-op contract.
        if (!anyShrunk) {
            const guidance = limitedByModel
                ? `model context window ~${modelContextWindow} is the limiting factor — ` +
                  `lower the compression threshold or switch to a larger-context model.`
                : `consider raising the threshold, switching to a larger-context model, ` +
                  `or trimming the active tool set.`;
            console.warn(
                `[ContextReducer] emergency shrink found nothing left to shrink: ` +
                `${total} estimated tokens, emergency line ${Math.floor(emergencyLine)} ` +
                `(threshold ${threshold}${limitedByModel ? `, model ${modelContextWindow}` : ""}). ` +
                guidance,
            );
            return { messages, shrunk: false };
        }

        const newTotal = estimateMessagesTokens(working) + accessoryTokens;
        if (newTotal > emergencyLine) {
            console.warn(
                `[ContextReducer] emergency shrink applied but prompt is still over budget: ` +
                `${total} → ${newTotal} estimated tokens (limit ${Math.floor(emergencyLine)}` +
                `${limitedByModel ? `, capped by model window ${modelContextWindow}` : ""}). ` +
                `Provider may return a 400 if the model window is exceeded.`,
            );
        } else {
            console.warn(
                `[ContextReducer] emergency shrink applied (incremental, oldest-first): ` +
                `${total} → ${newTotal} estimated tokens (limit ${Math.floor(emergencyLine)}` +
                `${limitedByModel ? `, capped by model window ${modelContextWindow}` : ""}). ` +
                `Earliest oversized tool_results were truncated to fit the budget; ` +
                `more recent results were preserved verbatim. Original content remains ` +
                `recoverable via the artifact store when available.`,
            );
        }
        return { messages: working, shrunk: true };
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
                // Find the nearest assistant predecessor already accepted.
                //
                // The walk must step over any message that ChatStream may
                // legitimately interleave inside an assistant→tool_result
                // chain. Today that is:
                //   * sibling `tool_result` messages (the obvious case);
                //   * synthetic `user` messages injected right after a
                //     media-returning tool_result so the LLM can perceive
                //     the bytes (see chat-stream.ts where `mediaAttachment`
                //     is unpacked into `{ role: "user", media: [...] }`).
                //     Without skipping these, every sibling tool_result
                //     from the same assistant turn that happens to sit
                //     AFTER the media-injected user message gets dropped
                //     as an orphan, and pass 2 then fills the gap with a
                //     synthetic "[Error: tool result missing after context
                //     compression]" placeholder. The model reads that as
                //     "my tool call failed" and re-tries the whole batch
                //     on the next iteration — same media tool re-fires,
                //     same orphan-drop happens — which surfaces in the
                //     wild as the agent looping "as if it forgot what it
                //     just did after two steps".
                // Generalising: walk back across non-assistant messages
                // to find the closest assistant, then verify with a
                // toolCallId match. The id-match guard is what keeps this
                // safe — it prevents a stale assistant from a prior turn
                // from being silently re-used as an owner.
                let ownerIdx = pass1.length - 1;
                while (ownerIdx >= 0 && pass1[ownerIdx]!.role !== "assistant") {
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

            // Collect tool_results owned by `msg`. Walk forward until we
            // hit the next assistant (= start of a new turn) or run out.
            //
            // The walk must look PAST any non-tool_result interjection
            // ChatStream may legitimately emit inside a tool sequence —
            // today that is a synthetic `user` message carrying the
            // bytes of a media-returning tool's output (see chat-stream
            // where `mediaAttachment` is unpacked). Stopping at the
            // first non-tool_result would partition a multi-toolCall
            // batch around that user message and falsely report the
            // tool_results that follow it as "missing", causing
            // pass 2 to splat synthetic "[Error: tool result missing
            // after context compression]" placeholders into the
            // prompt. The model then reads its own tool calls as
            // failed and re-tries the whole batch.
            const gathered = new Map<string, T>();
            let j = i + 1;
            while (j < pass1.length && pass1[j]!.role !== "assistant") {
                if (pass1[j]!.role === "tool_result") {
                    const tcId = pass1[j]!.toolCallId;
                    if (tcId) gathered.set(tcId, pass1[j]!);
                }
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
     *
     * **B-1 — envelope spill**: when an `artifactStore` is supplied, an
     * eligible (consumed, oversized) tool_result whose content is a
     * recognisable delegate envelope is rewritten in place — its inline
     * `result` / `extras[k]` are moved into the store and replaced with
     * `ArtifactRef`s. The envelope structure (`__kind` / `__v` / `text`
     * / `omitted` / pre-existing `artifacts`) is preserved, and the
     * store auto-generates unique keys for each spilled field. Without
     * a store, the legacy generic truncation path runs.
     *
     * **`forceShrinkAll`** disables the unconsumed-tail exemption. Used
     * exclusively by {@link emergencyShrink} as a last-resort budget
     * recovery when the assembled prompt still exceeds 1.5× threshold
     * after primary compression. The caller accepts the per-turn fidelity
     * loss on freshly-returned tool results because the alternative is
     * a provider 400 (over-window request). Envelope-aware spilling is
     * still attempted first so the content remains recallable via
     * `recall_artifact`.
     */
    private static shrinkLargeToolResults<T extends HistoryMessage>(
        messages: T[],
        store?: ArtifactStore | null,
        forceShrinkAll: boolean = false,
    ): T[] {
        if (messages.length === 0) return messages;

        // Locate the boundary between consumed and still-active
        // tool_results. Anything after this index is part of the
        // "just-produced, not yet digested" tail.
        //
        // The rule is: only a **content-bearing** assistant turn (one
        // whose `content` is a non-empty string) closes the active
        // reasoning chain. A pure tool-call assistant (empty content,
        // toolCalls only) does NOT — it just forwards data into the
        // next tool via toolCall arguments and chains the next step,
        // which means the preceding tool_result is still in the
        // model's working set and may be referenced again on later
        // iterations.
        //
        // Why this matters — vault_inspector "走两步就忘" loop:
        //   read_file (big body) → write_handoff(value=<body>) →
        //   read_file (same path again) → write_handoff again → ...
        // Pre-fix the heuristic took **any** assistant as the
        // boundary, so once iter 2 emitted its `write_handoff`
        // toolCall, iter 3's reduce() shrank read_file's result to a
        // `[Tool result truncated: …]` placeholder. The model could
        // no longer see its own file content and retried the read
        // from scratch, looping the entire chain.
        //
        // Why it's safe to extend the exemption window backwards:
        //   * The total context still has a hard ceiling at the
        //     emergency-shrink line (1.5× threshold), where
        //     `forceShrinkAll=true` overrides this exemption and
        //     truncates everything regardless of position.
        //   * Sub-agents always run with a single user turn so they
        //     can't go through primary compression at all — the
        //     emergency line is the ONLY budget brake regardless of
        //     this rule.
        //   * Once the model produces any prose (even a one-line
        //     "done"), the entire pre-prose chain becomes shrinkable
        //     again — i.e. closing the chain costs nothing extra
        //     compared to the old behaviour.
        //
        // -1 means no content-bearing assistant exists in the slice;
        // the condition `i > lastAssistantIdx` then evaluates to
        // true for every tool_result, so the entire slice is treated
        // as the active chain and nothing gets shrunk. This is the
        // safe default — without a closing prose turn we cannot
        // prove the model has finished reasoning over any of the
        // tool_results yet.
        //
        // When `forceShrinkAll` is true the exemption is bypassed
        // entirely; computing `lastAssistantIdx` is harmless in that
        // case and keeps the per-iteration condition uniform.
        let lastAssistantIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]!;
            if (m.role !== 'assistant') continue;
            const hasContent = typeof m.content === 'string' && m.content.length > 0;
            if (hasContent) {
                lastAssistantIdx = i;
                break;
            }
        }

        const result: T[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]!;
            if (msg.role === 'tool_result' && typeof msg.content === 'string' && msg.content.length > 0) {
                // Exempt the unconsumed tail: tool_results after the last
                // assistant haven't been read by the model yet. Bypassed
                // when the caller is the emergency shrink path.
                if (!forceShrinkAll && i > lastAssistantIdx) {
                    result.push(msg);
                    continue;
                }
                const shrunk = shrinkToolResultContent(msg.content, msg.toolCallId, store ?? null);
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
 * @param signal Optional AbortSignal forwarded to the underlying provider
 *   SDK so the call can be interrupted mid-flight (e.g. when the user
 *   hits the global stop button during a long summarization round).
 *   Without this the surrounding `reduce()` could block the abort
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
    level: number = 1,
    signal?: AbortSignal,
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
        const summary = await createChatCompletion(modelConfig, summarizerMessages, signal);

        // console.log(`[ContextReducer] Generated summary (level ${level}):`, summary);
        const trimmed = summary.trim();
        if (!trimmed) {
            console.warn("[ContextReducer] Summarizer returned empty content; treating as failure");
            return null;
        }
        return trimmed;
    } catch (e) {
        // User-initiated aborts must propagate, NOT degrade to the
        // "summarization failed → send raw context" fallback below —
        // the whole turn is being torn down, so silently returning
        // null here would just defer the abort response until the
        // next aborted step trips a check. Re-throw so the calling
        // `reduce()` / chat-stream loop unwinds immediately.
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        console.error("[ContextReducer] Summarization failed:", e);
        console.warn("[ContextReducer] Returning null to signal fallback (no-compression) to the caller");
        return null;
    }
}