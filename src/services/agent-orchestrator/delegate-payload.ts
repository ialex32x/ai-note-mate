/**
 * Delegate payload envelope builder.
 *
 * Builds the structured result envelope returned to the main agent for a
 * successful `delegate_task` invocation. Also provides shared constants
 * and the preview helper used during envelope assembly.
 */

import {
    DELEGATE_ENVELOPE_KIND,
    DELEGATE_ENVELOPE_VERSION,
    type DelegatePayload,
    type ArtifactRef,
} from "../delegate-envelope-shape";
import type { ArtifactStore } from "../artifact-store";
import { type HandoffStore, estimateValueSize } from "../tools/handoff-toolcall";
import { getResultValidator } from "../result-validators";

/**
 * Per-key serialized-size cap for values returned via the handoff channel.
 * Values whose `JSON.stringify(value).length` exceeds this cap are dropped
 * from the envelope and replaced with a `{<key>_omitted: true, <key>_size: N}`
 * marker, so the main agent learns the value existed and how big it was
 * without blowing its context window.
 *
 * 32 KB is a balance between "almost all useful structured returns fit"
 * (lists of paths, plans with a handful of steps, verdicts) and "we don't
 * accidentally pull a whole document into main-agent context". If real
 * workloads need more, raise it deliberately rather than chasing the cap.
 */
export const HANDOFF_VALUE_MAX_BYTES = 32 * 1024;

/**
 * Maximum head-preview length (in JSON-stringified characters) embedded
 * in `ArtifactRef.preview`. Kept tight — the preview is meant as a
 * "you'd recognise it if you saw it" hint for the LLM, not a usable
 * fragment of the value. 200 chars is well under the per-key inline
 * cap (32 KB) so an envelope listing many artifacts stays cheap; it's
 * also long enough to surface a leading object key or first list item
 * for orientation. If real workloads find this too short, raise it
 * deliberately rather than chasing the cap.
 */
const ARTIFACT_PREVIEW_MAX_CHARS = 200;

/**
 * Build a short head preview of a value for inclusion in an
 * {@link ArtifactRef}. JSON-stringifies the value and truncates with a
 * clear ellipsis marker so the LLM can tell at a glance that the
 * preview is incomplete. Returns `undefined` when the value cannot be
 * serialized (defence in depth — write_handoff should already have
 * rejected such values at write-time, but a missing preview is strictly
 * better than throwing here mid-envelope-build).
 */
function buildArtifactPreview(value: unknown): string | undefined {
    let json: string;
    try {
        json = JSON.stringify(value);
    } catch {
        return undefined;
    }
    if (json === undefined) return undefined;
    if (json.length <= ARTIFACT_PREVIEW_MAX_CHARS) return json;
    return json.slice(0, ARTIFACT_PREVIEW_MAX_CHARS) + "…";
}

/**
 * Optional dependencies for {@link buildDelegatePayload}. Splitting them
 * out into an options bag (rather than positional args) keeps existing
 * 2- and 3-arg call sites working unchanged and leaves room to add
 * further knobs (size caps, key-prefix override) without another
 * signature break.
 *
 * If `artifactStore` is omitted OR `delegateCallId` is omitted, the
 * function falls back to the pre-E-3 behaviour: oversized values are
 * recorded under `omitted` with `<key>_omitted: true` / `<key>_size: N`
 * markers and the value content is lost. Both being present is the
 * trigger for the "promote to artifact" path; this is intentional —
 * promotion without a parent tool-call context would produce an
 * orphan artifact the LLM cannot discover and recall.
 */
export interface BuildDelegatePayloadOptions {
    /**
     * Per-session artifact store owned by the {@link AgentOrchestrator}'s
     * `SessionRuntime`. When provided alongside {@link delegateCallId},
     * 32 KB < size ≤ 128 KB values are spilled here and an
     * {@link ArtifactRef} is emitted in `payload.artifacts`. When
     * `null` / `undefined`, the spill path is disabled.
     */
    artifactStore?: ArtifactStore | null;
    /**
     * Stable identifier for the current `delegate_task` invocation,
     * used to namespace artifact keys (`auto:<delegateCallId>:<field>`).
     * In production this is the main agent's `toolCallId`; tests pass a
     * synthetic string. Without this we cannot mint a collision-free
     * key, so promotion is silently skipped (and the value falls
     * through to `omitted`) if it's missing.
     */
    delegateCallId?: string;
}

