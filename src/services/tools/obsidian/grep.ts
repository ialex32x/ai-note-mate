import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool, ToolCallResult } from "../../chat-stream";
import type { ToolCapability } from "../../llm-provider";
import { isFailure, isMediaFile, isNonMediaBinaryFile, requireFile } from "./_shared";

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
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_CONTEXT_LINES = 0;
const QUERY_HARD_LIMIT = 20;

interface GrepMatch {
    line: number;
    content: string;
    matched_query: string;
    context_before?: string[];
    context_after?: string[];
}

interface SectionWindow {
    heading: string;
    level: number;
    /** 1-based inclusive */
    start_line: number;
    /** 1-based inclusive */
    end_line: number;
}

/**
 * Locate the section in the file whose heading text equals `sectionName`
 * (case-insensitive, trimmed). The section spans from the heading line
 * (inclusive) up to — but not including — the next heading of the same
 * or shallower level, or EOF.
 *
 * Returns `null` when the heading is not found. We deliberately match by
 * exact heading text rather than substring: section anchoring is a hard
 * scope constraint, and a substring match could silently widen the scope
 * to the wrong section.
 */
function findSection(
    plugin: NoteAssistantPlugin,
    file: import("obsidian").TFile,
    totalLines: number,
    sectionName: string,
): SectionWindow | null {
    const cache = plugin.app.metadataCache.getFileCache(file);
    const headings = cache?.headings ?? [];
    if (headings.length === 0) return null;

    const wanted = sectionName.trim().toLowerCase();
    const idx = headings.findIndex((h) => h.heading.trim().toLowerCase() === wanted);
    if (idx < 0) return null;

    const target = headings[idx]!;
    const startLine = target.position.start.line + 1; // 1-based

    // Find the next heading of equal-or-shallower level — that boundary is
    // where the current section ends. Headings cache is in document order,
    // so a forward scan is sufficient.
    let endLine = totalLines;
    for (let i = idx + 1; i < headings.length; i++) {
        const h = headings[i]!;
        if (h.level <= target.level) {
            endLine = h.position.start.line; // exclusive of the next heading line; convert from 0-based -> 1-based-exclusive == 0-based value
            break;
        }
    }

    return {
        heading: target.heading,
        level: target.level,
        start_line: startLine,
        end_line: Math.max(startLine, endLine),
    };
}

export function vaultGrepFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "grep_file",
                description:
                    "Find lines matching one or more queries within a SINGLE known file, " +
                    "and return their line numbers and matched content. " +
                    "Use this — NOT read_file — when you already know which file to inspect " +
                    "and you need line numbers for specific strings or patterns " +
                    "(e.g. preparing a follow-up edit_lines call, or confirming whether a marker exists). " +
                    "Much cheaper than reading the full file: it skips delivering unrelated lines. " +
                    "Multiple queries are evaluated with OR semantics; each result reports which query it matched. " +
                    "Optional `section` restricts the search to a single heading-anchored region " +
                    "(use get_metadata first to discover heading names if needed). " +
                    "For vault-wide search across many files, use search_content instead.",
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
                        section: {
                            type: "string",
                            description:
                                "Optional heading text to restrict the search to a single section. " +
                                "Matched case-insensitively against exact heading text (no substring). " +
                                "The section spans from the heading line up to the next heading of the same or shallower level. " +
                                "If the heading is not found, the call fails with a clear error so you can retry.",
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
                                "If the cap is hit, `truncated: true` is set in the response.",
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
            const sectionName = args["section"] as string | undefined;
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

            let section: SectionWindow | null = null;
            let scanStart = 1; // 1-based inclusive
            let scanEnd = totalLines; // 1-based inclusive
            if (sectionName !== undefined) {
                section = findSection(plugin, file, totalLines, sectionName);
                if (!section) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `Section '${sectionName}' not found in '${path}'. ` +
                            `Use get_metadata to list available headings, or omit the 'section' parameter to grep the whole file.`,
                    };
                }
                scanStart = section.start_line;
                scanEnd = section.end_line;
            }

            // ── Scan ────────────────────────────────────────────────────────
            const matches: GrepMatch[] = [];
            let truncated = false;

            outer: for (let i = scanStart - 1; i < scanEnd && i < lines.length; i++) {
                const line = lines[i]!;
                for (let q = 0; q < matchers.length; q++) {
                    if (matchers[q]!(line)) {
                        const m: GrepMatch = {
                            line: i + 1,
                            content: line,
                            matched_query: queries[q]!,
                        };
                        if (contextLines > 0) {
                            const beforeStart = Math.max(0, i - contextLines);
                            const afterEnd = Math.min(lines.length - 1, i + contextLines);
                            if (beforeStart < i) m.context_before = lines.slice(beforeStart, i);
                            if (afterEnd > i) m.context_after = lines.slice(i + 1, afterEnd + 1);
                        }
                        matches.push(m);
                        if (matches.length >= maxMatches) {
                            truncated = true;
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
                    truncated,
                },
            };
        },
    };
}
