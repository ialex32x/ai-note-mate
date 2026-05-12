// ─────────────────────────────────────────────
// Delegate envelope wire shape
// ─────────────────────────────────────────────
//
// This module holds the *pure shape* (types + literal markers) of the
// envelope `buildDelegatePayload` emits. It is intentionally split out of
// `agent-orchestrator.ts` so that `context-reducer.ts` (and, later,
// `recall_artifact`) can `import` the markers without dragging in the
// orchestrator's full dependency graph — and, crucially, without forming
// a value-level import cycle. `agent-orchestrator.ts` already
// `import type`s `ConversationSummary` from `context-reducer.ts`; once
// the reducer needed to recognise envelopes, that type-only cycle would
// have escalated into a value cycle if the markers had stayed there.
//
// Keep this file dependency-free (no imports). It is the single source
// of truth for the envelope shape contract.

/**
 * Discriminator marker for `DelegatePayload`. Stamped on every envelope
 * by `buildDelegatePayload` so downstream consumers (currently: the
 * context reducer's shrink stage, future: `recall_artifact`) can
 * recognise an envelope JSON in O(1) without shape-sniffing.
 *
 * The marker is intentionally a string literal rather than a Symbol /
 * brand because the envelope is serialized over the wire (the main
 * LLM sees it in its tool_result). See `delegate-envelope-artifact-plan.md`
 * §1.1 for the rationale on choosing an explicit marker over heuristics.
 */
export const DELEGATE_ENVELOPE_KIND = "delegate_envelope" as const;

/**
 * Schema version for `DelegatePayload`. Bump on any breaking change to
 * the envelope shape (adding optional fields is not breaking). Stored
 * alongside `__kind` so the runtime can refuse to consume envelopes it
 * does not understand instead of silently mis-parsing them.
 */
export const DELEGATE_ENVELOPE_VERSION = 1 as const;

/**
 * Why an envelope field was diverted to the artifact store instead of
 * inlined as `result` / under `extras`.
 *
 * - `"oversize"` — the value's serialized size at envelope-build time
 *   exceeded the per-key inline cap (32 KB) but stayed under the
 *   per-artifact store cap (128 KB). Set by `buildDelegatePayload`
 *   (plan §1.6).
 * - `"shrunk"` — the value was originally inlined and survived envelope
 *   build, but a later history-compaction pass spilled it into the store
 *   to reclaim prompt budget. Set by the reducer's envelope branch
 *   (plan §1.5, B-1; see `context-reducer.ts` `shrinkEnvelopeForPrompt`).
 *
 * Sub-agents do not write this directly — only the orchestrator and the
 * reducer do. Kept on the wire so the main LLM can distinguish
 * "always-was-an-artifact" (don't bother re-trying smaller) from
 * "was-fine-but-got-shrunk" (the original delegation produced inline
 * data; you may simply recall it).
 */
export type ArtifactRefReason = "oversize" | "shrunk";

/**
 * Per-field reference parked in `DelegatePayload.artifacts`. Tells the
 * main LLM: "the value for this field is in the artifact store under
 * `key`; recall it via `recall_artifact({ key })` when you actually
 * need the content." The shape is intentionally flat and JSON-friendly
 * so the LLM can read it directly from the envelope without further
 * parsing.
 *
 * Why `key` is here (vs. only being the outer `Record` key): the outer
 * key in `DelegatePayload.artifacts` is the **field name** (`result`,
 * or an `extras` name), which is what the LLM cares about programmatically.
 * The artifact-store handle is opaque (`auto:<delegateCallId>:<field>`)
 * and uninteresting except as the argument to `recall_artifact`. Putting
 * it inside the ref keeps the field-name → store-handle mapping explicit
 * and forward-compatible (e.g. if we later want to namespace keys
 * differently the field-name layer stays stable).
 */
export interface ArtifactRef {
    /**
     * Artifact-store lookup key. Caller passes this verbatim to
     * `recall_artifact({ key })`. Format is implementation-defined and
     * MUST be treated as opaque by the main LLM.
     */
    key: string;
    /** Original serialized byte size of the value. Lets the LLM gauge whether to recall. */
    size: number;
    /**
     * Short head preview of the JSON-serialized value. Capped at ≤ 200
     * characters so the field stays cheap to inline. Absent if the
     * caller chose not to compute one (e.g. binary-ish content).
     */
    preview?: string;
    /** Why the field was diverted. See {@link ArtifactRefReason}. */
    reason: ArtifactRefReason;
}

/**
 * The envelope returned to the main agent as the `delegate_task` tool_result
 * content (after `JSON.stringify`). Always carries `text`; `result` and
 * `extras` are omitted (not set to `null`) when the sub-agent did not
 * populate them, so the JSON stays compact for the common case.
 *
 * The two leading `__kind` / `__v` fields are runtime markers — they exist
 * so the context reducer can distinguish this envelope from any other
 * JSON-shaped tool_result before deciding whether to spill / preserve it
 * (see plan doc §1.1, §1.4). They are intentionally on the wire and the
 * main agent's prompt explicitly tells the LLM it can ignore them.
 *
 * Exported for tests.
 */
export interface DelegatePayload {
    /** Discriminator — always {@link DELEGATE_ENVELOPE_KIND}. Used by the reducer to recognise envelopes. */
    __kind: typeof DELEGATE_ENVELOPE_KIND;
    /** Schema version — always {@link DELEGATE_ENVELOPE_VERSION} on emit; consumers must check before parsing. */
    __v: typeof DELEGATE_ENVELOPE_VERSION;
    /** Human-readable summary — the sub-agent's last assistant text, same as before exchange existed. */
    text: string;
    /** Canonical structured return value, present iff the sub-agent put something under key "result". */
    result?: unknown;
    /** Auxiliary keys the sub-agent put under names other than "result". */
    extras?: Record<string, unknown>;
    /**
     * References to fields that were diverted to the artifact store
     * rather than inlined. Map shape: `{ <fieldName>: ArtifactRef }`,
     * where `<fieldName>` is `"result"` for the canonical return slot
     * or any `extras` name. The main LLM recovers the full content
     * with `recall_artifact({ key: artifacts[fieldName].key })`.
     *
     * Mutually exclusive with `result` / `extras[fieldName]` for the
     * same field name — a field is either inlined or diverted, never
     * both. `omitted` is also mutually exclusive: a field is either
     * inlined, in the store (here), or wholly dropped (`omitted`).
     */
    artifacts?: Record<string, ArtifactRef>;
    /**
     * Per-key oversized-drop markers, e.g. `{ "result_omitted": true,
     * "result_size": 51234 }`. Present iff at least one value was dropped.
     * Sits at the top level (not nested under `extras`) so the main LLM
     * sees it without parsing extras unnecessarily.
     *
     * Used for values too large even for the artifact store
     * (`size > singleArtifactCap`, default 128 KB). Recovery is NOT
     * possible — the main LLM must re-delegate with a narrower scope.
     */
    omitted?: Record<string, true | number>;
}
