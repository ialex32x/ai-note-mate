/**
 * Per-sub-agent result validators.
 *
 * A `ResultValidator` inspects the value the sub-agent put under the
 * reserved key `"result"` and returns a list of human-readable issue
 * descriptions. An empty list means the value matched the agent's
 * expected schema; a non-empty list is surfaced (NOT enforced) on the
 * envelope returned to the main agent under
 * `extras.result_validation_issues` so the main LLM can decide whether
 * to re-delegate, narrow the scope, or proceed anyway.
 *
 * Soft-degradation policy: validators MUST NOT mutate or drop the
 * `result` value. The sub-agent has already paid the generation cost; a
 * hard rejection here would waste the entire turn for a recoverable
 * schema slip. The main LLM is in a better position than this module to
 * choose between "use as-is", "synthesize around the gaps", and "re-
 * delegate".
 *
 * To register a new validator:
 *  1. Implement `(value: unknown) => string[]` here (or import from a
 *     domain module) and add it to `RESULT_VALIDATORS` keyed by the
 *     sub-agent name (the same string used in
 *     `delegate_task({ agent: "..." })`).
 *  2. The validator should be lenient: distinguish between "this value
 *     intentionally has a different shape" (return `[]`) and "this value
 *     looks like it tried to follow the schema but slipped" (return a
 *     descriptive issue list). Do not penalize Mode A returns when the
 *     sub-agent has multiple modes.
 *  3. No file system / network / clock access — these run on the main
 *     thread immediately after the sub-agent completes.
 *
 * The registry is a plain object rather than a Map so callers can do an
 * O(1) lookup without importing collection types, and so subclasses /
 * tests can spread it (`{ ...RESULT_VALIDATORS, foo: ... }`) when
 * temporarily overriding a validator.
 */

import { validateVaultInspectorResult } from "./vault-inspector-validator";
import { validateVaultEditorResult } from "./vault-editor-validator";

export type ResultValidator = (value: unknown) => string[];

export const RESULT_VALIDATORS: Record<string, ResultValidator> = {
    vault_inspector: validateVaultInspectorResult,
    vault_editor: validateVaultEditorResult,
    // future: web_researcher, code_reviewer, ...
};

/**
 * Look up a validator by sub-agent name. Returns `undefined` for
 * unregistered agents — the orchestrator treats that as "no schema
 * constraint", which is the right default for free-form sub-agents.
 */
export function getResultValidator(agentName: string | undefined): ResultValidator | undefined {
    if (agentName === undefined) return undefined;
    return RESULT_VALIDATORS[agentName];
}
