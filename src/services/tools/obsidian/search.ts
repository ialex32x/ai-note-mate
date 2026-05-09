import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool } from "../../chat-stream";
import type { ToolCapability } from "../../llm-provider";
import { isFailure, requireFile } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_search_files
// ─────────────────────────────────────────────────────────────────────────────

export function vaultSearchFiles(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_search_files",
                description:
                    "Search for files in the vault whose path or filename contains the given keyword. " +
                    "Case-insensitive substring match. " +
                    "Use this when the user wants to find, locate, look for, or search for files by name or path.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Keyword to match against file paths.",
                        },
                        extension: {
                            type: "string",
                            description:
                                "Optional file extension filter, e.g. 'md', 'pdf'. " +
                                "Omit to match all extensions.",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of results to return. Defaults to 20.",
                        },
                    },
                    required: ["query"],
                },
            },
        },
        exec: async (_chatStream, args, _signal) => {
            const query = (args["query"] as string).toLowerCase();
            const extension = args["extension"] as string | undefined;
            const limit = (args["limit"] as number) ?? 20;

            const allFiles = plugin.app.vault.getFiles();
            const results = allFiles
                .filter((f) => {
                    const pathMatch = f.path.toLowerCase().includes(query);
                    const extMatch = extension ? f.extension === extension.replace(/^\./, "") : true;
                    return pathMatch && extMatch;
                })
                .slice(0, limit)
                .map((f) => ({ path: f.path, name: f.name, extension: f.extension }));

            return { success: true, type: "object", content: { query, results } };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_search_content
// ─────────────────────────────────────────────────────────────────────────────

export function vaultSearchContent(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_search_content",
                description:
                    "Full-text search inside file contents. " +
                    "By default searches across all markdown files in the vault. " +
                    "Optionally specify a path to search within a single file only (any file type, not just markdown). " +
                    "Returns matching files with line numbers and surrounding context lines. " +
                    "Use this when the user wants to find text, content, or keywords inside notes " +
                    "(not just by filename), or search within file contents.",
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
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to a specific file to search in. " +
                                "When provided, only this file is searched (any file type). " +
                                "Omit to search across all markdown files in the vault.",
                        },
                        case_sensitive: {
                            type: "boolean",
                            description: "Whether the search is case-sensitive. Defaults to false.",
                        },
                        limit: {
                            type: "number",
                            description:
                                "Maximum number of matching files to return. Defaults to 10.",
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
            const limit = (args["limit"] as number) ?? 10;
            const contextLines = (args["context_lines"] as number) ?? 2;

            const useRegex = (args["use_regex"] as boolean) ?? false;
            const targetPath = args["path"] as string | undefined;

            // Build matcher
            let matchLine: (line: string) => boolean;
            if (useRegex) {
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

            // Determine which files to search
            let filesToSearch: TFile[];
            if (targetPath) {
                const fileOrErr = requireFile(plugin.app, targetPath);
                if (isFailure(fileOrErr)) return fileOrErr;
                filesToSearch = [fileOrErr];
            } else {
                filesToSearch = plugin.app.vault.getMarkdownFiles();
            }

            const matches: {
                path: string;
                occurrences: { line: number; context: string }[];
            }[] = [];

            for (const file of filesToSearch) {
                if (matches.length >= limit) break;

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
                    matches.push({ path: file.path, occurrences });
                }
            }

            return { success: true, type: "object", content: { query, matches } };
        },
    };
}
