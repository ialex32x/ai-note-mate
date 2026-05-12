/**
 * Schema validator for `vault_editor`'s result shape.
 *
 * Recognized shape (see `VAULT_EDITOR_PROMPT` workflow step 4):
 *   {
 *     path: string,                          // required, non-empty
 *     strategy: "wholesale" | "surgical" | "lines" | "noop",   // required
 *     edits_applied: number ≥ 0,             // required
 *     previous_size?: number,
 *     new_size?: number,
 *     sample_diff?: Array<{ before_excerpt: string; after_excerpt: string }>,
 *     warnings?: string[],
 *     error?: string,                        // present iff aborted
 *   }
 *
 * Abort shape (`error` present) is also accepted without requiring the
 * edit metadata fields to be meaningful — the editor deliberately emits
 * `{ path, strategy: "noop", edits_applied: 0, error }` when it refuses
 * a task. Only basic type-shape is enforced on the common fields in
 * that case.
 *
 * Like `vault-inspector-validator`, this is a SOFT validator: it returns
 * human-readable issues and the orchestrator attaches them to
 * `extras.result_validation_issues` without dropping the result. The
 * main agent decides what to do — re-delegate, proceed anyway, or ask
 * the user.
 *
 * Caps match `docs/vault-editor-subagent-plan.md` §5.1:
 *   - `sample_diff` ≤ 5 entries
 *   - each excerpt ≤ 240 chars
 *
 * Tuning either cap is a fine-tuning decision; adjust in tandem with
 * the prompt's "Hard limits" section and the matching constants in
 * `replace-text.ts` / `write-file.ts`.
 */

const SAMPLE_DIFF_HARD_CAP = 5;
const EXCERPT_HARD_CAP = 240;
const VALID_STRATEGIES = new Set(["wholesale", "surgical", "lines", "noop"]);

export function validateVaultEditorResult(value: unknown): string[] {
    const issues: string[] = [];
    if (value === undefined || value === null) {
        // Unlike vault_inspector, the editor is expected to ALWAYS emit a
        // result (even abort paths carry `error`). Missing result is a
        // schema slip worth flagging.
        issues.push("result must be set by vault_editor (see prompt workflow step 4).");
        return issues;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
        issues.push("result must be an object.");
        return issues;
    }
    const r = value as Record<string, unknown>;

    const hasError = typeof r["error"] === "string" && r["error"].length > 0;

    // path — required on the happy path. On abort, still expected so
    // the main agent knows which file the sub-agent thought was in
    // scope, but missing path on abort is only a warning.
    const path = r["path"];
    if (typeof path !== "string" || path.length === 0) {
        if (hasError) {
            issues.push("result.path should be a non-empty string even on abort, so the main agent knows which file was in scope.");
        } else {
            issues.push("result.path must be a non-empty string.");
        }
    }

    // strategy
    const strategy = r["strategy"];
    if (typeof strategy !== "string" || !VALID_STRATEGIES.has(strategy)) {
        issues.push(
            `result.strategy must be one of: ${[...VALID_STRATEGIES].map((s) => JSON.stringify(s)).join(", ")}.`,
        );
    }

    // edits_applied
    const editsApplied = r["edits_applied"];
    if (typeof editsApplied !== "number" || !Number.isFinite(editsApplied) || editsApplied < 0) {
        issues.push("result.edits_applied must be a non-negative finite number.");
    } else if (!Number.isInteger(editsApplied)) {
        issues.push("result.edits_applied must be an integer.");
    }

    // optional size fields — if present, must be non-negative numbers.
    for (const key of ["previous_size", "new_size"] as const) {
        const v = r[key];
        if (v !== undefined) {
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
                issues.push(`result.${key}, when present, must be a non-negative finite number.`);
            }
        }
    }

    // sample_diff
    if (r["sample_diff"] !== undefined) {
        const sd = r["sample_diff"];
        if (!Array.isArray(sd)) {
            issues.push("result.sample_diff, when present, must be an array.");
        } else {
            if (sd.length > SAMPLE_DIFF_HARD_CAP) {
                issues.push(
                    `result.sample_diff has ${sd.length} entries; max is ${SAMPLE_DIFF_HARD_CAP} ` +
                    `(pick representative samples, don't dump every edit).`,
                );
            }
            for (let i = 0; i < sd.length; i++) {
                const entry: unknown = sd[i];
                const where = `result.sample_diff[${i}]`;
                if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
                    issues.push(`${where} must be an object with before_excerpt and after_excerpt.`);
                    continue;
                }
                const e = entry as Record<string, unknown>;
                for (const field of ["before_excerpt", "after_excerpt"] as const) {
                    const v = e[field];
                    if (typeof v !== "string") {
                        issues.push(`${where}.${field} must be a string.`);
                    } else if (v.length > EXCERPT_HARD_CAP) {
                        issues.push(
                            `${where}.${field} is too long (${v.length} chars > ${EXCERPT_HARD_CAP} cap); ` +
                            `shorten the sample or split it into two entries.`,
                        );
                    }
                }
            }
        }
    }

    // warnings
    if (r["warnings"] !== undefined) {
        const w = r["warnings"];
        if (!Array.isArray(w)) {
            issues.push("result.warnings, when present, must be an array of strings.");
        } else if (!w.every((x) => typeof x === "string")) {
            issues.push("result.warnings must contain only strings.");
        }
    }

    // error — when present, must be a non-empty string (already
    // checked via hasError; no additional validation).

    return issues;
}
