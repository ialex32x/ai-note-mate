/**
 * Replacement normalisation — validation, tag-shape guard, overlap detection.
 *
 * Extracted from replace-text.ts to keep the core engine lean.
 */

import { checkRegexSafety } from "../_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** One concrete span scheduled for rewrite, regardless of how it was located. */
export interface Span {
    /** Index into `replacements`, used for error messages and the result payload. */
    repIndex: number;
    /** Inclusive start offset in the pre-edit content. */
    from: number;
    /** Exclusive end offset in the pre-edit content. */
    to: number;
    /** Replacement string for this span (already includes any normalised padding). */
    replacement: string;
}

/** Per-replacement summary returned to the caller. */
export interface ReplacementSummary {
    index: number;
    mode: "search";
    pattern?: string;
    replacement: string;
    occurrences_found: number;
    occurrences_replaced: number;
    replace_all: boolean;
    /**
     * Up to ~240 chars of pre-edit context centred on this replacement's
     * span. Omitted when the replacement produced multiple disjoint spans
     * (search mode with `occurrence_offset: 0` + N>1 hits) — a single excerpt
     * would be misleading in that case.
     */
    before_excerpt?: string;
    /** Up to ~240 chars of post-edit context at the same offset. */
    after_excerpt?: string;
    /** True if either excerpt was truncated due to span length. */
    excerpt_truncated?: boolean;
}

/** Replacement entry — pattern-based find-and-replace only. */
export interface SearchEntry {
    kind: "search";
    pattern: string;
    replacement: string;
    /**
     * Skip the first N matches before starting replacement.
     * When unset together with `maxReplacements`, the tool enters SAFE MODE:
     * exactly 1 match is expected; 0 or >1 matches fails with diagnostic info.
     */
    occurrenceOffset: number | undefined;
    /**
     * Maximum number of matches to replace (min 1 when set).
     * When unset together with `occurrenceOffset`, the tool enters SAFE MODE.
     * To replace ALL matches, set `occurrenceOffset: 0` without this.
     */
    maxReplacements: number | undefined;
    force: boolean;
    /** When true, `pattern` is a JavaScript regex (literal, not `new RegExp`). */
    useRegex: boolean;
}

export type NormalisedEntry = SearchEntry;

// ─────────────────────────────────────────────────────────────────────────────
// Tag-shape guard
// ─────────────────────────────────────────────────────────────────────────────

/** Soft guard: same shape as the pre-array version — see description below. */
export const TAG_TOKEN_RE = /^#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u;

