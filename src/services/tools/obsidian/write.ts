import { TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool, ToolCallResult } from "../../chat-stream";
import type { ToolCapability } from "../../llm-provider";
import { ensureParentFolder, isFailure, requireFile, requireFileExtension, requireFolder } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_create_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultCreateFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_create_file",
                description:
                    "Create a new file in the vault with the given content, or overwrite an existing file. " +
                    "Parent folders are created automatically if they do not exist. " +
                    "Use this when the user wants to create, make, write, save, or store a new note or file.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path for the new file, e.g. 'Notes/NewNote.md'. " +
                                "The file extension is required and will not be inferred — " +
                                "use '.md' for markdown notes.",
                        },
                        content: {
                            type: "string",
                            description: "Text content to write into the file.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
        },
        capabilities: ["create_file", "write_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const content = args["content"] as string;

            const extErr = requireFileExtension(path);
            if (extErr) return extErr;

            const existing = plugin.app.vault.getAbstractFileByPath(path);

            if (existing instanceof TFile) {
                await plugin.app.vault.modify(existing, content);
                return { success: true, type: "object", content: { action: "overwritten", path } };
            }

            await ensureParentFolder(plugin.app, path);
            await plugin.app.vault.create(path, content);
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_append_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultAppendFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_append_file",
                description:
                    "Append text to the end of an existing file in the vault. " +
                    "If the file does not exist, it will be created. " +
                    "Use this when the user wants to add, append, or write more content to a note " +
                    "without overwriting existing content.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to the file, e.g. 'Notes/MyNote.md'. " +
                                "When the file does not yet exist, the extension is required " +
                                "and will not be inferred — use '.md' for markdown notes.",
                        },
                        content: {
                            type: "string",
                            description: "Text to append to the file.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
        },
        capabilities: ["write_file", "create_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const content = args["content"] as string;

            const file = plugin.app.vault.getAbstractFileByPath(path);

            if (file instanceof TFile) {
                await plugin.app.vault.append(file, content);
                return { success: true, type: "object", content: { action: "appended", path } };
            }

            // File doesn't exist — create it. Require an explicit extension so
            // we never silently produce an extension-less file.
            const extErr = requireFileExtension(path);
            if (extErr) return extErr;
            await ensureParentFolder(plugin.app, path);
            await plugin.app.vault.create(path, content);
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_prepend_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultPrependFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_prepend_file",
                description:
                    "Prepend text to the beginning of an existing file in the vault. " +
                    "If the file has YAML frontmatter (delimited by ---), the content is inserted " +
                    "immediately after the closing --- of the frontmatter block. " +
                    "If there is no frontmatter, the content is inserted at the very beginning of the file. " +
                    "If the file does not exist, it will be created with the given content. " +
                    "Use this when the user wants to insert, prepend, or add content to the beginning or top of a note.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to the file, e.g. 'Notes/MyNote.md'. " +
                                "When the file does not yet exist, the extension is required " +
                                "and will not be inferred — use '.md' for markdown notes.",
                        },
                        content: {
                            type: "string",
                            description: "Text to prepend to the file.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
        },
        capabilities: ["write_file", "create_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const contentToPrepend = args["content"] as string;

            const file = plugin.app.vault.getAbstractFileByPath(path);

            if (file instanceof TFile) {
                const existing = await plugin.app.vault.read(file);

                // Detect YAML frontmatter: must start at line 1 with ---
                let newContent: string;
                if (existing.startsWith("---\n") || existing.startsWith("---\r\n")) {
                    // Find the closing --- of frontmatter
                    const closingIdx = existing.indexOf("\n---", 3);
                    if (closingIdx !== -1) {
                        // Insert after the closing --- line
                        const afterClosing = closingIdx + 4; // length of "\n---"
                        const before = existing.substring(0, afterClosing);
                        const after = existing.substring(afterClosing);
                        newContent = before + "\n" + contentToPrepend + after;
                    } else {
                        // Malformed frontmatter (no closing ---), prepend to beginning
                        newContent = contentToPrepend + "\n" + existing;
                    }
                } else {
                    newContent = contentToPrepend + "\n" + existing;
                }

                await plugin.app.vault.modify(file, newContent);
                return { success: true, type: "object", content: { action: "prepended", path } };
            }

            // File doesn't exist — create it. Require an explicit extension so
            // we never silently produce an extension-less file.
            const extErr = requireFileExtension(path);
            if (extErr) return extErr;
            await ensureParentFolder(plugin.app, path);
            await plugin.app.vault.create(path, contentToPrepend);
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_delete_files
// ─────────────────────────────────────────────────────────────────────────────

export function vaultDeleteFiles(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_delete_files",
                description:
                    "Move one or more files to the system trash (safe delete). " +
                    "Files can be recovered from the OS trash if needed. " +
                    "Use this when the user wants to delete, remove, or trash files from the vault. " +
                    "To delete a folder and its contents, use `vault_delete_folder` instead; " +
                    "folder paths passed here will be reported as failures without affecting other entries.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "List of vault-relative file paths to delete. " +
                                "Each entry is processed independently; failures on one path do not stop the others.",
                        },
                    },
                    required: ["paths"],
                },
            },
        },
        capabilities: ["delete_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const rawPaths = args["paths"];
            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return { success: false, type: "text", content: "`paths` must be a non-empty array of strings." };
            }

            // Deduplicate while preserving order to avoid trashing the same file twice.
            const seen = new Set<string>();
            const paths: string[] = [];
            for (const p of rawPaths) {
                if (typeof p !== "string" || p.length === 0) continue;
                if (seen.has(p)) continue;
                seen.add(p);
                paths.push(p);
            }
            if (paths.length === 0) {
                return { success: false, type: "text", content: "`paths` must contain at least one non-empty string." };
            }

            const deleted: string[] = [];
            const failed: { path: string; error: string }[] = [];

            for (const path of paths) {
                const fileOrErr = requireFile(plugin.app, path);
                if (isFailure(fileOrErr)) {
                    const error = typeof fileOrErr.content === "string" ? fileOrErr.content : `Failed to resolve: ${path}`;
                    failed.push({ path, error });
                    continue;
                }
                try {
                    await plugin.app.vault.trash(fileOrErr, true);
                    deleted.push(path);
                } catch (e) {
                    failed.push({ path, error: e instanceof Error ? e.message : String(e) });
                }
            }

            return {
                success: deleted.length > 0,
                type: "object",
                content: { deleted, failed },
            };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_delete_folder
