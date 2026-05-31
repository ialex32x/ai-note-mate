import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, isMediaFile, isNonMediaBinaryFile, requireFile } from "../_shared";
import {
    formatFindSectionError,
    normalizeHeadingPathArg,
    resolveHeadingPathToRange,
    type HeadingNode,
} from "../heading-section";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: grep_file
//
// Single-file content locator. The cheap middle-ground between:
//   - search_content   (vault-wide; too broad when you already know the file)
//   - read_file        (returns the entire file body when you only needed
//                             a few line numbers)
//
// Designed for the very common pattern of "I know which file; I have a few
// strings/patterns I want to anchor on; give me the line numbers (and just
// enough context to confirm the match) so I can edit later".
//
// Section scoping uses `heading_path` — the same shape `read_section` and
// `replace_text` (anchor mode) accept — so heading addressing stays
// consistent across the read / locate / edit toolchain.
// ─────────────────────────────────────────────────────────────────────────────

// Lowered from 200 → 50 to keep typical grep results comfortably under
// `TOOL_RESULT_COLLAPSE_THRESHOLD` (500 estimated tokens, see
// `context-reducer.ts`). When a `grep_file` result is small enough, the
// reducer's "shrink large tool results" pass leaves it untouched, so the
// concrete line numbers + matched content survive context compression
// even after the model has moved on. With the previous 200 cap, a busy
// grep on a long file routinely produced results that got collapsed to
// `[Tool result truncated: JSON object with keys {...}]` once consumed,
// making the model scan-read the whole file to "re-locate" what it had
// already found. Power users can still request a higher cap via
// `max_matches`; this is just the default.
const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_CONTEXT_LINES = 0;
const QUERY_HARD_LIMIT = 20;
/**
 * Per-line cap for `matches[].content` (and each entry of
 * `context_before` / `context_after` when context is requested). Lines
 * longer than this are truncated with a trailing `…` marker.
 *
 * `grep_file` is a *locate* primitive — its return value is the line
 * NUMBER plus *just enough* of the line to confirm a match. It is not a
 * substitute for `read_file`. Without this cap, a single grep over a
 * file that contains a giant inline data row (e.g. a base64 image, a
 * dumped JSON blob, a table with hundreds of cells per line) could
 * inflate one match to many KB and trip the same "result got shrunk
 * away" failure mode the lowered DEFAULT_MAX_MATCHES is fighting. 240
 * chars matches the existing `key_points` / `sample_diff` excerpt cap
 * used elsewhere in the digest workflow, so the wire shape stays
 * consistent across locate / inspect / edit primitives.
 */
const MATCH_CONTENT_MAX_CHARS = 240;

/** Truncate a single line for inclusion in a match result. */
function clampLineForMatch(line: string): string {
    if (line.length <= MATCH_CONTENT_MAX_CHARS) return line;
    return line.slice(0, MATCH_CONTENT_MAX_CHARS) + "…";
}

interface GrepMatch {
    line: number;
    content: string;
    matched_query: string;
    context_before?: string[];
    context_after?: string[];
}