/**
 * Build the envelope returned to the main agent for a successful
 * `delegate_task` invocation. Reads from the RESULT store only —
 * seed entries (main → sub) live in a separate map and are never
 * part of this envelope.
 *
 * Result assembly: when the store contains a key literally named
 * `"result"`, it becomes `payload.result` directly (backward compat
 * with the old single-`write_handoff` convention). Otherwise, ALL
 * store entries are assembled into a single `payload.result` object.
 * The sub-agent simply writes flat keys (path, strategy, count, …)
 * via multiple `write_result` calls; this function does the rest.
 *
 * Three size buckets, applied per (key, value) pair: ...
 *
 *   1. `size ≤ HANDOFF_VALUE_MAX_BYTES` (32 KB) — value is inlined as
 *      `payload.result` (for key `"result"`) or `payload.extras[key]`
 *      (otherwise). Identical to legacy behaviour.
 *   2. `HANDOFF_VALUE_MAX_BYTES < size ≤ singleArtifactCap` (32–128 KB,
 *      iff `options.artifactStore` AND `options.delegateCallId` are
 *      both provided) — value is spilled to the artifact store and an
 *      {@link ArtifactRef} is emitted in `payload.artifacts[key]`. The
 *      store auto-generates a unique key (using the same ID scheme as
 *      profiles); the main LLM then calls `recall_artifact({ key })` on
 *      demand. The value is NOT inlined and NOT recorded under `omitted`.
 *   3. `size > singleArtifactCap` OR (no store / no callId AND size
 *      exceeds 32 KB) OR store rejects with `too_large_for_store` —
 *      value is dropped. `omitted[<key>_omitted] = true` /
 *      `omitted[<key>_size] = N` is recorded as before, and (when the
 *      store actually rejected the put) `omitted[<key>_too_large_for_store]
 *      = true` flags the rejection reason so the LLM understands the
 *      content is unrecoverable rather than just unrequested.
 *
 * Validator policy (unchanged from D-1): when `agentName` matches a
 * registered {@link getResultValidator} entry AND the result was
 * NOT dropped to `omitted`, validator issues are surfaced under
 * `extras.result_validation_issues`. Critically, the validator runs
 * against the *original* value — even when that value is then promoted
 * to an artifact (bucket 2) — because the schema check is on the
 * structured shape, not on the inlined JSON. Skipping validation on a
 * dropped result (bucket 3) preserves the existing rationale: surfacing
 * schema errors about a value the main agent can't see is just noise.
 *
 * Exported for tests.
 */