// ─────────────────────────────────────────────────────────────────────────────

export function vaultDeleteFolder(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_delete_folder",
                description:
                    "Delete a folder and all of its contents (files and sub-folders) from the vault. " +
                    "Files are moved to the system trash (recoverable). " +
                    "Use this when the user wants to delete or remove a folder and everything inside it.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the folder to delete, e.g. 'Notes/OldFolder'.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["delete_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const folderOrErr = requireFolder(plugin.app, path);
            if (isFailure(folderOrErr)) return folderOrErr;
            const folder = folderOrErr;

            // Recursively trash all files and delete all sub-folders
            const deleteRecursive = async (f: TFolder) => {
                for (const child of [...f.children]) {
                    if (child instanceof TFile) {
                        await plugin.app.vault.trash(child, true);
                    } else if (child instanceof TFolder) {
                        await deleteRecursive(child);
                        await plugin.app.vault.delete(child);
                    }
                }
            };

            await deleteRecursive(folder);
            await plugin.app.vault.delete(folder);
            return { success: true, type: "object", content: { path } };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_rename_or_move_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultRenameFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_rename_or_move_file",
                description:
                    "Rename AND/OR move a file or folder within the vault in a single atomic operation. " +
                    "Setting `new_path` to a path in a different folder MOVES the file (e.g. 'Notes/A.md' → 'Archive/A.md'); " +
                    "setting it to a different filename in the same folder RENAMES it; you can do both at once. " +
                    "All internal links (wikilinks) pointing to this file are automatically updated according to the user's Obsidian preferences. " +
                    "Parent folders for the new path are created automatically if they do not exist. " +
                    "\n\n" +
                    "ALWAYS use this tool whenever the user wants to rename, move, relocate, or reorganize a file or folder. " +
                    "Do NOT move a file by reading its content with `vault_read_file`, recreating it at the destination with " +
                    "`vault_create_file`, and then deleting the original with `vault_delete_files` — that approach loses wikilink " +
                    "updates, wastes tokens, and can leave duplicate or orphaned files if any step fails. " +
                    "This tool is the only correct way to move/rename inside the vault.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Current vault-relative path of the file or folder, e.g. 'Notes/OldName.md'.",
                        },
                        new_path: {
                            type: "string",
                            description:
                                "New vault-relative path for the file or folder. " +
                                "For files: include the full path with filename and extension, e.g. 'Archive/NewName.md'. " +
                                "Use a different folder prefix to move (e.g. 'Inbox/A.md' → 'Projects/A.md'), " +
                                "a different filename to rename, or change both at once.",
                        },
                    },
                    required: ["path", "new_path"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const newPath = args["new_path"] as string;

            const file = plugin.app.vault.getAbstractFileByPath(path);
            if (!file) {
                return { success: false, type: "text", content: `File or folder not found: ${path}` };
            }

            // For files (not folders), require new_path to carry an explicit
            // extension. Renaming a `.md` to an extension-less name would make
            // Obsidian stop treating it as a note.
            if (file instanceof TFile) {
                const extErr = requireFileExtension(newPath);
                if (extErr) return extErr;
            }

            // Check if target already exists
            const existing = plugin.app.vault.getAbstractFileByPath(newPath);
            if (existing) {
                return {
                    success: false,
                    type: "text",
                    content: `Target path already exists: ${newPath}`,
                };
            }

            await ensureParentFolder(plugin.app, newPath);

            // Use fileManager.renameFile to automatically update all links
            await plugin.app.fileManager.renameFile(file, newPath);

            return {
                success: true,
                type: "object",
                content: {
                    action: "renamed",
                    old_path: path,
                    new_path: newPath,
                    is_folder: file instanceof TFolder,
                },
            };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_replace_text
// ─────────────────────────────────────────────────────────────────────────────

export function vaultReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_replace_text",
                description:
                    "Find and replace exact text in a file without rewriting the entire file. " +
                    "Searches for search_text and replaces it with replace_text. " +
                    "By default only the first occurrence is replaced; set replace_all to true to replace every occurrence. " +
                    "Set dry_run to true to preview the changes without modifying the file. " +
                    "Use this for small precise edits such as fixing typos, renaming terms, or deleting specific text. " +
                    "Tag editing caveat: when search_text looks like a single tag token (e.g. '#foo'), this tool will refuse " +
                    "by default because it can partial-match (e.g. '#foo' inside '#foobar') and may corrupt YAML frontmatter. " +
                    "Prefer vault_edit_file_tags (per-file add/remove/set) or vault_rename_tag (vault-wide rename). " +
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
                            `Refusing to use vault_replace_text on a tag token (${trimmed}). ` +
                            `Tags may appear in YAML frontmatter or as inline #tag, and text replacement ` +
                            `can partial-match (e.g. '#foo' inside '#foobar') or corrupt frontmatter. ` +
                            `Prefer vault_edit_file_tags (per-file) or vault_rename_tag (vault-wide). ` +
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

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_edit_lines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single line-based edit operation. Two shapes:
 *   - { op: "replace", start_line, end_line, content }
 *       Replace inclusive 1-based range [start_line, end_line] with `content`.
 *       To delete a range, pass content: "".
 *   - { op: "insert",  line, content }
 *       Insert `content` BEFORE the 1-based `line`. Use line = totalLines + 1
 *       to append at end of file.
 *
 * All edits in one call refer to line numbers in the SAME pre-edit snapshot
 * of the file. The tool sorts by start position descending and applies them
 * back-to-front so earlier edits never invalidate later ones' line numbers.
 */
interface ReplaceEdit {
    op: "replace";
    start_line: number;
    end_line: number;
    content: string;
}
interface InsertEdit {
    op: "insert";
    line: number;
    content: string;
}
type LineEdit = ReplaceEdit | InsertEdit;

/**
 * Normalise an edit into a half-open zero-based slice [from, to) on the
 * original `lines` array, plus the replacement string.
 *
 *   replace [a, b]       → from = a-1, to = b
 *   insert  before line L → from = L-1, to = L-1   (zero-length slice)
 *
 * This unification lets overlap detection and back-to-front application
 * treat both ops with identical logic.
 */
interface NormalisedEdit {
    /** Index into `args.edits`, used purely for error reporting. */
    index: number;
    /** Original edit, kept for the result payload. */
    raw: LineEdit;
    /** Zero-based, inclusive start of the slice to replace. */
    from: number;
    /** Zero-based, exclusive end of the slice to replace. */
    to: number;
    /** Replacement content (may be empty for deletions; insert always has content). */
    content: string;
}

function normaliseEdit(edit: unknown, index: number, totalLines: number): NormalisedEdit | string {
    if (!edit || typeof edit !== "object") {
        return `edits[${index}] must be an object.`;
    }
    const e = edit as Record<string, unknown>;
    const op = e["op"];

    if (op === "replace") {
        const start = e["start_line"];
        const end = e["end_line"];
        const content = e["content"];
        if (typeof content !== "string") {
            return `edits[${index}] (replace): content must be a string.`;
        }
        if (!Number.isInteger(start) || !Number.isInteger(end)) {
            return `edits[${index}] (replace): start_line and end_line must be integers.`;
        }
        const s = start as number;
        const en = end as number;
        if (s < 1 || en < 1) {
            return `edits[${index}] (replace): start_line and end_line must be >= 1 (got ${s}, ${en}).`;
        }
        if (s > en) {
            return `edits[${index}] (replace): start_line (${s}) must not exceed end_line (${en}).`;
        }
        if (en > totalLines) {
            return `edits[${index}] (replace): end_line (${en}) exceeds file length (${totalLines}).`;
        }
        return {
            index,
            raw: { op: "replace", start_line: s, end_line: en, content },
            from: s - 1,
            to: en,
            content,
        };
    }

    if (op === "insert") {
        const line = e["line"];
        const content = e["content"];
        if (typeof content !== "string") {
            return `edits[${index}] (insert): content must be a string.`;
        }
        if (!Number.isInteger(line)) {
            return `edits[${index}] (insert): line must be an integer.`;
        }
        const l = line as number;
        if (l < 1 || l > totalLines + 1) {
            return `edits[${index}] (insert): line (${l}) must be in [1, ${totalLines + 1}] (use ${totalLines + 1} to append).`;
        }
        return {
            index,
            raw: { op: "insert", line: l, content },
            from: l - 1,
            to: l - 1,
            content,
        };
    }

    return `edits[${index}] has unknown op '${String(op)}'. Expected 'replace' or 'insert'.`;
}

/**
 * Detect overlapping/conflicting edits.
 *
 * Edits are sorted by `from` ascending; we then walk and ensure each next
 * edit starts at or after the previous one's `to`. Two edge cases on
 * zero-length (insert) slices:
 *
 *   - Two inserts AT THE SAME POSITION are ambiguous in ordering and we
 *     reject them. The model should merge them into one insert.
 *   - An insert exactly at the boundary of a replace (e.g. insert before
 *     line 5, replace [5, 7]) is allowed: `prev.to === next.from` is fine.
 */
function detectOverlap(edits: NormalisedEdit[]): string | null {
    const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        // Two inserts at the same anchor: ambiguous order, reject.
        if (prev.from === prev.to && cur.from === cur.to && prev.from === cur.from) {
            return `edits[${prev.index}] and edits[${cur.index}] both insert at the same position; merge them into a single insert.`;
        }
        if (cur.from < prev.to) {
            return `edits[${prev.index}] and edits[${cur.index}] overlap. All edits must reference disjoint ranges of the original file.`;
        }
    }
    return null;
}

