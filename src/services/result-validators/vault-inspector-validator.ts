/**
 * Schema validator for `vault_inspector`'s digest-mode result.
 *
 * Recognized shapes (see `VAULT_AGENT_PROMPT` Mode B):
 *   - `undefined` / `null`             → no issues (Mode A inspect with
 *                                         no canonical answer).
 *   - `{ digests: [...], focus?: string }` → digest-mode return; each
 *                                              digest entry is checked.
 *   - anything else                    → no issues (Mode A return; we
 *                                         do NOT constrain those).
 *
 * Why "lenient":
 *   - vault_inspector handles BOTH Mode A (locate / inspect) and Mode B
 *     (digest). Treating any non-digest shape as a schema error would
 *     produce a flood of false positives on routine inspect tasks where
 *     a string / array / arbitrary object IS the correct return.
 *   - Within Mode B, small departures (missing `warnings`, key_points
 *     stored as a single string, …) should produce diagnostics — not
 *     data loss. The main agent reads the issues alongside the value
 *     and decides what to do.
 *
 * Caps mirror the prompt-stated limits:
 *   - `summary` ≤ ~80 words ≈ 600 chars; we use 800 to leave headroom
 *     for unicode width.
 *   - `key_points[i]` ≤ ~30 words ≈ 180 chars; cap at 240.
 *   - `key_points` count ≤ 6; `anchors` count ≤ 6.
 *
 * These match `multi-note-digest-workflow-plan.md` §2.4. Bumping them
 * is a fine-tuning decision — adjust in tandem with the prompt limits.
 */
export function validateVaultInspectorResult(value: unknown): string[] {
    const issues: string[] = [];
    if (value === undefined || value === null) return issues;
    if (typeof value !== "object" || Array.isArray(value)) return issues;

    const obj = value as Record<string, unknown>;
    if (!("digests" in obj)) {
        // Mode A (inspect / locate) — no digest expected.
        return issues;
    }

    const digests = obj["digests"];
    if (!Array.isArray(digests)) {
        issues.push(`result.digests must be an array; got ${typeof digests}.`);
        return issues;
    }
    if (digests.length === 0) {
        issues.push(
            `result.digests is empty — every input path must have a digest entry ` +
            `(use summary "(not relevant: ...)" for irrelevant files).`,
        );
        return issues;
    }

    const SUMMARY_HARD_CAP = 800;
    const KEY_POINT_HARD_CAP = 240;
    const ANCHORS_HARD_CAP = 6;
    const KEY_POINTS_HARD_CAP = 6;

    for (let i = 0; i < digests.length; i++) {
        const entry: unknown = digests[i];
        const where = `result.digests[${i}]`;
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            issues.push(`${where} must be an object.`);
            continue;
        }
        const e = entry as Record<string, unknown>;

        if (typeof e["path"] !== "string" || e["path"].length === 0) {
            issues.push(`${where}.path must be a non-empty string.`);
        }
        if (typeof e["summary"] !== "string") {
            issues.push(`${where}.summary must be a string.`);
        } else if (e["summary"].length > SUMMARY_HARD_CAP) {
            issues.push(
                `${where}.summary is too long (${e["summary"].length} chars > ${SUMMARY_HARD_CAP} cap); ` +
                `shorten to ≤ 80 words.`,
            );
        }

        if (!Array.isArray(e["key_points"])) {
            issues.push(`${where}.key_points must be an array (empty allowed for irrelevant files).`);
        } else {
            const kp = e["key_points"];
            if (kp.length > KEY_POINTS_HARD_CAP) {
                issues.push(`${where}.key_points has ${kp.length} items; cap is ${KEY_POINTS_HARD_CAP}.`);
            }
            for (let j = 0; j < kp.length; j++) {
                const item: unknown = kp[j];
                if (typeof item !== "string") {
                    issues.push(`${where}.key_points[${j}] must be a string.`);
                } else if (item.length > KEY_POINT_HARD_CAP) {
                    issues.push(
                        `${where}.key_points[${j}] is too long (${item.length} chars > ${KEY_POINT_HARD_CAP} cap); ` +
                        `shorten to ≤ 30 words.`,
                    );
                }
            }
        }

        if (!Array.isArray(e["anchors"])) {
            issues.push(`${where}.anchors must be an array (empty allowed).`);
        } else {
            const anchors = e["anchors"];
            if (anchors.length > ANCHORS_HARD_CAP) {
                issues.push(`${where}.anchors has ${anchors.length} items; cap is ${ANCHORS_HARD_CAP}.`);
            }
            for (let j = 0; j < anchors.length; j++) {
                const a: unknown = anchors[j];
                const aWhere = `${where}.anchors[${j}]`;
                if (a === null || typeof a !== "object" || Array.isArray(a)) {
                    issues.push(`${aWhere} must be an object.`);
                    continue;
                }
                const aObj = a as Record<string, unknown>;
                const hp = aObj["heading_path"];
                if (!Array.isArray(hp) || hp.length === 0) {
                    issues.push(`${aWhere}.heading_path must be a non-empty array of strings.`);
                } else if (!hp.every((s) => typeof s === "string")) {
                    issues.push(`${aWhere}.heading_path must contain only strings.`);
                }
                if (aObj["why"] !== undefined && typeof aObj["why"] !== "string") {
                    issues.push(`${aWhere}.why, when present, must be a string.`);
                }
            }
        }
    }
    return issues;
}
