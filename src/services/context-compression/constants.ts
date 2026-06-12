/**
 * Fallback compression threshold used when the model's context window
 * cannot be determined (unknown model identifier, tests, etc.).
 *
 * Sized conservatively at 48k estimated tokens (~57k real), which is
 * ~45% of a 128k window — a safe middle ground that works for most
 * mainstream models without risking overflow on smaller ones.
 */
export const DEFAULT_COMPRESSION_THRESHOLD_FALLBACK = 48000;

/**
 * Fraction of the model's **real-token** context window that the
 * default compression threshold targets. the compressor works in
 * estimated tokens which are ~1.2× looser than real tokens, so the
 * effective estimated-token threshold is:
 *
 *   threshold = modelContextWindow × {@link COMPRESSION_WINDOW_FRACTION} / {@link ESTIMATED_TO_REAL_RATIO}
 *
 * At 0.45 the threshold lands at ~45% of the model window in real
 * tokens — same intent as the original fixed 48k for 128k models.
 *
 * For a 1M model this gives ~375k estimated tokens (~450k real),
 * dramatically expanding the no-compression headroom compared to the
 * old fixed default.
 */
export const COMPRESSION_WINDOW_FRACTION = 0.45;

/**
 * Multiplier from the compressor's estimated tokens to real tokens.
 * `estimateTokens` uses 4 chars/token for non-CJK, 1.5 for CJK;
 * modern tokenizers are 15–25% denser, so real ≈ estimated × 1.2.
 */
export const ESTIMATED_TO_REAL_RATIO = 1.2;

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
export const DEFAULT_SLIDING_WINDOW_SIZE = 10;

/**
 * Maximum number of summaries to retain before triggering second-level compression.
 * When total summaries exceed this value, all summaries are re-summarized into
 * a single higher-level summary.
 *
 * Raised in tandem with the default compression threshold: a larger
 * primary threshold means each Level-1 summary covers more conversation, so
 * triggering Level-2 ("summary of summaries", which is lossier) too eagerly
 * hurts recall. 8 lets the conversation accumulate substantially before a
 * second-order compression kicks in.
 */
export const DEFAULT_MAX_SUMMARIES_THRESHOLD = 8;

/** Token threshold for shrinking a single tool result in historical messages. */
export const TOOL_RESULT_COLLAPSE_THRESHOLD = 500;

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
export const ENVELOPE_MARKER_SCAN_BYTES = 64;

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
export const ENVELOPE_FIELD_SPILL_MIN_BYTES = 256;

/**
 * Per-field preview cap for {@link ArtifactRef.preview} produced by the
 * shrink path. Mirrors `ARTIFACT_PREVIEW_MAX_CHARS` in `agent-orchestrator`,
 * deliberately duplicated here (rather than imported) to keep the compressor
 * dependency-light — the orchestrator imports types from this module's
 * sibling `delegate-envelope-shape`, and reaching back across the boundary
 * for a 200-char constant would re-introduce the cycle the shape module
 * was split out to avoid.
 */
export const SHRUNK_ARTIFACT_PREVIEW_MAX_CHARS = 200;
