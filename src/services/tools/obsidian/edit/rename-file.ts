import { TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: rename_or_move_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultRenameFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "rename_or_move_file",
                description:
                    "Rename and/or move a file or folder within the vault in a single atomic operation. " +
                    "Different folder = move; different filename = rename; both at once is fine. " +
                    "Internal wikilinks are automatically updated per the user's Obsidian preferences, " +
                    "and missing parent folders for `new_path` are created automatically.",
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
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
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

            const parentErr = await ensureParentFolder(plugin.app, newPath);
            if (parentErr) return parentErr;

            const isFolder = file instanceof TFolder;

            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "rename",
                path: newPath,
                previousPath: path,
                isFolder,
                toolName: "rename_or_move_file",
                // Use fileManager.renameFile to automatically update all links.
                perform: async () => { await plugin.app.fileManager.renameFile(file, newPath); },
            });
            if (lockErr) return lockErr;

            return {
                success: true,
                type: "object",
                content: {
                    action: "renamed",
                    old_path: path,
                    new_path: newPath,
                    is_folder: isFolder,
                },
            };
        },
        requiresConfirmation: true,
    };
}
