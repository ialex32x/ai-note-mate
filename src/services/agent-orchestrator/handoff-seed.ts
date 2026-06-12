/**
 * Handoff seed builder (main → sub direction).
 *
 * Validates and pre-populates the sub-agent's handoff store from the
 * main agent's `delegate_task` handoff argument.
 */

import { HANDOFF_VALUE_MAX_BYTES } from "./delegate-payload";
import { type HandoffStore, estimateValueSize, validateSerializable } from "../tools/handoff-toolcall";

/**
 * Error thrown when the main agent supplies a `handoff` object on
 * `delegate_task` that cannot be safely seeded into the sub-agent's
 * handoff store (non-serializable value, or a single value that exceeds
 * the per-key size cap).
 *
 * We surface this as a hard failure (caught by `_dispatchSubAgent` and
 * converted to a `success: false` tool_result) rather than silently
 * dropping or mangling the entry, because:
 *  - the seed is programmatic by design (the main LLM constructed it
 *    deliberately); silently losing one would change the sub-agent's
 *    interpretation of the task in ways the main agent cannot detect;
 *  - the main LLM gets a clear error message and can self-correct on the
 *    next turn (e.g. re-delegate with the value narrowed or moved into
 *    `task` prose).
 *
 * This is asymmetric with the *output* side (`buildDelegatePayload`),
 * which degrades oversized values to `omitted` markers — there the cost
 * of generation has already been paid, so soft degradation is preferable
 * to a hard failure that wastes the sub-agent's whole turn.
 *
 * (The class name retains "Input" for historical reasons — renaming would
 * be a breaking error-class identity change for any consumer catching on
 * `err.name`. The user-facing message strings use the current "handoff"
 * terminology.)
 */
export class InvalidDelegateInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidDelegateInputError";
    }
}

/**
 * Build the initial handoff store for a `delegate_task` dispatch from
 * the main agent's `handoff` argument. Each (key, value) pair becomes a
 * pre-populated entry the sub-agent can read via `read_handoff` (single
 * key OR `keys: string[]` for a batched lookup) / `list_handoff` before
 * deciding how to act.
 *
 * The parameter name `seed` reflects the role: this is the main-side
 * seed of the SAME store the sub-agent will later read and write via
 * its `read_handoff` / `write_handoff` tools. Historically the
 * delegate_task argument was called "inputs", but having two names for
 * one channel proved to be a frequent source of model confusion (LLMs
 * would treat `inputs.X` prose as a separate concept from the handoff
 * store and either skip the read or mis-spell the key).
 *
 * Validation rules (mirrored from the write result tools so the main → sub
 * direction has the same safety guarantees as the sub → main
 * direction):
 *  - `seed` may be `undefined` / `null` / an empty object → returns an
 *    empty store; this is the common case (no structured input).
 *  - `seed` MUST be a plain object (not an array, not a class instance);
 *    keys are strings, values are JSON-serializable per
 *    `validateSerializable`.
 *  - Each value's serialized size MUST be ≤ `HANDOFF_VALUE_MAX_BYTES`.
 *    Oversized entries are REJECTED (not truncated) — see
 *    `InvalidDelegateInputError` doc for rationale.
 *
 * Exported for tests.
 */
export function buildInitialStore(seed?: Record<string, unknown> | null): HandoffStore {
    const store: HandoffStore = new Map();
    if (seed === undefined || seed === null) {
        return store;
    }

    // Reject anything that isn't a plain object. Arrays / Maps / class
    // instances would silently lose structure when treated as a kv bag.
    if (typeof seed !== "object" || Array.isArray(seed)) {
        throw new InvalidDelegateInputError(
            `\`handoff\` must be a plain object mapping string keys to JSON-serializable values; got ${Array.isArray(seed) ? "array" : typeof seed}.`
        );
    }
    const proto: object | null = Object.getPrototypeOf(seed) as object | null;
    if (proto !== null && proto !== Object.prototype) {
        throw new InvalidDelegateInputError(
            `\`handoff\` must be a plain object (Object.prototype or null prototype); got an instance of ${proto?.constructor?.name ?? "<unknown>"}.`
        );
    }

    for (const [key, value] of Object.entries(seed)) {
        // Same key constraints the write_result tools enforce internally —
        // keep them aligned so a key accepted at seed time is also a legal
        // key for the sub-agent's later `write_result` calls.
        if (key.length === 0) {
            throw new InvalidDelegateInputError(`\`handoff\` contains an empty key.`);
        }

        const reason = validateSerializable(value);
        if (reason !== null) {
            throw new InvalidDelegateInputError(
                `\`handoff[${JSON.stringify(key)}]\` is not JSON-serializable: ${reason}`
            );
        }

        const size = estimateValueSize(value);
        if (size > HANDOFF_VALUE_MAX_BYTES) {
            throw new InvalidDelegateInputError(
                `\`handoff[${JSON.stringify(key)}]\` is too large (${size} bytes > ${HANDOFF_VALUE_MAX_BYTES} cap); ` +
                `narrow the value or pass a reference (e.g. a vault path) and let the sub-agent fetch it.`
            );
        }

        store.set(key, value);
    }

    return store;
}
