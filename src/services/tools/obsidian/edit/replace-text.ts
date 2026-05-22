import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import {
    formatFindSectionError,
    resolveHeadingPathToRange,
    type HeadingNode,
} from "../heading-section";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: replace_text
//
// Single-file, multi-replacement editor. Each item in `replacements`
// targets a span of the SAME pre-edit snapshot of the file via one of two
// modes — `search` (literal text) or `anchor` (heading-path) — overlap is
// detected up-front, and all spans are rewritten back-to-front in one
// atomic write. The two modes coexist so the LLM can pick the cheapest
// locator for each edit:
//
//  - `search`: the legacy mode. Cheap when the model already knows the
//    exact pre-edit text (e.g. typo fix, term rename).
//  - `anchor`: positions the edit by heading path + a `where` mode (replace
//    section, append to body, insert before/after, …). Removes the need
//    to first read the whole file just to construct a long literal
//    `search` string. Pairs with `vault_inspector`'s digest output, where
//    each anchor lands as `digests[i].anchors[j].heading_path`.
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
    replace: string;
}

/** Per-replacement summary returned to the caller. */
interface ReplacementSummary {
    index: number;
    mode: "search" | "anchor";
    /** Populated for search mode. */
    search?: string;
    /** Populated for anchor mode. */
    anchor?: { heading_path: string[]; where: AnchorWhere };
    replace: string;
    occurrences_found: number;
    occurrences_replaced: number;
    replace_all: boolean;
    /**
     * Up to ~240 chars of pre-edit context centred on this replacement's
     * span. Omitted when the replacement produced multiple disjoint spans
     * (search mode with `replace_all: true` + N>1 hits) — a single excerpt
     * would be misleading in that case, and emitting N of them would blow
     * past the caller's context budget. Present for all anchor-mode
     * entries (always 1 span) and for single-hit search entries.
     */
    before_excerpt?: string;
    /** Up to ~240 chars of post-edit context at the same offset. */
    after_excerpt?: string;
    /** True if either excerpt was truncated due to span length. */
    excerpt_truncated?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Excerpt geometry
//
// The structured edit summary embeds a short before/after excerpt so the
// caller (typically the `vault_editor` sub-agent, or the main agent
// consuming its structured result) can describe what changed without
// having to re-read the file. Two knobs control excerpt shape:
//
//   - EXCERPT_CONTEXT_CHARS: how much pre/post context flanks the span
//     on each side. 30 chars is ~5–8 words — enough to anchor the edit
//     to its surrounding sentence, cheap enough that a 5-edit summary
//     still costs < 2.5 KB.
//   - EXCERPT_HARD_CAP: upper bound per excerpt, including flanking
//     context and the replaced span itself. Anchor-mode
//     `replace_section` can produce a span spanning thousands of chars;
//     without a cap the excerpt would swallow the whole section and
//     defeat its purpose. 240 chars matches
//     `multi-note-digest-workflow-plan.md` §2.4's per-item budget.
// ─────────────────────────────────────────────────────────────────────────────
const EXCERPT_CONTEXT_CHARS = 30;
const EXCERPT_HARD_CAP = 240;

/**
 * Build the before/after excerpt pair for a single span. `original` is
 * the pre-edit content, `modified` is the post-edit content, and
 * `newFrom`/`newTo` are the span's offsets in the modified buffer
 * (pre-edit `from`/`to` shifted by any replacements that came before).
 *
 * Truncation strategy is simple and symmetric: take the natural window
 * (span + context), and if it exceeds the hard cap, trim from both ends
 * keeping the span's start anchored at offset ~30 into the excerpt.
 * That biases the visible portion toward the "what you asked to find"
 * side, which is usually the most informative part for an LLM reading
 * the summary.
 */
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
// Replacement entry — discriminated union over locator mode
// ─────────────────────────────────────────────────────────────────────────────

const ANCHOR_WHERE_VALUES = [
    "replace_section",
    "replace_body",
    "append_to_section",
    "prepend_to_body",
    "insert_before_section",
] as const;
type AnchorWhere = typeof ANCHOR_WHERE_VALUES[number];

interface SearchEntry {
    kind: "search";
    search: string;
    replace: string;
    replaceAll: boolean;
    expectedCount: number | null;
    force: boolean;
}

interface AnchorEntry {
    kind: "anchor";
    headingPath: string[];
    where: AnchorWhere;
    replace: string;
    /** Anchor mode is unaffected by the tag guard; force is still honored for symmetry. */
    force: boolean;
}

type NormalisedEntry = SearchEntry | AnchorEntry;

/**
 * Validate one raw replacement entry into a normalised form, or return an
 * error string for the caller to surface. Validation is intentionally
 * strict (typeof checks on every field) because the LLM emits these as
 * JSON and silent coercion has historically caused real-world miscalls.
 *
 * The `search` and `anchor` fields are mutually exclusive — exactly one
 * must be present. We refuse "both" and "neither" loudly rather than
 * picking a default, because either silent choice would land an edit at
 * a different location than the model believed it was targeting.
 */
function normaliseReplacement(
    raw: unknown,
    index: number,
): NormalisedEntry | string {
    if (!raw || typeof raw !== "object") {
        return `replacements[${index}] must be an object.`;
    }
    const r = raw as Record<string, unknown>;

    const replace = r["replace"];
    if (typeof replace !== "string") {
        return `replacements[${index}].replace must be a string.`;
    }

    const hasSearch = r["search"] !== undefined;
    const hasAnchor = r["anchor"] !== undefined;
    if (hasSearch && hasAnchor) {
        return (
            `replacements[${index}] must use either \`search\` or \`anchor\`, not both. ` +
            `\`search\` matches literal text; \`anchor\` positions the edit by heading path. ` +
            `Pick the one that matches how you located the edit, drop the other field.`
        );
    }
    if (!hasSearch && !hasAnchor) {
        return (
            `replacements[${index}] must include either \`search\` (literal text mode) or ` +
            `\`anchor\` (heading-path mode). See the tool description for the difference.`
        );
    }

    const forceRaw = r["force"];
    if (forceRaw !== undefined && typeof forceRaw !== "boolean") {
        return `replacements[${index}].force must be a boolean if provided.`;
    }
    const force = forceRaw ?? false;

    if (hasSearch) {
        const search = r["search"];
        if (typeof search !== "string") {
            return `replacements[${index}].search must be a string.`;
        }
        if (search === "") {
            return `replacements[${index}].search must not be empty.`;
        }

        const replaceAllRaw = r["replace_all"];
        if (replaceAllRaw !== undefined && typeof replaceAllRaw !== "boolean") {
            return `replacements[${index}].replace_all must be a boolean if provided.`;
        }
        const replaceAll = replaceAllRaw ?? false;

        const expectedRaw = r["expected_count"];
        let expectedCount: number | null = null;
        if (expectedRaw !== undefined && expectedRaw !== null) {
            if (!Number.isInteger(expectedRaw) || (expectedRaw as number) < 0) {
                return `replacements[${index}].expected_count must be a non-negative integer if provided.`;
            }
            expectedCount = expectedRaw as number;
        }

        return { kind: "search", search, replace, replaceAll, expectedCount, force };
    }

    // anchor mode
    const anchorRaw = r["anchor"];
    if (!anchorRaw || typeof anchorRaw !== "object" || Array.isArray(anchorRaw)) {
        return `replacements[${index}].anchor must be an object with fields { heading_path, where }.`;
    }
    const a = anchorRaw as Record<string, unknown>;

    const hp = a["heading_path"];
    if (!Array.isArray(hp) || hp.length === 0) {
        return (
            `replacements[${index}].anchor.heading_path must be a non-empty array of heading titles ` +
            `from outermost to innermost (e.g. ["Chapter 2", "Background"]).`
        );
    }
    const headingPath: string[] = [];
    for (let i = 0; i < hp.length; i++) {
        const item: unknown = hp[i];
        if (typeof item !== "string") {
            return `replacements[${index}].anchor.heading_path[${i}] must be a string.`;
        }
        headingPath.push(item);
    }

    const where = a["where"];
    if (typeof where !== "string" || !ANCHOR_WHERE_VALUES.includes(where as AnchorWhere)) {
        return (
            `replacements[${index}].anchor.where must be one of: ` +
            `${ANCHOR_WHERE_VALUES.map((v) => JSON.stringify(v)).join(", ")}.`
        );
    }

    // `replace_all` / `expected_count` make no sense in anchor mode (the
    // anchor resolves to a unique location). Reject them rather than
    // silently ignore so the model learns the right shape.
    if (r["replace_all"] !== undefined) {
        return (
            `replacements[${index}].replace_all is not allowed in anchor mode ` +
            `(an anchor resolves to a unique location).`
        );
    }
    if (r["expected_count"] !== undefined) {
        return (
            `replacements[${index}].expected_count is not allowed in anchor mode ` +
            `(an anchor resolves to a unique location).`
        );
    }

    return {
        kind: "anchor",
        headingPath,
        where: where as AnchorWhere,
        replace,
        force,
    };
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
 * Detect overlapping spans across replacements. Two spans from DIFFERENT
 * replacement entries that touch the same byte range are an ambiguous
 * spec and we reject the whole call — letting "first wins" silently win
 * is the exact class of bug that makes batch editors dangerous.
 *
 * Spans from the SAME replacement cannot overlap by construction
 * (findAllOccurrences already advances past each hit; anchor mode
 * produces a single span), so we only need to check across pairs.
 *
 * Anchor spans of zero length (insertion points) are tolerated as long
 * as no other span occupies their offset.
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
// Anchor-mode geometry: section line range → (offset, offset, replacement text)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the (1-based inclusive) line index of every newline in `text`.
 * `lineStarts[k]` is the offset of the first character of line k+1.
 * `lineStarts[lineStarts.length - 1]` is `text.length` (sentinel).
 */
function buildLineStarts(text: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
    }
    starts.push(text.length); // sentinel — end-of-file as a virtual line start
    return starts;
}

/**
 * Map a 1-based inclusive section range `[startLine, endLine]` (where
 * `endLine` is the 0-based-line of the next heading or totalLines, i.e.
 * one past the last content line in 1-based — see
 * `resolveHeadingPathToRange` for how this is produced) to character
 * offsets in `text`. Returned `[from, to]` is half-open: `from` includes
 * the heading line's first character, `to` is the offset just past the
 * section's last character (i.e. the start of what follows).
 */
function sectionLinesToOffsets(
    lineStarts: number[],
    startLine: number,
    endLine: number,
): { from: number; to: number } {
    // startLine is 1-based; lineStarts is 0-indexed by line number, so
    // the start of line N is at lineStarts[N - 1].
    const from = lineStarts[startLine - 1] ?? 0;
    // endLine is the 1-based line of the next heading (i.e. one past the
    // last content line). Its line-start offset is exactly the section's
    // end-exclusive byte offset.
    // When endLine equals totalLines (no following heading), the section
    // runs to EOF — also captured by lineStarts[endLine - 0]? We pad
    // lineStarts with a sentinel = text.length, so lineStarts[endLine] is
    // valid when endLine equals the number of lines.
    const to = lineStarts[endLine] ?? lineStarts[lineStarts.length - 1]!;
    return { from, to };
}

/**
 * Resolve an anchor-mode entry to a concrete (from, to, replaceText)
 * tuple over `original`. Returns either a span-ready triple or an error
 * string the caller can surface verbatim.
 *
 * The `where` enum is the contract surface; this function is the single
 * place that translates each variant into byte offsets so the prompt
 * documentation and the implementation stay 1:1.
 *
 * Padding rules (insert/append/prepend variants only):
 *  - If the byte before the insertion point is non-newline → prepend `\n`.
 *  - If the byte after the insertion point is non-newline → append `\n`.
 *  This avoids "two paragraphs glued onto the same line" without
 *  trimming the model-supplied text itself.
 */
function resolveAnchorEntry(
    entry: AnchorEntry,
    original: string,
    headings: readonly HeadingNode[],
    lineStarts: number[],
    totalLines: number,
): { from: number; to: number; replace: string } | string {
    // include_subsections=true matches the prompt-level definition of
    // "the section" the LLM thinks about. The non-inclusive variant has
    // no use case in anchor mode (the where modes already model the
    // distinctions the LLM cares about).
    const resolved = resolveHeadingPathToRange(headings, entry.headingPath, totalLines, true);
    if (!resolved.ok) {
        return formatFindSectionError(resolved.error, entry.headingPath);
    }
    const { start_line, end_line } = resolved.section;
    const sectionRange = sectionLinesToOffsets(lineStarts, start_line, end_line);

    // Heading body range = section minus the heading line itself.
    // The heading line spans [sectionStart, lineStarts[start_line]) — i.e.
    // from the heading line's first char up to the start of the next line.
    const headingLineEnd = lineStarts[start_line] ?? sectionRange.to;
    const bodyStart = headingLineEnd;
    const bodyEnd = sectionRange.to;

    switch (entry.where) {
        case "replace_body": {
            // Replace just the body. The heading line stays put.
            // Pad newlines so the new body docks cleanly to the heading line
            // above (which already ends in \n) and to whatever follows
            // (next heading or EOF). This prevents the common failure mode
            // where an empty-bodied section becomes "# Heading<replace># Next"
            // glued together because the model omitted a trailing newline.
            return {
                from: bodyStart,
                to: bodyEnd,
                replace: padForGap(original, bodyStart, bodyEnd, entry.replace),
            };
        }

        case "replace_section": {
            // Same padding concern: when replacing the entire section we
            // still need to keep the surrounding structure intact (the
            // following heading must not be glued onto our last line).
            return {
                from: sectionRange.from,
                to: sectionRange.to,
                replace: padForGap(original, sectionRange.from, sectionRange.to, entry.replace),
            };
        }

        case "prepend_to_body":
            // Insert immediately AFTER the heading line. Need newline
            // padding on both sides so the inserted block doesn't fuse
            // with the next line.
            return {
                from: bodyStart,
                to: bodyStart,
                replace: padForInsertion(original, bodyStart, entry.replace),
            };

        case "append_to_section": {
            // Insert at the very end of the section's body. If the
            // section's last char is mid-line (no trailing newline), pad
            // with a newline first so the insertion is on its own line.
            const at = bodyEnd;
            return {
                from: at,
                to: at,
                replace: padForInsertion(original, at, entry.replace),
            };
        }

        case "insert_before_section": {
            // Insert just before the heading line. Same padding logic;
            // the heading must remain on its own line afterwards.
            const at = sectionRange.from;
            return {
                from: at,
                to: at,
                replace: padForInsertion(original, at, entry.replace),
            };
        }
    }
}

/**
 * Add leading / trailing `\n` to `text` so it docks cleanly between
 * `host[before-1]` (the char immediately before the insertion/replacement)
 * and `host[after]` (the char immediately after). The model-supplied
 * content is preserved verbatim — we only add whitespace, never trim.
 *
 * For a pure insertion (`replace_text`'s `from === to`), call with
 * `before === after === offset`. For a replacement, `before = from` and
 * `after = to`, so the padding decision is made against the actual
 * neighbours of the gap that opens up after the rewrite.
 */
function padForGap(host: string, before: number, after: number, text: string): string {
    let out = text;
    // Leading: only need a separator if there IS a preceding char and it
    // isn't already a newline.
    if (before > 0 && host.charCodeAt(before - 1) !== 10) {
        if (out.length === 0 || out.charCodeAt(0) !== 10) {
            out = "\n" + out;
        }
    }
    // Trailing: only need a separator if there IS a following char and it
    // isn't already a newline.
    if (after < host.length && host.charCodeAt(after) !== 10) {
        if (out.length === 0 || out.charCodeAt(out.length - 1) !== 10) {
            out = out + "\n";
        }
    }
    return out;
}

/**
 * Convenience for the pure-insertion case. Equivalent to `padForGap` with
 * `before === after === offset` — kept as its own name because that's how
 * the call sites read.
 */
function padForInsertion(host: string, offset: number, text: string): string {
    return padForGap(host, offset, offset, text);
}

export function vaultReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "replace_text",
                description:
                    "Apply one or more atomic edits to a single file via `replacements[]`. Each entry uses " +
                    "exactly one locator mode: `search` (literal find-and-replace) OR `anchor` (heading_path " +
                    "+ `where`: replace_section / replace_body / append_to_section / prepend_to_body / " +
                    "insert_before_section). " +
                    "All entries match the SAME pre-edit snapshot; matched ranges across entries must be " +
                    "disjoint. Overlapping matches are rejected and nothing is written. Set `dry_run` to preview. " +
                    "\n\n" +
                    "Mode picking: use `anchor` when the edit aligns with a section boundary or you already " +
                    "have a heading_path from a digest — cheapest because it doesn't require knowing the " +
                    "section's exact text. Use `search` for unstructured edits inside a section (typos, term " +
                    "renames, deleting a phrase). " +
                    "\n\n" +
                    "Tag-shape guard: a `search` value that looks like a single tag token (e.g. `#foo`) is " +
                    "refused by default — raw text replace cannot tell `#foo` from `#foobar` and risks " +
                    "frontmatter corruption. Set that entry's `force=true` only if a literal text replace is " +
                    "genuinely intended (run with `dry_run=true` first). " +
                    "\n\n" +
                    "Pass `expected_pre_edit_mtime` (Unix ms; chain from a prior read tool's `mtime` or another " +
                    "write tool's `new_mtime`) to fail fast on concurrent external edits. The response echoes " +
                    "`previous_mtime` / `new_mtime` for chaining.",
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
                                "List of edits to apply atomically. Each entry must provide exactly one of " +
                                "`search` (literal text mode) or `anchor` (heading-path mode). All entries match " +
                                "the file's pre-edit content; matched ranges across entries must be disjoint.",
                            items: {
                                type: "object",
                                properties: {
                                    search: {
                                        type: "string",
                                        description:
                                            "[search mode] Exact text to search for. Must not be empty. No regex. " +
                                            "Mutually exclusive with `anchor`.",
                                    },
                                    anchor: {
                                        type: "object",
                                        description:
                                            "[anchor mode] Position the edit by heading path. Mutually exclusive " +
                                            "with `search`. The heading path resolves uniquely against the file's " +
                                            "outline; ambiguous or missing paths cause the whole call to fail with a " +
                                            "diagnostic listing the available paths.",
                                        properties: {
                                            heading_path: {
                                                type: "array",
                                                items: { type: "string" },
                                                minItems: 1,
                                                description:
                                                    "Heading titles, outermost → innermost, that the target heading's " +
                                                    "ancestor chain must END WITH. A short tail (even a single leaf " +
                                                    "title) is accepted IF it is unique in the file; otherwise the " +
                                                    "call fails as ambiguous and you must prepend more ancestors. " +
                                                    "Intermediate ancestors must NOT be skipped.",
                                            },
                                            where: {
                                                type: "string",
                                                enum: [...ANCHOR_WHERE_VALUES],
                                                description:
                                                    "Where, relative to the resolved section, to apply `replace`: " +
                                                    "replace_section (replace the WHOLE section including its heading line); " +
                                                    "replace_body (replace the section body, keeping the heading line); " +
                                                    "prepend_to_body (insert immediately after the heading line); " +
                                                    "append_to_section (insert at the section's end, before any sibling/parent heading); " +
                                                    "insert_before_section (insert just before the heading line).",
                                            },
                                        },
                                        required: ["heading_path", "where"],
                                    },
                                    replace: {
                                        type: "string",
                                        description:
                                            "Replacement text. For search mode, '' deletes the match. For anchor " +
                                            "mode insert/append/prepend variants, '' is allowed but unusual.",
                                    },
                                    replace_all: {
                                        type: "boolean",
                                        description:
                                            "[search mode only] If true, replace every occurrence of `search`. " +
                                            "Defaults to false. Not allowed in anchor mode (an anchor resolves to a " +
                                            "unique location).",
                                    },
                                    expected_count: {
                                        type: "integer",
                                        minimum: 0,
                                        description:
                                            "[search mode only] Optional assertion: number of occurrences of " +
                                            "`search` you expect in the pre-edit file. If actual count differs, the " +
                                            "whole call fails before any write. Not allowed in anchor mode.",
                                    },
                                    force: {
                                        type: "boolean",
                                        description:
                                            "If true, bypass the tag-shape safety guard for this entry only " +
                                            "(search mode). Defaults to false. In anchor mode the guard does not " +
                                            "apply; force is accepted for symmetry but has no effect.",
                                    },
                                },
                                required: ["replace"],
                            },
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and preview the result without modifying the file. " +
                                "Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Optional Unix ms; the file's expected current `mtime`. If actual on-disk " +
                                "`mtime` differs, the call fails (concurrent-edit guard). Chain from a prior " +
                                "read tool's `mtime` or another write tool's `new_mtime`.",
                        },
                    },
                    required: ["path", "replacements"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawReplacements = args["replacements"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (!Array.isArray(rawReplacements) || rawReplacements.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content: "`replacements` must be a non-empty array.",
                };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            // Snapshot mtime BEFORE reading the body so race detection sees the
            // pre-mutation value even if Obsidian were to refresh stat mid-call
            // (it does not today; defensive against future internal changes).
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
            const normalised: NormalisedEntry[] = [];
            for (let i = 0; i < rawReplacements.length; i++) {
                const result = normaliseReplacement(rawReplacements[i], i);
                if (typeof result === "string") {
                    return { success: false, type: "text", content: result };
                }
                normalised.push(result);
            }

            // Tag-shape soft guard, applied per entry. Search-mode only —
            // anchor mode resolves to a heading region, not to a tag-shaped
            // literal, so the guard cannot meaningfully fire there.
            const tagRefusals: string[] = [];
            for (let i = 0; i < normalised.length; i++) {
                const n = normalised[i]!;
                if (n.kind === "search" && !n.force && isTagShaped(n.search)) {
                    tagRefusals.push(
                        `replacements[${i}].search='${n.search.trim()}' looks like a tag token`,
                    );
                }
            }
            if (tagRefusals.length > 0) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Refusing to use replace_text on tag-shaped text: ${tagRefusals.join("; ")}. ` +
                        `Tags may appear in YAML frontmatter or as inline #tag, and text replacement ` +
                        `can partial-match (e.g. '#foo' inside '#foobar') or corrupt frontmatter. ` +
                        `Prefer edit_files_tags (per-file) or rename_tag (vault-wide). ` +
                        `If you really intend a raw text replace, retry the offending entries with force=true ` +
                        `(running with dry_run=true first is recommended).`,
                };
            }

            const original = await plugin.app.vault.read(file);

            // Anchor-mode geometry shared across entries: heading outline +
            // line-start offsets are computed once per call. Heading data
            // from MetadataCache reflects the on-disk content — same as
            // what `original` was just read against (Obsidian keeps the
            // cache eagerly synced for in-vault files).
            let lineStarts: number[] | null = null;
            let headings: HeadingNode[] | null = null;
            let totalLines = 0;
            const ensureAnchorContext = (): void => {
                if (lineStarts !== null) return;
                lineStarts = buildLineStarts(original);
                // total lines = number of newline-terminated lines + 1 if the
                // file does not end with a newline. lineStarts has one entry
                // per line plus a sentinel; line count = entries - 1.
                totalLines = lineStarts.length - 1;
                const cache = plugin.app.metadataCache.getFileCache(file);
                headings = (cache?.headings ?? []).map((h) => ({
                    level: h.level,
                    heading: h.heading,
                    line: h.position.start.line,
                }));
            };

            const spans: Span[] = [];
            const summaries: ReplacementSummary[] = [];
            // Parallel to `summaries`: records the single span index in
            // `spans` that this summary is 1:1 with, or null when the
            // summary produced 0 or >1 spans. Only 1:1 summaries get
            // before/after excerpts — see `ReplacementSummary.before_excerpt`
            // doc comment for why.
            const summaryUniqueSpanIdx: Array<number | null> = [];

            for (let i = 0; i < normalised.length; i++) {
                const n = normalised[i]!;

                if (n.kind === "search") {
                    const positions = findAllOccurrences(original, n.search);

                    if (n.expectedCount !== null && positions.length !== n.expectedCount) {
                        return {
                            success: false,
                            type: "text",
                            content:
                                `replacements[${i}]: expected ${n.expectedCount} occurrence(s) of ` +
                                `${JSON.stringify(n.search)} but found ${positions.length}. ` +
                                `No changes were written. Re-read the file or relax expected_count and retry.`,
                        };
                    }

                    if (positions.length === 0) {
                        return {
                            success: false,
                            type: "text",
                            content:
                                `replacements[${i}]: search text not found in file. ` +
                                `No changes were written. Verify the exact text (whitespace, newlines, casing) ` +
                                `with read_file or grep, then retry.`,
                        };
                    }

                    const targetPositions = n.replaceAll ? positions : [positions[0]!];
                    const firstSpanIdx = spans.length;
                    for (const start of targetPositions) {
                        spans.push({
                            repIndex: i,
                            from: start,
                            to: start + n.search.length,
                            replace: n.replace,
                        });
                    }

                    summaries.push({
                        index: i,
                        mode: "search",
                        search: n.search,
                        replace: n.replace,
                        occurrences_found: positions.length,
                        occurrences_replaced: targetPositions.length,
                        replace_all: n.replaceAll,
                    });
                    summaryUniqueSpanIdx.push(targetPositions.length === 1 ? firstSpanIdx : null);
                } else {
                    // anchor mode
                    ensureAnchorContext();
                    const resolved = resolveAnchorEntry(n, original, headings!, lineStarts!, totalLines);
                    if (typeof resolved === "string") {
                        return {
                            success: false,
                            type: "text",
                            content: `replacements[${i}] (anchor): ${resolved}`,
                        };
                    }
                    const spanIdx = spans.length;
                    spans.push({
                        repIndex: i,
                        from: resolved.from,
                        to: resolved.to,
                        replace: resolved.replace,
                    });
                    summaries.push({
                        index: i,
                        mode: "anchor",
                        anchor: { heading_path: n.headingPath, where: n.where },
                        replace: n.replace,
                        // For anchor mode we always operate on a single, uniquely-resolved location.
                        occurrences_found: 1,
                        occurrences_replaced: 1,
                        replace_all: false,
                    });
                    // anchor mode is always 1:1 — excerpt is always computable.
                    summaryUniqueSpanIdx.push(spanIdx);
                }
            }

            const overlapErr = detectSpanOverlap(spans);
            if (overlapErr) {
                return { success: false, type: "text", content: overlapErr };
            }

            // Apply spans back-to-front so earlier offsets stay valid as we
            // splice. Sorting descending by `from` is sufficient because
            // detectSpanOverlap has already guaranteed disjointness.
            const sortedDesc = [...spans].sort((a, b) => b.from - a.from || b.to - a.to);
            let working = original;
            for (const span of sortedDesc) {
                working = working.substring(0, span.from) + span.replace + working.substring(span.to);
            }

            // Compute each span's (newFrom, newTo) in the post-edit buffer.
            // For a span S, newFrom[S] = original from[S] + Σ(delta_i) over
            // all prior spans (those with from[i] < from[S]), where
            // delta_i = replace.length[i] - (to[i] - from[i]). Equivalently,
            // walk spans in ascending `from` order and carry a running total.
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
                const newTo = newFrom + s.replace.length;
                spanPostEdit[idx] = { newFrom, newTo };
                cumulativeDelta += s.replace.length - (s.to - s.from);
            }

            // Fill before/after excerpts for summaries with a unique span.
            for (let i = 0; i < summaries.length; i++) {
                const uniq = summaryUniqueSpanIdx[i];
                if (uniq === null || uniq === undefined) continue;
                const span = spans[uniq]!;
                const post = spanPostEdit[uniq]!;
                const ex = buildSpanExcerpts(original, working, span.from, span.to, post.newFrom, post.newTo);
                summaries[i]!.before_excerpt = ex.before;
                summaries[i]!.after_excerpt = ex.after;
                if (ex.truncated) {
                    summaries[i]!.excerpt_truncated = true;
                }
            }

            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "replace_text",
                    perform: async () => { await plugin.app.vault.modify(file, working); },
                });
                if (lockErr) return lockErr;
            }

            const totalReplaced = summaries.reduce((s, r) => s + r.occurrences_replaced, 0);

            // After modify(), Obsidian updates `file.stat` in place. Dry-run keeps
            // the same value as `previous_mtime` so the caller can still pass the
            // returned `new_mtime` into a follow-up call without a mismatch.
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
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test exports — pure helpers reused by `test/replace-text-anchor.test.ts`.
//
// These are exported so the anchor-geometry logic (which is the
// trickiest, regression-prone part of the new mode) can be tested
// without setting up the full Obsidian plugin / vault mock surface.
// ─────────────────────────────────────────────────────────────────────────────

export const __TEST_ONLY__ = {
    buildLineStarts,
    sectionLinesToOffsets,
    resolveAnchorEntry,
    padForInsertion,
    padForGap,
    buildSpanExcerpts,
    EXCERPT_HARD_CAP,
    EXCERPT_CONTEXT_CHARS,
};
export type { AnchorEntry, AnchorWhere };