export function buildDelegatePayload(
    text: string,
    store: HandoffStore,
    agentName?: string,
    options: BuildDelegatePayloadOptions = {},
): DelegatePayload {
    const payload: DelegatePayload = {
        __kind: DELEGATE_ENVELOPE_KIND,
        __v: DELEGATE_ENVELOPE_VERSION,
        text,
    };
    let omitted: Record<string, true | number> | undefined;
    let extras: Record<string, unknown> | undefined;
    let artifacts: Record<string, ArtifactRef> | undefined;
    let resultRetained = false;
    /**
     * The canonical result value. When the store contains a `"result"` key
     * (backward compat), this is its value. Otherwise, all store entries
     * are assembled into a single object and that becomes the result.
     * `undefined` means the store is empty — no structured output.
     */
    let originalResult: unknown;
    /**
     * Accumulator for the "assemble from flat keys" path. Only populated
     * when there is NO `"result"` key.
     */
    let assembledResult: Record<string, unknown> | undefined;

    // Promotion is only enabled when both knobs are supplied. The
    // store-without-callId path is treated identically to no-store: we
    // refuse to mint a key that could collide with another in-flight
    // delegation. Bucket 3 (omitted) absorbs everything that doesn't
    // fit bucket 1 in that case, exactly matching legacy behaviour.
    const promotionEnabled =
        options.artifactStore != null &&
        typeof options.delegateCallId === "string" &&
        options.delegateCallId.length > 0;
    const storeRef = promotionEnabled ? options.artifactStore! : null;
    const callId = promotionEnabled ? options.delegateCallId! : null;

    let hasExplicitResultKey = false;

    for (const [key, value] of store.entries()) {
        const size = estimateValueSize(value);

        if (key === "result") {
            hasExplicitResultKey = true;
            originalResult = value;
        }

        if (size <= HANDOFF_VALUE_MAX_BYTES) {
            // Bucket 1: inline.
            if (key === "result") {
                payload.result = value;
                resultRetained = true;
            } else {
                extras ??= {};
                extras[key] = value;
            }
            continue;
        }

        // Bucket 2 candidate: try to promote to an artifact.
        if (promotionEnabled && storeRef && callId) {
            const putResult = storeRef.put(value, size);
            if (putResult.stored) {
                artifacts ??= {};
                artifacts[key] = {
                    key: putResult.key,
                    size,
                    preview: buildArtifactPreview(value),
                    reason: "oversize",
                };
                continue;
            }
            // Promotion declined (size > singleArtifactCap or
            // size > totalBytesCap). Fall through to bucket 3 with
            // an explicit too_large_for_store flag so the LLM knows
            // it's not just oversize-for-inline but oversize-for-store.
            if (putResult.reason === "too_large_for_store") {
                omitted ??= {};
                omitted[`${key}_omitted`] = true;
                omitted[`${key}_size`] = size;
                omitted[`${key}_too_large_for_store`] = true;
                continue;
            }
            // Defensive default — a future PutResult variant would land
            // here. Treat as a generic drop so the envelope stays valid.
            omitted ??= {};
            omitted[`${key}_omitted`] = true;
            omitted[`${key}_size`] = size;
            continue;
        }

        // Bucket 3: drop with size record. Same shape as legacy so
        // existing main-agent prompts and tests keep working.
        omitted ??= {};
        omitted[`${key}_omitted`] = true;
        omitted[`${key}_size`] = size;
    }

    // Assemble: when there is no explicit "result" key but the store has
    // other entries, package them all into `payload.result` as one object.
    // The sub-agent writes flat keys (path, strategy, edits_applied, …);
    // the main agent sees one `result` object. Backward-compat: if
    // `"result"` was written directly, it's already in `payload.result`.
    if (!hasExplicitResultKey && extras) {
        // Move everything from extras into the assembled result object.
        assembledResult = { ...extras };
        // Size-check: the assembled result as JSON must fit the inline cap.
        // Individual entries already passed the per-key cap above; this
        // checks the combined payload.
        const assembledSize = estimateValueSize(assembledResult);
        if (assembledSize <= HANDOFF_VALUE_MAX_BYTES) {
            payload.result = assembledResult;
            resultRetained = true;
            originalResult = assembledResult;
            extras = undefined; // all consumed
        }
        // If the assembled result exceeds HANDOFF_VALUE_MAX_BYTES, leave
        // entries in `extras` individually — they were each checked above
        // and are either inlined or promoted to artifacts separately.
    }

    // Text overflow: promote the sub-agent's text reply to the artifact
    // store when it's too large to inline. This replaces the old
    // _summarizeResult LLM summarisation path in SubAgent — we keep the
    // full text recoverable instead of throwing away information via a
    // lossy extra LLM call.
    if (text.length > HANDOFF_VALUE_MAX_BYTES) {
        if (promotionEnabled && storeRef && callId) {
            const putResult = storeRef.put(text, text.length);
            if (putResult.stored) {
                artifacts ??= {};
                const agentLabel = agentName ? `"${agentName}"` : 'unknown';
                artifacts["text"] = {
                    key: putResult.key,
                    size: text.length,
                    preview: buildArtifactPreview(text),
                    reason: "oversize",
                };
                payload.text =
                    `[Sub-agent ${agentLabel} full response too large to inline ` +
                    `(${text.length} chars). Stored as artifact "${putResult.key}". ` +
                    `Use recall_artifact({key: "${putResult.key}"}) to retrieve. ` +
                    `Preview available in artifacts.text.preview.]`;
            } else if (putResult.reason === "too_large_for_store") {
                omitted ??= {};
                omitted["text_omitted"] = true;
                omitted["text_size"] = text.length;
                omitted["text_too_large_for_store"] = true;
                const agentLabel = agentName ? `"${agentName}"` : 'unknown';
                payload.text =
                    `[Sub-agent ${agentLabel} response too large ` +
                    `(${text.length} chars) — exceeds both inline and artifact ` +
                    `store limits. Content is unrecoverable.]`;
            }
            // A future PutResult variant would land here — leave text as-is.
        }
        // When no artifact store is available, leave text as-is. The
        // caller (SubAgent) no longer summarises, so the raw full content
        // is inlined. This is acceptable because:
        //   - In normal operation an artifact store is always wired
        //   - When absent (legacy sessions, tests), the LLM's context
        //     window absorbs it (same as pre-artifact behaviour)
    }

    // Run the per-agent validator only when the result is actually
    // observable by the main agent — either inlined (bucket 1) or
    // recoverable via recall (bucket 2). When the result was dropped
    // (bucket 3), surfacing schema errors about a value it can't see
    // would just be noise (cf. the existing `omitted` skip rationale).
    const resultObservable = resultRetained || (artifacts && "result" in artifacts);
    if (resultObservable) {
        const validator = getResultValidator(agentName);
        if (validator) {
            // Validate against the value as the sub-agent produced it,
            // not against the (possibly absent) inlined `payload.result`.
            // For bucket 2, the LLM will pull this exact value via
            // `recall_artifact`; for bucket 1, originalResult === payload.result.
            const issues = validator(originalResult);
            if (issues.length > 0) {
                extras ??= {};
                extras["result_validation_issues"] = issues;
            }
        }
    }

    if (extras) payload.extras = extras;
    if (artifacts) payload.artifacts = artifacts;
    if (omitted) payload.omitted = omitted;
    return payload;
}