export function isTagShaped(s: string): boolean {
    return TAG_TOKEN_RE.test(s.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one raw replacement entry into a normalised form, or return an
 * error string for the caller to surface. Validation is intentionally
 * strict (typeof checks on every field) because the LLM emits these as
 * JSON and silent coercion has historically caused real-world miscalls.
 */
export function normaliseReplacement(
    raw: unknown,
    index: number,
): NormalisedEntry | string {
    if (!raw || typeof raw !== "object") {
        return `replacements[${index}] must be an object.`;
    }
    const r = raw as Record<string, unknown>;

    // Fallback: many LLM coding agents use `old`/`new` or `old_text`/`new_text`
    // by convention (e.g. CodeBuddy's replace_in_file). Silently remap to our
    // canonical `pattern`/`replacement` so the call succeeds without retry overhead.
    if (r["old"] !== undefined && r["pattern"] === undefined) {
        r["pattern"] = r["old"];
    }
    if (r["old_text"] !== undefined && r["pattern"] === undefined) {
        r["pattern"] = r["old_text"];
    }
    if (r["new"] !== undefined && r["replacement"] === undefined) {
        r["replacement"] = r["new"];
    }
    if (r["new_text"] !== undefined && r["replacement"] === undefined) {
        r["replacement"] = r["new_text"];
    }

    const replacement = r["replacement"];
    if (typeof replacement !== "string") {
        return `replacements[${index}].replacement must be a string.`;
    }

    const pattern = r["pattern"];
    if (typeof pattern !== "string") {
        return `replacements[${index}].pattern must be a string. Use \`pattern\` for find-and-replace. ` +
            `For insertions at a heading boundary, use \`insert_text\` with \`heading_path\`. ` +
            `For inserting relative to literal text, use \`insert_text\` with \`anchor\`.`;
    }
    if (pattern === "") {
        return `replacements[${index}].pattern must not be empty.`;
    }

    // Reject anchor if present — redirect to insert_text.
    if (r["anchor"] !== undefined) {
        return (
            `replacements[${index}] has \`anchor\` which is no longer supported on replace_text. ` +
            `Heading-anchored insertion has moved to \`insert_text\` — use \`heading_path\` + \`where\` there instead. ` +
            `(If you meant to find-and-replace literal text, use \`pattern\` instead of \`anchor\`.)`
        );
    }

    const forceRaw = r["force"];
    if (forceRaw !== undefined && typeof forceRaw !== "boolean") {
        return `replacements[${index}].force must be a boolean if provided.`;
    }
    const force = forceRaw ?? false;

    // occurrence_offset: skip the first N matches before replacing.
    // Must be a non-negative integer when provided.
    const offsetRaw = r["occurrence_offset"];
    const hasExplicitOffset = "occurrence_offset" in r;
    let occurrenceOffset: number | undefined;
    if (hasExplicitOffset && offsetRaw !== undefined) {
        if (!Number.isInteger(offsetRaw) || (offsetRaw as number) < 0) {
            return `replacements[${index}].occurrence_offset must be a non-negative integer if provided.`;
        }
        occurrenceOffset = offsetRaw as number;
    }

    // max_replacements: cap on how many matches to replace (min 1).
    const maxReplacementsRaw = r["max_replacements"];
    const hasExplicitMaxReplacements = "max_replacements" in r;
    let maxReplacements: number | undefined;
    if (hasExplicitMaxReplacements && maxReplacementsRaw !== undefined) {
        if (!Number.isInteger(maxReplacementsRaw) || (maxReplacementsRaw as number) < 1) {
            return `replacements[${index}].max_replacements must be a positive integer (≥1) if provided.`;
        }
        maxReplacements = maxReplacementsRaw as number;
    }

    // Reject legacy replace_all / expected_count so the LLM gets a clear migration error.
    if ("replace_all" in r) {
        return (
            `replacements[${index}].replace_all is no longer supported. ` +
            `Use 'occurrence_offset' and 'max_replacements' instead. ` +
            `For the old replace_all: true behaviour, set 'occurrence_offset: 0' (no max) to replace all.`
        );
    }
    if ("expected_count" in r) {
        return (
            `replacements[${index}].expected_count is no longer supported. ` +
            `Use 'occurrence_offset' and 'max_replacements' instead. ` +
            `For the old expected_count: N guard, set both parameters to pick the exact range.`
        );
    }

    const useRegexRaw = r["use_regex"];
    if (useRegexRaw !== undefined && typeof useRegexRaw !== "boolean") {
        return `replacements[${index}].use_regex must be a boolean if provided.`;
    }
    const useRegex = useRegexRaw ?? false;

    // Validate regex syntax eagerly so the model gets a clear error
    // instead of a cryptic runtime failure.
    if (useRegex) {
        try {
            new RegExp(pattern);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `replacements[${index}].pattern is not a valid regex: ${msg}.`;
        }
        const unsafe = checkRegexSafety(pattern);
        if (unsafe) {
            return `replacements[${index}].pattern rejected: ${unsafe}`;
        }
    }

    return { kind: "search", pattern, replacement, occurrenceOffset, maxReplacements, force, useRegex };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlap detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect overlapping spans across replacements. Two spans from DIFFERENT
 * replacement entries that touch the same byte range are an ambiguous
 * spec and we reject the whole call — letting "first wins" silently win
 * is the exact class of bug that makes batch editors dangerous.
 *
 * Spans from the SAME replacement cannot overlap by construction
 * (findAllOccurrences already advances past each hit), so we only need
 * to check across pairs.
 */
export function detectSpanOverlap(spans: Span[]): string | null {
    const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (cur.from < prev.to) {
            return (
                `replacements[${prev.repIndex}] and replacements[${cur.repIndex}] match overlapping ` +
                `text ranges in the file (offsets ${prev.from}-${prev.to} vs ${cur.from}-${cur.to}). ` +
                `Make the search strings disjoint, or merge the two replacements into one.`
            );
        }
    }
    return null;
}
