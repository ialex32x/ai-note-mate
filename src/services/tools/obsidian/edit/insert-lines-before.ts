import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: insert_lines_before
//
// Insert content before a specific line in a file. Split from `edit_lines`
// when `end_line` changed from exclusive to inclusive, making the old
// "start_line == end_line → insert before line" idiom untenable. Now the
// model uses `edit_lines` for replace/delete and `insert_lines_before` for
// pure insertion.
// ─────────────────────────────────────────────────────────────────────────────

/** Number of context lines to include on each side of the inserted region. */
const AFFECTED_CONTEXT_LINES = 3;

export function vaultInsertLinesBefore(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "insert_lines_before",
                description:
                    "Insert content before a specific line in a file. " +
                    "1-based physical line numbers; leading blank lines count — an empty first line IS line 1. " +
                    "\n\n" +
                    "Use `before_line = totalLines + 1` to append at end of file. " +
                    "Lines are split by `\\n`; do NOT append a trailing `\\n` unless you intend an " +
                    "extra empty line — `'X\\n'` becomes two lines `['X', '']`. " +
                    "\n\n" +
                    "RETURN: `inserted_range` gives the 1-based inclusive line range of the " +
                    "newly inserted content in the post-edit file, plus `snippet` (±" +
                    AFFECTED_CONTEXT_LINES +
                    " lines of context). Response also echoes `previous_mtime` / `new_mtime` " +
                    "for chaining into the next tool's `expected_pre_edit_mtime`.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        before_line: {
                            type: "number",
                            description:
                                "1-based physical line number to insert BEFORE. " +
                                "Content will be placed before this line. " +
                                "Use `before_line = totalLines + 1` to append at end of file.",
                        },
                        content: {
                            type: "string",
                            description:
                                "Content to insert. Do NOT append a trailing '\\n' unless " +
                                "you intend an extra empty line — 'X\\n' becomes two lines ['X', ''].",
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
                    required: ["path", "before_line", "content"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const beforeLine = args["before_line"] as number;
            const content = args["content"] as string;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (typeof content !== "string" || content === "") {
                return {
                    success: false,
                    type: "text",
                    content: "`content` must be a non-empty string.",
                };
            }
            if (!Number.isInteger(beforeLine) || beforeLine < 1) {
                return {
                    success: false,
                    type: "text",
                    content: `\`before_line\` must be a positive integer (got ${beforeLine}).`,
                };
            }

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

            const original = await plugin.app.vault.read(file);
            const lines = original.split("\n");
            const totalLines = lines.length;

            if (beforeLine > totalLines + 1) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`before_line\` (${beforeLine}) exceeds the maximum allowed ${totalLines + 1} ` +
                        `(file has ${totalLines} lines). Use ${totalLines + 1} to append at end of file.`,
                };
            }

            const insertIndex = beforeLine - 1; // 0-based index to insert before
            const newContentLines = content.split("\n");

            const working = lines.slice();
            working.splice(insertIndex, 0, ...newContentLines);

            const resultContent = working.join("\n");
            const newTotalLines = working.length;

            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "insert_lines_before",
                    perform: async () => { await plugin.app.vault.modify(file, resultContent); },
                });
                if (lockErr) return lockErr;
            }

            const newMtime = dryRun ? previousMtime : file.stat.mtime;

            // ── Build affected snippet ──────────────────────────────────────
            const insertedCount = newContentLines.length;
            // 1-based inclusive range of the newly inserted lines in the post-edit file
            const insertedStart = beforeLine; // new content starts at the original before_line position
            const insertedEnd = beforeLine + insertedCount - 1;
            const insertedRange: [number, number] =
                insertedCount > 0 ? [insertedStart, insertedEnd] : [0, 0];

            // Context window around the inserted region
            const snippetStart = Math.max(0, insertIndex - AFFECTED_CONTEXT_LINES);
            const snippetEnd = Math.min(
                newTotalLines,
                insertIndex + insertedCount + AFFECTED_CONTEXT_LINES,
            );
            const snippetLines = working.slice(snippetStart, snippetEnd);
            const snippet: string = snippetLines.join("\n");
            const snippetRange: [number, number] =
                snippetLines.length > 0
                    ? [snippetStart + 1, snippetStart + snippetLines.length]
                    : [0, 0];

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_insert_lines_before" : "insert_lines_before",
                    path,
                    before_line: beforeLine,
                    inserted_range: insertedRange,
                    inserted_lines_count: insertedCount,
                    previous_total_lines: totalLines,
                    new_total_lines: newTotalLines,
                    previous_mtime: previousMtime,
                    new_mtime: newMtime,
                    dry_run: dryRun,
                    snippet,
                    snippet_range: snippetRange,
                    ...(dryRun ? { preview: resultContent } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}
