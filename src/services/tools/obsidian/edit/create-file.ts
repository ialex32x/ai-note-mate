import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension } from "../_shared";
import { recordVaultEdit } from "./_log";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultCreateFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "create_file",
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
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const content = args["content"] as string;

            const extErr = requireFileExtension(path);
            if (extErr) return extErr;

            const existing = plugin.app.vault.getAbstractFileByPath(path);

            if (existing instanceof TFile) {
                await plugin.app.vault.modify(existing, content);
                recordVaultEdit(plugin, chatStream, { kind: "modify", path, toolName: "create_file" });
                return { success: true, type: "object", content: { action: "overwritten", path } };
            }

            await ensureParentFolder(plugin.app, path);
            await plugin.app.vault.create(path, content);
            recordVaultEdit(plugin, chatStream, { kind: "create", path, toolName: "create_file" });
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}
