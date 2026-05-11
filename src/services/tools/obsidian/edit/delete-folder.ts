import { TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFolder } from "../_shared";

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
        exec: async (_chatStream, args, _signal) => {
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

            await deleteRecursive(folder);
            await plugin.app.fileManager.trashFile(folder);
            return { success: true, type: "object", content: { path } };
        },
        requiresConfirmation: true,
    };
}
