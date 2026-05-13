import { TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFolder } from "../_shared";
import { runVaultMutation, type BatchEntry } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_folder
// ─────────────────────────────────────────────────────────────────────────────

export function vaultDeleteFolder(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "delete_folder",
                description:
                    "Delete a folder and all of its contents (files and sub-folders) from the vault. " +
                    "Items are moved to trash according to the user's Obsidian \"Files & Links → Deleted files\" preference (system trash, vault .trash, or permanent). " +
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
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const folderOrErr = requireFolder(plugin.app, path);
            if (isFailure(folderOrErr)) return folderOrErr;
            const folder = folderOrErr;

            // Recursively trash all files and delete all sub-folders
            const deleteRecursive = async (f: TFolder) => {
                for (const child of [...f.children]) {
                    if (child instanceof TFile) {
                        await plugin.app.fileManager.trashFile(child);
                    } else if (child instanceof TFolder) {
                        await deleteRecursive(child);
                        await plugin.app.fileManager.trashFile(child);
                    }
                }
            };

            // Walk the subtree up-front to (a) collect every descendant
            // file's pre-delete content for the checkpoint store's
            // rollback path and (b) record their paths as batch
            // entries so they share the same lock + audit lifecycle
            // as the folder itself. Binary files where `vault.read`
            // would lose information are skipped from the snapshot
            // input (entry still gets locked but rollback for that
            // specific file falls back to "no-op + manual recovery
            // from trash").
            const childFiles: TFile[] = [];
            const collectFiles = (f: TFolder) => {
                for (const child of f.children) {
                    if (child instanceof TFile) childFiles.push(child);
                    else if (child instanceof TFolder) collectFiles(child);
                }
            };
            collectFiles(folder);

            const batchEntries: BatchEntry[] = [];
            for (const file of childFiles) {
                let preEditContent: string | undefined;
                try {
                    preEditContent = await plugin.app.vault.read(file);
                } catch {
                    preEditContent = undefined;
                }
                batchEntries.push({
                    path: file.path,
                    kind: "delete",
                    preEditContent,
                });
            }

            // Audit log gets a single folder-level entry; the per-file
            // snapshots travel through `batchEntries` and are only
            // visible inside the checkpoint store (for discard
            // rollback). This keeps the AI file-changes log
            // signal-dense even when a large subtree is wiped.
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "delete",
                path,
                isFolder: true,
                toolName: "delete_folder",
                perform: async () => {
                    await deleteRecursive(folder);
                    await plugin.app.fileManager.trashFile(folder);
                },
                batchEntries,
            });
            if (lockErr) return lockErr;
            return {
                success: true,
                type: "object",
                content: { path, files_recorded: batchEntries.length },
            };
        },
        requiresConfirmation: true,
    };
}
