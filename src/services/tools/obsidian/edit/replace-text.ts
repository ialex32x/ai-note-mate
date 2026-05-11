import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: replace_text
// ─────────────────────────────────────────────────────────────────────────────

export function vaultReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "replace_text",
                description:
                    "Find and replace exact text in a file without rewriting the entire file. " +
                    "Searches for search_text and replaces it with replace_text. " +
                    "By default only the first occurrence is replaced; set replace_all to true to replace every occurrence. " +
                    "Set dry_run to true to preview the changes without modifying the file. " +
                    "Use this for small precise edits such as fixing typos, renaming terms, or deleting specific text. " +
                    "Tag editing caveat: when search_text looks like a single tag token (e.g. '#foo'), this tool will refuse " +
                    "by default because it can partial-match (e.g. '#foo' inside '#foobar') and may corrupt YAML frontmatter. " +
                    "Prefer edit_file_tags (per-file add/remove/set) or rename_tag (vault-wide rename). " +
                    "If you intentionally want to do a raw text replace on a tag token, set force=true (a dry_run first is recommended).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        search_text: {
                            type: "string",
                            description: "Exact text to search for in the file. Must not be empty.",
                        },
                        replace_text: {
                            type: "string",
                            description:
                                "Text to replace search_text with. " +
                                "Use empty string to delete the matched text.",
                        },
                        replace_all: {
                            type: "boolean",
                            description:
                                "If true, replace all occurrences of search_text. " +
                                "Defaults to false (replace first occurrence only).",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, return a preview of the changes without actually modifying the file. " +
                                "Defaults to false.",
                        },
                        force: {
                            type: "boolean",
                            description:
                                "If true, bypass the safety guard that refuses tag-shaped search_text. " +
                                "Defaults to false. Use only when you have verified the impact (e.g. via dry_run).",
                        },
                    },
                    required: ["path", "search_text", "replace_text"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const searchText = args["search_text"] as string;
            const replaceText = args["replace_text"] as string;
            const replaceAll = (args["replace_all"] as boolean) ?? false;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const force = (args["force"] as boolean) ?? false;

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            if (searchText === "") {
                return { success: false, type: "text", content: "search_text must not be empty." };
            }

            // Soft guard: warn (and refuse unless force=true) when search_text is a
            // single tag token. Tags can live in YAML frontmatter or inline as
            // `#tag`, and raw text replacement may partial-match (e.g. `#foo`
            // inside `#foobar`) or corrupt frontmatter.
            if (!force) {
                const trimmed = searchText.trim();
                if (/^#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u.test(trimmed)) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `Refusing to use replace_text on a tag token (${trimmed}). ` +
                            `Tags may appear in YAML frontmatter or as inline #tag, and text replacement ` +
                            `can partial-match (e.g. '#foo' inside '#foobar') or corrupt frontmatter. ` +
                            `Prefer edit_file_tags (per-file) or rename_tag (vault-wide). ` +
                            `If you really intend a raw text replace, retry with force=true ` +
                            `(running dry_run=true first is recommended).`,
                    };
                }
            }

            const content = await plugin.app.vault.read(file);

            if (!content.includes(searchText)) {
                return {
                    success: false,
                    type: "text",
                    content: `search_text not found in file: ${path}`,
                };
            }

            // Count occurrences
            let occurrences = 0;
            let idx = 0;
            while ((idx = content.indexOf(searchText, idx)) !== -1) {
                occurrences++;
                idx += searchText.length;
            }

            const replacedCount = replaceAll ? occurrences : 1;

            let newContent: string;
            if (replaceAll) {
                newContent = content.split(searchText).join(replaceText);
            } else {
                // Replace first occurrence only
                const firstIdx = content.indexOf(searchText);
                newContent =
                    content.substring(0, firstIdx) +
                    replaceText +
                    content.substring(firstIdx + searchText.length);
            }

            if (!dryRun) {
                await plugin.app.vault.modify(file, newContent);
            }

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_text_replace" : "text_replaced",
                    path,
                    occurrences_found: occurrences,
                    occurrences_replaced: replacedCount,
                    dry_run: dryRun,
                },
            };
        },
        requiresConfirmation: true,
    };
}