export function vaultEditLines(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_edit_lines",
                description:
                    "Apply one or more line-based edits to a file in a single atomic operation. " +
                    "Supports replacing a line range, deleting a range (replace with empty content), " +
                    "and inserting new content before a given line — all in the same call. " +
                    "Lines are 1-based. " +
                    "\n\n" +
                    "IMPORTANT: When you need multiple edits in the same file, you MUST submit them ALL " +
                    "in a single call via the `edits` array. Do NOT split them across multiple calls — " +
                    "every edit's line numbers refer to the file BEFORE any edit is applied, and the tool " +
                    "applies them back-to-front so earlier edits never shift later edits' line numbers. " +
                    "Splitting into multiple calls will use stale line numbers and corrupt the file. " +
                    "\n\n" +
                    "All edits must reference disjoint ranges; overlapping edits are rejected. " +
                    "If validation fails, the file is not modified at all (atomic). " +
                    "Set dry_run to true to preview without modifying the file.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        edits: {
                            type: "array",
                            minItems: 1,
                            description:
                                "List of edits to apply atomically. Each edit's line numbers refer to the " +
                                "file BEFORE any edit is applied. Edits must not overlap.",
                            items: {
                                type: "object",
                                oneOf: [
                                    {
                                        type: "object",
                                        properties: {
                                            op: { type: "string", enum: ["replace"] },
                                            start_line: {
                                                type: "number",
                                                description: "1-based inclusive start of the range to replace.",
                                            },
                                            end_line: {
                                                type: "number",
                                                description: "1-based inclusive end of the range to replace.",
                                            },
                                            content: {
                                                type: "string",
                                                description:
                                                    "Replacement content. Can be more or fewer lines than the " +
                                                    "original range. Use an empty string to delete the range.",
                                            },
                                        },
                                        required: ["op", "start_line", "end_line", "content"],
                                    },
                                    {
                                        type: "object",
                                        properties: {
                                            op: { type: "string", enum: ["insert"] },
                                            line: {
                                                type: "number",
                                                description:
                                                    "1-based line number; content is inserted BEFORE this line. " +
                                                    "Use line = totalLines + 1 to append at end of file.",
                                            },
                                            content: {
                                                type: "string",
                                                description: "Content to insert (may be one or many lines).",
                                            },
                                        },
                                        required: ["op", "line", "content"],
                                    },
                                ],
                            },
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and preview the result without modifying the file. " +
                                "Defaults to false.",
                        },
                    },
                    required: ["path", "edits"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawEdits = args["edits"];
            const dryRun = (args["dry_run"] as boolean) ?? false;

            if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
                return { success: false, type: "text", content: "`edits` must be a non-empty array." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const original = await plugin.app.vault.read(file);
            const lines = original.split("\n");
            const totalLines = lines.length;

            // Validate every edit against the SAME pre-edit snapshot.
            const normalised: NormalisedEdit[] = [];
            for (let i = 0; i < rawEdits.length; i++) {
                const result = normaliseEdit(rawEdits[i], i, totalLines);
                if (typeof result === "string") {
                    return { success: false, type: "text", content: result };
                }
                normalised.push(result);
            }

            const overlapErr = detectOverlap(normalised);
            if (overlapErr) {
                return { success: false, type: "text", content: overlapErr };
            }

            // Apply back-to-front so each splice doesn't shift earlier indices.
            const sortedDesc = [...normalised].sort((a, b) => b.from - a.from || b.to - a.to);
            const working = lines.slice();
            for (const ed of sortedDesc) {
                const replacementLines = ed.content === "" && ed.from < ed.to
                    ? [] // pure deletion of a range
                    : ed.content.split("\n");
                // For pure inserts with empty content the model is asking for a no-op;
                // splicing in [""] would inject a blank line, which is almost certainly
                // not what was intended. Treat as no-op.
                if (ed.from === ed.to && ed.content === "") {
                    continue;
                }
                working.splice(ed.from, ed.to - ed.from, ...replacementLines);
            }

            const resultContent = working.join("\n");
            const newTotalLines = working.length;

            if (!dryRun) {
                await plugin.app.vault.modify(file, resultContent);
            }

            // Summarise applied edits in input order for clarity.
            const applied = normalised.map((ed) => {
                if (ed.raw.op === "replace") {
                    return {
                        op: "replace",
                        range: [ed.raw.start_line, ed.raw.end_line],
                        replaced_lines_count: ed.to - ed.from,
                        new_lines_count: ed.content === "" ? 0 : ed.content.split("\n").length,
                    };
                }
                return {
                    op: "insert",
                    before_line: ed.raw.line,
                    inserted_lines_count: ed.content === "" ? 0 : ed.content.split("\n").length,
                };
            });

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_lines_edit" : "lines_edited",
                    path,
                    edits_applied: applied,
                    previous_total_lines: totalLines,
                    new_total_lines: newTotalLines,
                    dry_run: dryRun,
                    ...(dryRun ? { preview: resultContent } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}