export function vaultGrepFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "grep_file",
                description:
                    "Find lines matching one or more queries within a SINGLE known file; returns 1-based physical " +
                    "line numbers and matched content. Leading blank lines are not skipped — an empty first line counts as line 1. " +
                    "Prefer this over `read_file` when you already know " +
                    "the file and just need line numbers for specific strings/patterns (e.g. preparing " +
                    "a follow-up `edit_lines` call). Multiple queries are OR-combined; each match " +
                    "reports its `matched_query`. Optional `heading_path` restricts the search to a " +
                    "single heading-anchored region (use `get_metadata` first to discover the outline). " +
                    "For vault-wide search across many files, use `search_content` instead.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to the file to search inside, e.g. 'Notes/MyNote.md'. " +
                                "Must be a text file (markdown or plain text). " +
                                "Binary and media files are rejected.",
                        },
                        queries: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "1 to " + QUERY_HARD_LIMIT + " query strings. Each is matched independently (OR semantics) " +
                                "and reported separately via `matched_query`. " +
                                "When use_regex is true, each entry is a JavaScript regular expression pattern; " +
                                "otherwise plain substring match.",
                        },
                        use_regex: {
                            type: "boolean",
                            description:
                                "If true, treat every entry in `queries` as a JavaScript regular expression pattern. " +
                                "Defaults to false (plain substring match).",
                        },
                        case_sensitive: {
                            type: "boolean",
                            description: "Whether matching is case-sensitive. Defaults to false.",
                        },
                        heading_path: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Optional heading path that restricts the search to a single section. " +
                                "Parameter name is heading_path (not heading or section). Heading titles " +
                                "ordered outermost → innermost (e.g. ['Chapter 2', 'Background']). " +
                                "Matching is exact (case-sensitive, trimmed). A short tail (even a single leaf " +
                                "title) is accepted IF it is unique in the file; otherwise the call fails as " +
                                "ambiguous and you must prepend more ancestors. The section spans from the matched " +
                                "heading line up to the next heading of the same or shallower level (subsections " +
                                "are included). If the path is missing or ambiguous, the call fails with concrete " +
                                "diagnostics so you can refine and retry.",
                        },
                        context: {
                            type: "number",
                            description:
                                "Number of context lines to include before and after each match. " +
                                "Defaults to 0 — line numbers alone are usually enough to plan the next call. " +
                                "Set to 1 or 2 only when you genuinely need to disambiguate similar lines.",
                        },
                        max_matches: {
                            type: "number",
                            description:
                                "Cap on total matches returned across all queries. Defaults to " + DEFAULT_MAX_MATCHES + ". " +
                                "Each match's `content` field is also capped at " + MATCH_CONTENT_MAX_CHARS + " characters (with a " +
                                "trailing `…` when truncated) so a single very long line never dominates the result. " +
                                "The response always echoes this cap as `max_matches` and sets `has_more: true` " +
                                "when the cap is reached (i.e. additional matches may exist beyond what was returned). " +
                                "Treat `has_more` as a normal pagination hint, not an error: ignore it when the current " +
                                "results are sufficient for the task; only narrow the queries (or raise this cap) when " +
                                "you genuinely need the omitted matches.",
                        },
                    },
                    required: ["path", "queries"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawQueries = args["queries"];
            const useRegex = (args["use_regex"] as boolean) ?? false;
            const caseSensitive = (args["case_sensitive"] as boolean) ?? false;
            const contextLines = Math.max(0, (args["context"] as number) ?? DEFAULT_CONTEXT_LINES);
            const maxMatches = Math.max(1, (args["max_matches"] as number) ?? DEFAULT_MAX_MATCHES);

            // ── Validate queries ────────────────────────────────────────────
            if (!Array.isArray(rawQueries) || rawQueries.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content: "queries must be a non-empty array of strings.",
                };
            }
            if (rawQueries.length > QUERY_HARD_LIMIT) {
                return {
                    success: false,
                    type: "text",
                    content: `Too many queries (${rawQueries.length}); maximum is ${QUERY_HARD_LIMIT}. Split into multiple calls or narrow the search.`,
                };
            }
            const queries: string[] = [];
            for (let i = 0; i < rawQueries.length; i++) {
                const q: unknown = rawQueries[i];
                if (typeof q !== "string" || q.length === 0) {
                    return {
                        success: false,
                        type: "text",
                        content: `queries[${i}] must be a non-empty string.`,
                    };
                }
                queries.push(q);
            }

            // ── Validate heading_path (when provided) ───────────────────────
            const headingPathResult = normalizeHeadingPathArg(args, { required: false });
            if (!headingPathResult.ok) {
                return {
                    success: false,
                    type: "text",
                    content: headingPathResult.message,
                };
            }
            const headingPath = headingPathResult.value;

            // ── Resolve file ────────────────────────────────────────────────
            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            if (isMediaFile(file) || isNonMediaBinaryFile(file)) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Cannot grep '${path}': file extension '.${file.extension}' is binary/media and cannot be searched as text.`,
                };
            }

            // ── Build matchers (one per query) ──────────────────────────────
            const matchers: Array<(line: string) => boolean> = [];
            if (useRegex) {
                for (let i = 0; i < queries.length; i++) {
                    const q = queries[i]!;
                    let regex: RegExp;
                    try {
                        regex = new RegExp(q, caseSensitive ? "" : "i");
                    } catch (err) {
                        return {
                            success: false,
                            type: "text",
                            content: `Invalid regular expression in queries[${i}] ('${q}'): ${err instanceof Error ? err.message : String(err)}`,
                        };
                    }
                    matchers.push((line) => regex.test(line));
                }
            } else {
                for (const q of queries) {
                    const needle = caseSensitive ? q : q.toLowerCase();
                    matchers.push((line) => {
                        const haystack = caseSensitive ? line : line.toLowerCase();
                        return haystack.includes(needle);
                    });
                }
            }

            // ── Read file & determine search window ─────────────────────────
            const content = await plugin.app.vault.cachedRead(file);
            const lines = content.split("\n");
            const totalLines = lines.length;

            let section:
                | { heading: string; level: number; start_line: number; end_line: number }
                | null = null;
            let scanStart = 1; // 1-based inclusive
            let scanEnd = totalLines; // exclusive upper bound (loop: i < scanEnd)
            if (headingPath !== null) {
                const cache = plugin.app.metadataCache.getFileCache(file);
                const cachedHeadings: HeadingNode[] = (cache?.headings ?? []).map((h) => ({
                    level: h.level,
                    heading: h.heading,
                    line: h.position.start.line,
                }));
                const resolved = resolveHeadingPathToRange(
                    cachedHeadings,
                    headingPath,
                    totalLines,
                    true,
                );
                if (!resolved.ok) {
                    return {
                        success: false,
                        type: "text",
                        content: formatFindSectionError(resolved.error, headingPath),
                    };
                }
                section = {
                    heading: resolved.section.heading,
                    level: resolved.section.level,
                    start_line: resolved.section.start_line,
                    end_line: resolved.section.end_line,
                };
                // `end_line` is the 0-based exclusive upper bound of the section
                // (equivalently the 1-based line of the next heading), matching
                // how `read_section`'s consumer slices its output.
                scanStart = section.start_line;
                scanEnd = section.end_line;
            }

            // ── Scan ────────────────────────────────────────────────────────
            const matches: GrepMatch[] = [];
            let hasMore = false;

            outer: for (let i = scanStart - 1; i < scanEnd && i < lines.length; i++) {
                const line = lines[i]!;
                for (let q = 0; q < matchers.length; q++) {
                    if (matchers[q]!(line)) {
                        const m: GrepMatch = {
                            line: i + 1,
                            // Per-line truncation keeps a single match from
                            // bloating the whole result when the file has a
                            // very long line (e.g. inline base64, dumped JSON,
                            // wide tables). See `MATCH_CONTENT_MAX_CHARS`.
                            content: clampLineForMatch(line),
                            matched_query: queries[q]!,
                        };
                        if (contextLines > 0) {
                            const beforeStart = Math.max(0, i - contextLines);
                            const afterEnd = Math.min(lines.length - 1, i + contextLines);
                            if (beforeStart < i) {
                                m.context_before = lines.slice(beforeStart, i).map(clampLineForMatch);
                            }
                            if (afterEnd > i) {
                                m.context_after = lines.slice(i + 1, afterEnd + 1).map(clampLineForMatch);
                            }
                        }
                        matches.push(m);
                        if (matches.length >= maxMatches) {
                            hasMore = true;
                            break outer;
                        }
                        // First-matching-query wins for this line; don't double-report
                        // the same line under multiple queries (keeps the result list
                        // 1-to-1 with file lines and avoids inflating max_matches).
                        break;
                    }
                }
            }

            return {
                success: true,
                type: "object",
                content: {
                    path,
                    total_lines: totalLines,
                    queries,
                    section: section
                        ? {
                              heading: section.heading,
                              level: section.level,
                              start_line: section.start_line,
                              end_line: section.end_line,
                          }
                        : null,
                    matches,
                    match_count: matches.length,
                    max_matches: maxMatches,
                    has_more: hasMore,
                },
            };
        },
    };
}
