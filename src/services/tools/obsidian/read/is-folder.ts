import { TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: is_folder
// ─────────────────────────────────────────────────────────────────────────────

export function vaultIsFolder(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "is_folder",
                description:
                    "Check if a given path in the vault is a folder or a file. " +
                    "Use this when the user wants to verify if a path is a folder or check path type.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to check.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const file = plugin.app.vault.getAbstractFileByPath(path);

            if (!file) {
                return {
                    success: true,
                    type: "object",
                    content: {
                        path,
                        exists: false,
                        is_folder: false,
                    },
                };
            }

            const isFolder = file instanceof TFolder;
            return {
                success: true,
                type: "object",
                content: {
                    path,
                    exists: true,
                    is_folder: isFolder,
                },
            };
        },
    };
}
