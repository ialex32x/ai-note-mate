import type NoteAssistantPlugin from "../../../../main";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { checkRegexSafety, isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tools: replace_text (single entry) + batch_replace_text (multi entry)
//
// Two tools sharing one core engine. The core handles any number of
// replacement entries atomically against a single file snapshot. The two
// tool wrappers differ only in schema shape:
//
//   replace_text — flat, single-entry schema. For the common case where
//     the LLM edits one location. Flattening the schema eliminates the
//     nested-array JSON complexity that causes the most validation
//     failures (see session-257 analysis).
//
//   batch_replace_text — `replacements[]` array schema. For atomic
//     multi-edit batches where all patterns MUST match the same pre-edit
//     snapshot. LLMs should use this sparingly and keep batches small
//     (≤4 entries recommended).
//
// Both tools use pattern-based find-and-replace (literal text / regex).
//
// For INSERTIONS (heading-anchored or text-anchored), use `insert_text`.
// For replacing a whole section, use `set_section` (hash-gated).
// ─────────────────────────────────────────────────────────────────────────────

/** One concrete span scheduled for rewrite, regardless of how it was located. */
interface Span {
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
interface ReplacementSummary {
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
     * (search mode with `replace_all: true` + N>1 hits) — a single excerpt
     * would be misleading in that case.
     */
    before_excerpt?: string;
    /** Up to ~240 chars of post-edit context at the same offset. */
    after_excerpt?: string;
    /** True if either excerpt was truncated due to span length. */
    excerpt_truncated?: boolean;
}

const EXCERPT_CONTEXT_CHARS = 30;
const EXCERPT_HARD_CAP = 240;

function buildSpanExcerpts(
    original: string,
    modified: string,
    from: number,
    to: number,
    newFrom: number,
    newTo: number,
): { before: string; after: string; truncated: boolean } {
    const beforeStart = Math.max(0, from - EXCERPT_CONTEXT_CHARS);
    const beforeEnd = Math.min(original.length, to + EXCERPT_CONTEXT_CHARS);
    const afterStart = Math.max(0, newFrom - EXCERPT_CONTEXT_CHARS);
    const afterEnd = Math.min(modified.length, newTo + EXCERPT_CONTEXT_CHARS);

    let before = original.substring(beforeStart, beforeEnd);
    let after = modified.substring(afterStart, afterEnd);
    let truncated = false;
    if (before.length > EXCERPT_HARD_CAP) {
        before = before.substring(0, EXCERPT_HARD_CAP);
        truncated = true;
    }
    if (after.length > EXCERPT_HARD_CAP) {
        after = after.substring(0, EXCERPT_HARD_CAP);
        truncated = true;
    }
    return { before, after, truncated };
}

/** Soft guard: same shape as the pre-array version — see description below. */
const TAG_TOKEN_RE = /^#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u;

function isTagShaped(s: string): boolean {
    return TAG_TOKEN_RE.test(s.trim());
}

// ─────────────────────────────────────────────────────────────────────────────
// Replacement entry — pattern-based find-and-replace only
// ─────────────────────────────────────────────────────────────────────────────

interface SearchEntry {
    kind: "search";
    pattern: string;
    replacement: string;
    replaceAll: boolean;
    expectedCount: number | null;
    force: boolean;
    /** When true, `pattern` is a JavaScript regex (literal, not `new RegExp`). */
    useRegex: boolean;
}

type NormalisedEntry = SearchEntry;

/**
 * Validate one raw replacement entry into a normalised form, or return an
 * error string for the caller to surface. Validation is intentionally
 * strict (typeof checks on every field) because the LLM emits these as
 * JSON and silent coercion has historically caused real-world miscalls.
 */
function normaliseReplacement(
    raw: unknown,
    index: number,
): NormalisedEntry | string {
    if (!raw || typeof raw !== "object") {
        return `replacements[${index}] must be an object.`;
    }
    const r = raw as Record<string, unknown>;

    // Fallback: many LLM coding agents use `old`/`new` by convention
    // (e.g. CodeBuddy's replace_in_file). Silently remap to our canonical
    // `pattern`/`replacement` so the call succeeds without retry overhead.
    if (r["old"] !== undefined && r["pattern"] === undefined) {
        r["pattern"] = r["old"];
    }
    if (r["new"] !== undefined && r["replacement"] === undefined) {
        r["replacement"] = r["new"];
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

    const replaceAllRaw = r["replace_all"];
    if (replaceAllRaw !== undefined && typeof replaceAllRaw !== "boolean") {
        return `replacements[${index}].replace_all must be a boolean if provided.`;
    }
    const replaceAll = replaceAllRaw ?? false;

    // Default expected_count to 1 when replace_all is false (single
    // occurrence). This prevents silent first-match-against-unexpected-
    // content bugs — if the pattern appears 0 or >1 times the call
    // fails before any write. LLM can override by setting explicitly,
    // or pass `expected_count: null` to opt out.
    const expectedRaw = r["expected_count"];
    const hasExplicitExpected = "expected_count" in r;
    let expectedCount: number | null;
    if (hasExplicitExpected) {
        if (expectedRaw !== undefined && expectedRaw !== null) {
            if (!Number.isInteger(expectedRaw) || (expectedRaw as number) < 0) {
                return `replacements[${index}].expected_count must be a non-negative integer if provided.`;
            }
            expectedCount = expectedRaw as number;
        } else {
            // Explicit null/undefined → no assertion
            expectedCount = null;
        }
    } else {
        expectedCount = replaceAll ? null : 1;
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

    return { kind: "search", pattern, replacement, replaceAll, expectedCount, force, useRegex };
}

/**
 * Find every literal occurrence of `needle` in `haystack`. Standard
 * non-overlapping scan: after a hit we advance by `needle.length`, so
 * `findAll("aaaa", "aa")` returns positions [0, 2], not [0, 1, 2].
 */
function findAllOccurrences(haystack: string, needle: string): number[] {
    const out: number[] = [];
    let from = 0;
    while (true) {
        const idx = haystack.indexOf(needle, from);
        if (idx < 0) break;
        out.push(idx);
        from = idx + needle.length;
    }
    return out;
}

/**
 * Find every match of `regex` in `haystack`, returning `{ start, end }`
 * for each non-empty match.  Standard non-overlapping global scan.
 *
 * Zero-length matches are skipped (they would infinite-loop `exec`).
 * The regex is always applied with the `g` (global) flag regardless
 * of how the caller constructs it — this is intentional so that the
 * model can pass a simple `pattern` without worrying about the flag.
 */
interface RegexHit {
    start: number;
    end: number;
}

function findAllOccurrencesRegex(haystack: string, source: string): RegexHit[] {
    const out: RegexHit[] = [];
    const re = new RegExp(source, "gmu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
        if (m[0].length === 0) continue;
        out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/**
 * A regex match with captured groups, used for `$1`-style replacement.
 * `groups[0]` is the full match, `groups[1]` is the first capture, etc.
 * (mirrors `RegExpExecArray` indexing).
 */
interface RegexMatch {
    start: number;
    end: number;
    groups: (string | undefined)[];
}

/** Like `findAllOccurrencesRegex` but also captures groups for `$N` substitution. */
function findAllRegexMatches(haystack: string, source: string): RegexMatch[] {
    const out: RegexMatch[] = [];
    const re = new RegExp(source, "gmu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
        if (m[0].length === 0) continue;
        // Slice to clone the sparse array; undefined entries stay undefined.
        const groups: (string | undefined)[] = [];
        for (let i = 0; i < m.length; i++) groups.push(m[i]);
        out.push({ start: m.index, end: m.index + m[0].length, groups });
    }
    return out;
}

/**
 * Substitute `$1`–`$99`, `$&`, `` $` ``, `$'`, and `$$` in `replacement`
 * using the captured groups from a regex match.
 *
 *   - `$&`       → full match (groups[0])
 *   - `$1`–`$99` → corresponding capture group
 *   - `` $` ``   → text in `original` before this match
 *   - `$'`       → text in `original` after this match
 *   - `$$`       → literal `$`
 *
 * Unmatched groups (undefined) become empty strings.
 */
function replaceWithGroups(
    replacement: string,
    original: string,
    match: RegexMatch,
): string {
    return replacement.replace(
        /\$(?:([1-9]\d?)|([&`']))|\$\$/g,
        (_sub, digits, named) => {
            // $$ → literal $
            if (digits === undefined && named === undefined) return "$";
            // $`  $'  $&
            if (named !== undefined) {
                if (named === "&") return match.groups[0] ?? "";
                if (named === "`") return original.slice(0, match.start);
                if (named === "'") return original.slice(match.end);
            }
            // $1 – $99
            const idx = Number(digits);
            return match.groups[idx] ?? "";
        },
    );
}

/**
 * Heuristic: does `s` look like a regex pattern that was accidentally
 * passed as a literal?  Detects common regex escapes and metacharacters
 * that are virtually never present in literal Obsidian content.
 *
 * This lets us add a targeted hint to the "not found" error when a
 * model writes something like `\\(DevRoot\\)` expecting regex matching
 * but forgets to set `use_regex: true`.
 */
function looksLikeRegex(s: string): boolean {
    // Escaped regex sequences: \\d \\w \\s \\b \\n \\t \\S \\W \\D \\B
    if (/\\[dwstnSWDB]/i.test(s)) return true;
    // Escaped brackets/parens/braces: \( \) \[ \] \{ \}
    // Use a separate regex to avoid a no-useless-escape conflict when
    // putting both \[ and \] in the same character class.
    if (/\\([()[\]{}])/.test(s)) return true;
    // Escaped metacharacters: \. \+ \* \? \| \^ \$
    if (/\\[.+*?|^$]/.test(s)) return true;
    // Common laziness quantifiers: .*? .+?
    if (/\.[*+]\?/.test(s)) return true;
    // Bare character classes: [abc] [^x] — but exclude common Markdown
    // constructs that also use brackets (links, wikilinks, callouts,
    // checkboxes, YAML arrays).
    if (/\[[^\]]+\]/.test(s) && !looksLikeHarmlessBrackets(s)) return true;
    return false;
}

/** Markdown constructs that use [] but are never regex. */
function looksLikeHarmlessBrackets(s: string): boolean {
    // [[wikilinks]] and [text](url)
    if (/\[\[[^\]]*\]\]/.test(s) || /\[[^\]]*\]\([^)]*\)/.test(s)) return true;
    // Obsidian callouts: > [!note], > [!info]-, > [!warning]+ etc.
    if (/>\s*\[!/.test(s)) return true;
    // Task checkboxes: - [ ], - [x], * [ ], 1. [x] etc.
    if (/^[\s>-]*[-*+]\s*\[[\sx]\]/.test(s) || /^\d+\.\s*\[[\sx]\]/.test(s)) return true;
    // YAML array: [a, b, c] or ["a", "b"] — must contain at least one comma
    // to avoid flagging real regex char classes like [aeiou].
    if (/^\[[\w"',. -]*,[\w"',. -]*\]$/.test(s)) return true;
    return false;
}

/**
 * Build a hint string when a literal pattern contains regex-looking
 * constructs — helps the model self-correct without re-reading the file.
 */
function regexHintForLiteral(pattern: string): string {
    if (!looksLikeRegex(pattern)) return "";
    const found: string[] = [];
    if (/\\[dwstnSWDB]/i.test(pattern)) found.push("\\d \\w \\s \\n (escaped backslash sequences)");
    if (/\\[.+*?|^$]/.test(pattern)) found.push("\\ . \\ + \\ * \\ ? \\ | (escaped metacharacters)");
    if (/\\([()[\]{}])/.test(pattern)) found.push("\\( \\) \\[ \\] \\{ \\} (escaped brackets/parens/braces)");
    if (/\.[*+]\?/.test(pattern)) found.push(".*? .+? (lazy quantifiers)");
    if (/\[[^\]]+\]/.test(pattern) && !looksLikeHarmlessBrackets(pattern)) found.push("[...] (character class)");
    const summary = found.length > 0 ? ` Detected: ${found.join(", ")}.` : "";
    return (
        ` HINT: This pattern looks like a regex but use_regex is false (literal match mode).` +
        summary +
        ` Set "use_regex": true if regex matching was intended.`
    );
}

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
function detectSpanOverlap(spans: Span[]): string | null {
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared core: executed by both replace_text and batch_replace_text.
// All replacement entries are validated and applied atomically against
// a single pre-edit file snapshot.
// ─────────────────────────────────────────────────────────────────────────────

async function executeReplaceTextCore(
    plugin: NoteAssistantPlugin,
    chatStream: ChatStream,
    path: string,
    replacements: unknown[],
    dryRun: boolean,
    expectedPreEditMtime: number | undefined,
    _signal: AbortSignal | undefined,
    toolName: string, // "replace_text" or "batch_replace_text" for mutation lock
): Promise<ToolCallResult> {
    const fileOrErr = requireFile(plugin.app, path);
    if (isFailure(fileOrErr)) return fileOrErr;
    const file = fileOrErr;

    const previousMtime = file.stat.mtime;
    if (
        expectedPreEditMtime !== undefined
        && expectedPreEditMtime !== previousMtime
    ) {
        return {
            success: false,
            type: "text",
            content:
                `\`expected_pre_edit_mtime\` mismatch: caller believes file mtime is ${expectedPreEditMtime}, ` +
                `but actual mtime is ${previousMtime}. This usually means the file was modified ` +
                `between your read and this write. Re-read the file (its envelope reports the new mtime) ` +
                `and retry with the updated content.`,
        };
    }

    // Validate every entry up-front so we never partially apply.
    // Collect ALL validation errors instead of failing on the first.
    const normalised: NormalisedEntry[] = [];
    const validationErrors: string[] = [];
    for (let i = 0; i < replacements.length; i++) {
        const result = normaliseReplacement(replacements[i], i);
        if (typeof result === "string") {
            validationErrors.push(result);
        } else {
            normalised.push(result);
        }
    }
    if (validationErrors.length > 0) {
        return {
            success: false,
            type: "text",
            content: validationErrors.join("\n"),
        };
    }

    // Tag-shape soft guard.
    const tagRefusals: string[] = [];
    for (let i = 0; i < normalised.length; i++) {
        const n = normalised[i]!;
        if (n.kind === "search" && !n.force && isTagShaped(n.pattern)) {
            tagRefusals.push(
                `replacements[${i}].pattern='${n.pattern.trim()}' looks like a tag token`,
            );
        }
    }
    if (tagRefusals.length > 0) {
        return {
            success: false,
            type: "text",
            content:
                `Refusing to use ${toolName} on tag-shaped text: ${tagRefusals.join("; ")}. ` +
                `Tags may appear in YAML frontmatter or as inline #tag, and text replacement ` +
                `can partial-match (e.g. '#foo' inside '#foobar') or corrupt frontmatter. ` +
                `Prefer add_files_tags / remove_files_tags / set_files_tags (accepts one or more paths) or rename_tag (vault-wide). ` +
                `If you really intend a raw text replace, retry the offending entries with force=true ` +
                `(running with dry_run=true first is recommended).`,
        };
    }

    const rawOriginal = await plugin.app.vault.read(file);
    // Normalise all line endings to \n so that pattern matching is
    // immune to \r\n vs \n vs \r encoding confusion.  Without this,
    // the LLM spirals: it sends \n → fails → tries \\n → fails →
    // tries \r\n — ten calls to fix one missing blank line (see
    // session-261 "数据漏斗总览" saga).  Actual line-ending choice
    // is meaningless for Markdown and Obsidian normalises on save.
    const original = rawOriginal.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const spans: Span[] = [];
    const summaries: ReplacementSummary[] = [];
    const summaryUniqueSpanIdx: Array<number | null> = [];

    for (let i = 0; i < normalised.length; i++) {
        const n = normalised[i]!;

        const regexMatches = n.useRegex ? findAllRegexMatches(original, n.pattern) : null;
        // Normalise pattern line endings for literal search so that
        // \r\n, \r, and \n all match the normalised \n in the file.
        const literalPattern = n.useRegex ? n.pattern : n.pattern.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const positions: Array<{ start: number; end: number; match?: RegexMatch }> =
            regexMatches
                ? regexMatches.map((m) => ({ start: m.start, end: m.end, match: m }))
                : findAllOccurrences(original, literalPattern).map((pos) => ({ start: pos, end: pos + literalPattern.length }));

        // Check "not found" FIRST — the hint for regex-looking
        // patterns is more actionable than just the count mismatch.
        if (positions.length === 0) {
            const hint = n.useRegex ? "" : regexHintForLiteral(n.pattern);
            return {
                success: false,
                type: "text",
                content:
                    `replacements[${i}]: ${n.useRegex ? "regex" : "pattern text"} not found in file. ` +
                    `${n.useRegex ? "" : hint}` +
                    (n.useRegex ? "" :
                        ` ⚠️ If you reconstructed this pattern from memory, ` +
                        `the exact byte sequence (whitespace, punctuation, table-cell boundaries) likely differs ` +
                        `from what's in the file. Re-read the file or use read_section to get the verbatim text. `) +
                    `No changes were written. Verify the exact text ` +
                    `(whitespace, newlines, casing) with read_file or grep, then retry.`,
            };
        }

        if (n.expectedCount !== null && positions.length !== n.expectedCount) {
            const msg =
                `replacements[${i}]: expected ${n.expectedCount} occurrence(s) of ` +
                `${JSON.stringify(n.pattern)} but found ${positions.length}. `;
            // Pattern was found but count is wrong
            const pos = positions[0]!;
            const ctxStart = Math.max(0, pos.start - 40);
            const ctxEnd = Math.min(original.length, pos.end + 40);
            const context =
                ` Context around first match: ` +
                `${JSON.stringify(original.slice(ctxStart, ctxEnd))}. `;
            return {
                success: false,
                type: "text",
                content:
                    msg + context +
                    `No changes were written. Re-read the file or relax expected_count and retry.`,
            };
        }

        const targetPositions = n.replaceAll ? positions : [positions[0]!];
        const firstSpanIdx = spans.length;
        for (const hit of targetPositions) {
            const effectiveReplacement =
                hit.match
                    ? replaceWithGroups(n.replacement, original, hit.match)
                    : n.replacement;
            spans.push({
                repIndex: i,
                from: hit.start,
                to: hit.end,
                replacement: effectiveReplacement,
            });
        }

        summaries.push({
            index: i,
            mode: "search",
            pattern: n.pattern,
            replacement: n.replacement,
            occurrences_found: positions.length,
            occurrences_replaced: targetPositions.length,
            replace_all: n.replaceAll,
        });
        summaryUniqueSpanIdx.push(targetPositions.length === 1 ? firstSpanIdx : null);
    }

    const overlapErr = detectSpanOverlap(spans);
    if (overlapErr) {
        return { success: false, type: "text", content: overlapErr };
    }

    // Apply spans back-to-front.
    const sortedDesc = [...spans].sort((a, b) => b.from - a.from || b.to - a.to);
    let working = original;
    for (const span of sortedDesc) {
        working = working.substring(0, span.from) + span.replacement + working.substring(span.to);
    }

    // Compute post-edit offsets for excerpt generation.
    const spanPostEdit: Array<{ newFrom: number; newTo: number }> = [];
    for (let k = 0; k < spans.length; k++) {
        spanPostEdit.push({ newFrom: 0, newTo: 0 });
    }
    const sortedAsc = spans
        .map((s, idx) => ({ s, idx }))
        .sort((a, b) => a.s.from - b.s.from || a.s.to - b.s.to);
    let cumulativeDelta = 0;
    for (const { s, idx } of sortedAsc) {
        const newFrom = s.from + cumulativeDelta;
        const newTo = newFrom + s.replacement.length;
        spanPostEdit[idx] = { newFrom, newTo };
        cumulativeDelta += s.replacement.length - (s.to - s.from);
    }

    // Fill before/after excerpts.
    for (let i = 0; i < summaries.length; i++) {
        const uniq = summaryUniqueSpanIdx[i];
        if (uniq === null || uniq === undefined) continue;
        const summary = summaries[i]!;
        const span = spans[uniq]!;
        const post = spanPostEdit[uniq]!;
        const ex = buildSpanExcerpts(original, working, span.from, span.to, post.newFrom, post.newTo);
        summary.before_excerpt = ex.before;
        summary.after_excerpt = ex.after;
        if (ex.truncated) {
            summary.excerpt_truncated = true;
        }
    }

    if (!dryRun) {
        const lockErr = await runVaultMutation(plugin, chatStream, {
            kind: "modify",
            path,
            toolName,
            perform: async () => { await plugin.app.vault.modify(file, working); },
        });
        if (lockErr) return lockErr;
    }

    const totalReplaced = summaries.reduce((s, r) => s + r.occurrences_replaced, 0);
    const newMtime = dryRun ? previousMtime : file.stat.mtime;

    return {
        success: true,
        type: "object",
        content: {
            action: dryRun ? "dry_run_text_replace" : "text_replaced",
            path,
            replacements: summaries,
            total_replacements: totalReplaced,
            dry_run: dryRun,
            previous_mtime: previousMtime,
            new_mtime: newMtime,
            ...(dryRun ? { preview: working } : {}),
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: replace_text (single entry, flat schema)
//
// Single find-and-replace edit on one file. The schema is intentionally
// flat (no nested `replacements[]` array) because LLMs are far less
// likely to make JSON errors on flat objects versus nested arrays.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "replace_text",
                description:
                    "Apply a single find-and-replace edit to a file using pattern matching " +
                    "(literal text or JavaScript regex). " +
                    "\n\n" +
                    "Use this for MODIFYING or DELETING existing content: typo fixes, term renames, " +
                    "deleting a phrase, restructuring inline text. " +
                    "\n\n" +
                    "For INSERTING new content at a heading boundary, use `insert_text` with " +
                    "`heading_path`. For inserting relative to literal text, use `insert_text` " +
                    "with `anchor`. For replacing a whole section, use `set_section` (hash-gated). " +
                    "\n\n" +
                    "⚠️ IMPORTANT: For multiple atomic edits to the SAME file that must all match the " +
                    "pre-edit snapshot, use `batch_replace_text` instead — it accepts a `replacements[]` " +
                    "array and applies all entries atomically. Using multiple `replace_text` calls in sequence " +
                    "will cause later calls to operate on already-modified content, likely missing their target. " +
                    "\n\n" +
                    "Tag-shape guard: a `pattern` value that looks like a single tag token (e.g. `#foo`) is " +
                    "refused by default — raw text replacement cannot tell `#foo` from `#foobar` and risks " +
                    "frontmatter corruption. Set `force=true` only if a literal text replace is genuinely " +
                    "intended (run with `dry_run=true` first). " +
                    "\n\n" +
                    "Pass `expected_pre_edit_mtime` to fail fast on concurrent external edits.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        pattern: {
                            type: "string",
                            description:
                                "Text to find. Must match the file's exact text byte-for-byte " +
                                "(whitespace, punctuation, table pipes). If you are reconstructing the pattern " +
                                "from memory after a prior failure, prefer re-reading the file first — memory-" +
                                "reconstructed patterns often differ on whitespace or adjacent table columns. " +
                                "Set `use_regex: true` to use JavaScript regex syntax (no // delimiters, " +
                                "e.g. `\"foo\\\\s+bar\"`). Must not be empty. Required unless `old` alias is used.",
                        },
                        replacement: {
                            type: "string",
                            description:
                                "REQUIRED. Text to substitute in. Always include this field — use \"\" " +
                                "(empty string) to delete the matched text.",
                        },
                        replace_all: {
                            type: "boolean",
                            description:
                                "If true, replace every occurrence of `pattern`. Defaults to false.",
                        },
                        expected_count: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Defaults to 1 when replace_all is false. " +
                                "If actual occurrences differ, the call fails before any write. " +
                                "Set explicitly to override. Use `replace_all: true` to skip this check.",
                        },
                        force: {
                            type: "boolean",
                            description:
                                "If true, bypass the tag-shape safety guard. Defaults to false.",
                        },
                        use_regex: {
                            type: "boolean",
                            description:
                                "If true, `pattern` is interpreted as a JavaScript regex " +
                                "(literal syntax, no // delimiters). The regex runs with `g`, `m`, and `u` flags. " +
                                "In regex mode, `replacement` supports `$1`–`$99`, `$&`, `` $` ``, `$'`, `$$`.",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and preview without modifying the file. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Optional Unix ms; the file's expected current `mtime`. Chain from a prior " +
                                "read tool's `mtime` or another write tool's `new_mtime`.",
                        },
                    },
                    required: ["path", "replacement"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            // Build a single entry from the flat args.
            // Include `old`/`new` aliases so the normaliseReplacement
            // fallback (many coding agents use old/new by convention) still
            // works in single-entry mode.
            const entry: Record<string, unknown> = {};
            if (args["pattern"] !== undefined) entry["pattern"] = args["pattern"];
            if (args["old"] !== undefined) entry["old"] = args["old"];
            if (args["new"] !== undefined) entry["new"] = args["new"];
            entry["replacement"] = args["replacement"];
            if (args["replace_all"] !== undefined) entry["replace_all"] = args["replace_all"];
            if (args["expected_count"] !== undefined) entry["expected_count"] = args["expected_count"];
            if (args["force"] !== undefined) entry["force"] = args["force"];
            if (args["use_regex"] !== undefined) entry["use_regex"] = args["use_regex"];

            return executeReplaceTextCore(
                plugin,
                chatStream,
                path,
                [entry],
                dryRun,
                expectedPreEditMtime,
                _signal,
                "replace_text",
            );
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: batch_replace_text (multi entry, `replacements[]` array)
//
// Atomic batch of edits against a single file snapshot. Use when multiple
// edits to the same file must all see the same pre-edit content AND you
// don't want intermediate states visible. Keep batches small (≤4 entries
// recommended) — LLMs are less accurate with large nested JSON arrays.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultBatchReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "batch_replace_text",
                description:
                    "Apply multiple atomic edits to a single file via `replacements[]`. " +
                    "Each entry uses `pattern` (literal find-and-replace or regex). " +
                    "All entries match the SAME pre-edit snapshot; matched ranges across entries must be " +
                    "disjoint. Overlapping matches are rejected and nothing is written. " +
                    "\n\n" +
                    "⚠️ Use this tool ONLY when you need multiple atomic edits to the same file. For single " +
                    "edits, prefer `replace_text` — its flat schema is less error-prone. Keep batches small " +
                    "(≤4 entries recommended) to reduce JSON generation errors. " +
                    "\n\n" +
                    "For insertions at heading boundaries, use `insert_text` with `heading_path`. " +
                    "For replacing a whole section, use `set_section`. " +
                    "\n\n" +
                    "Tag-shape guard: a `pattern` that looks like a tag token (e.g. `#foo`) is refused by " +
                    "default. Set `force=true` on that entry if literal text replace is intended. " +
                    "\n\n" +
                    "Pass `expected_pre_edit_mtime` to fail fast on concurrent external edits.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        replacements: {
                            type: "array",
                            minItems: 1,
                            description:
                                "List of edits to apply atomically. Each entry must provide `pattern` " +
                                "(literal text or regex). All entries match the file's pre-edit content; " +
                                "matched ranges across entries must be disjoint. " +
                                "Recommended max: 4 entries per batch.",
                            items: {
                                type: "object",
                                properties: {
                                    pattern: {
                                        type: "string",
                                        description:
                                            "Text to find. Must match the file's exact text byte-for-byte " +
                                            "(whitespace, punctuation, table pipes). If you are reconstructing the pattern " +
                                            "from memory after a prior failure, prefer re-reading the file first — memory-" +
                                            "reconstructed patterns often differ on whitespace or adjacent table columns. " +
                                            "Set `use_regex: true` to use JavaScript regex syntax (no // delimiters, " +
                                            "e.g. `\"foo\\\\s+bar\"`). Must not be empty.",
                                    },
                                    replacement: {
                                        type: "string",
                                        description:
                                            "REQUIRED. Text to substitute in. Use \"\" to delete.",
                                    },
                                    replace_all: {
                                        type: "boolean",
                                        description:
                                            "Replace every occurrence. Defaults to false.",
                                    },
                                    expected_count: {
                                        type: "integer",
                                        minimum: 0,
                                        description:
                                            "Defaults to 1 when replace_all is false. " +
                                            "Fails before write if mismatched. Set `replace_all: true` to skip.",
                                    },
                                    force: {
                                        type: "boolean",
                                        description: "Bypass tag-shape guard. Defaults to false.",
                                    },
                                    use_regex: {
                                        type: "boolean",
                                        description:
                                            "Interpret `pattern` as a JavaScript regex.",
                                    },
                                },
                                required: ["replacement"],
                            },
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, preview without modifying. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail fast on concurrent external edits.",
                        },
                    },
                    required: ["path", "replacements"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            let rawReplacements = args["replacements"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            // Handle double-serialised JSON string.
            let replacements: unknown[];
            if (typeof rawReplacements === "string") {
                try {
                    const parsed = JSON.parse(rawReplacements) as unknown;
                    if (!Array.isArray(parsed)) {
                        return {
                            success: false,
                            type: "text",
                            content:
                                "`replacements` arrived as a JSON string but did not parse as an array. " +
                                "Pass a non-empty array of replacement objects.",
                        };
                    }
                    replacements = parsed;
                } catch {
                    return {
                        success: false,
                        type: "text",
                        content:
                            "`replacements` must be a non-empty array, but received a string that is not valid JSON.",
                    };
                }
            } else {
                replacements = rawReplacements as unknown[];
            }

            if (!Array.isArray(replacements) || replacements.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content: "`replacements` must be a non-empty array.",
                };
            }

            return executeReplaceTextCore(
                plugin,
                chatStream,
                path,
                replacements,
                dryRun,
                expectedPreEditMtime,
                _signal,
                "batch_replace_text",
            );
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test exports — pure helpers reused by tests.
// ─────────────────────────────────────────────────────────────────────────────

export const __TEST_ONLY__ = {
    buildSpanExcerpts,
    EXCERPT_HARD_CAP,
    EXCERPT_CONTEXT_CHARS,
    normaliseReplacement,
    findAllOccurrences,
    findAllOccurrencesRegex,
    findAllRegexMatches,
    replaceWithGroups,
    looksLikeRegex,
    regexHintForLiteral,
    detectSpanOverlap,
    isTagShaped,
    TAG_TOKEN_RE,
};
export type { NormalisedEntry, SearchEntry, Span };
