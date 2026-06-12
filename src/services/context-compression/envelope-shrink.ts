import { safeSliceHead } from "../../utils/string-safe";
import {
    DELEGATE_ENVELOPE_KIND,
    DELEGATE_ENVELOPE_VERSION,
    type ArtifactRef,
    type DelegatePayload,
} from "../delegate-envelope-shape";
import type { ArtifactStore } from "../artifact-store";
import { estimateTokens } from "./token-estimation";
import {
    TOOL_RESULT_COLLAPSE_THRESHOLD,
    ENVELOPE_MARKER_SCAN_BYTES,
    ENVELOPE_FIELD_SPILL_MIN_BYTES,
    SHRUNK_ARTIFACT_PREVIEW_MAX_CHARS,
} from "./constants";

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
export function collapseToolResult(toolName: string, rawArgs: string, result: string): string {
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

// ─────────────────────────────────────────────
// Envelope recognition
// ─────────────────────────────────────────────

/**
 * Cheap, allocation-free probe used as a gate before `JSON.parse`.
 * Conservative — false positives here are harmless (the parse step
 * catches them), but false negatives would silently disable envelope
 * recognition, so this only rejects the obvious non-candidates.
 */
export function looksLikeEnvelope(s: string): boolean {
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

// ─────────────────────────────────────────────
// Tool result shrinking
// ─────────────────────────────────────────────

/**
 * Produce a compact replacement for a single oversized tool_result `content`.
 *
 * Used by {@link ContextCompressor.shrinkLargeToolResults} to reduce the token
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
export function shrinkToolResultContent(
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

// ─────────────────────────────────────────────
// Envelope field spill (shrink helper)
// ─────────────────────────────────────────────

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
