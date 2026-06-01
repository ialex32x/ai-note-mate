import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { checkRegexSafety } from "../_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: search_content
//
// Vault-wide full-text search across all markdown files. Intentionally has
// NO single-file mode — when the file is already known, callers must use
// `grep_file` instead, which is far cheaper and supports section
// anchoring + multi-query OR.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultSearchContent(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "search_content",
                description:
                    "Vault-wide full-text search across ALL markdown files; returns matching files with " +
                    "1-based physical line numbers and surrounding context lines. Leading blank lines are not skipped — an empty first line counts as line 1. " +
                    "Use when the target file is UNKNOWN. " +
                    "If you already know the file, use `grep_file` instead — much cheaper, supports " +
                    "multiple queries at once, and can be scoped to a heading section. Paginated via " +
                    "`skip` / `limit`.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description:
                                "Text or regular expression pattern to search for inside file contents. " +
                                "When use_regex is true, this is treated as a JavaScript regular expression pattern.",
                        },
                        use_regex: {
                            type: "boolean",
                            description:
                                "If true, treat query as a JavaScript regular expression pattern. " +
                                "Defaults to false (plain text search).",
                        },
                        case_sensitive: {
                            type: "boolean",
                            description: "Whether the search is case-sensitive. Defaults to false.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of matching files to skip before collecting results. Defaults to 0. " +
                                "Use together with `limit` for pagination.",
                        },
                        limit: {
                            type: "number",
                            description:
                                "Maximum number of matching files to return per page. Defaults to 10.",
                        },
                        context_lines: {
                            type: "number",
                            description:
                                "Number of lines of context to include around each match. Defaults to 2.",
                        },
                    },
                    required: ["query"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const query = args["query"] as string;
            const caseSensitive = (args["case_sensitive"] as boolean) ?? false;
            const skip = Math.max(0, (args["skip"] as number) ?? 0);
            const limit = Math.max(1, (args["limit"] as number) ?? 10);
            const contextLines = (args["context_lines"] as number) ?? 2;
            const useRegex = (args["use_regex"] as boolean) ?? false;

            // Build matcher
            let matchLine: (line: string) => boolean;
            if (useRegex) {
                const unsafe = checkRegexSafety(query);
                if (unsafe) {
                    return {
                        success: false,
                        type: "text",
                        content: `Regex query rejected: ${unsafe}`,
                    };
                }
                let regex: RegExp;
                try {
                    regex = new RegExp(query, caseSensitive ? "g" : "gi");
                } catch (err) {
                    return {
                        success: false,
                        type: "text",
                        content: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
                    };
                }
                matchLine = (line: string) => {
                    regex.lastIndex = 0;
                    return regex.test(line);
                };
            } else {
                const needle = caseSensitive ? query : query.toLowerCase();
                matchLine = (line: string) => {
                    const haystack = caseSensitive ? line : line.toLowerCase();
                    return haystack.includes(needle);
                };
            }

            const filesToSearch = plugin.app.vault.getMarkdownFiles();

            type FileMatch = {
                path: string;
                occurrences: { line: number; context: string }[];
            };
            const allMatches: FileMatch[] = [];

            for (const file of filesToSearch) {
                const content = await plugin.app.vault.cachedRead(file);
                const lines = content.split("\n");
                const occurrences: { line: number; context: string }[] = [];

                for (let i = 0; i < lines.length; i++) {
                    if (matchLine(lines[i]!)) {
                        const start = Math.max(0, i - contextLines);
                        const end = Math.min(lines.length - 1, i + contextLines);
                        const context = lines
                            .slice(start, end + 1)
                            .map((l, idx) => `${start + idx + 1}: ${l}`)
                            .join("\n");
                        occurrences.push({ line: i + 1, context });
                    }
                }

                if (occurrences.length > 0) {
                    allMatches.push({ path: file.path, occurrences });
                }
            }

            const total = allMatches.length;
            const matches = allMatches.slice(skip, skip + limit);
            const hasMore = skip + matches.length < total;

            return {
                success: true,
                type: "object",
                content: {
                    query,
                    total,
                    count: matches.length,
                    skip,
                    has_more: hasMore,
                    matches,
                },
            };
        },
    };
}
