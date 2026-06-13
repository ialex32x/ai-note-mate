import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: append_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultAppendFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "append_file",
                description:
                    "Append text to the end of an existing file in the vault. " +
                    "If the file does not exist, it will be created. " +
                    "Use this when the user wants to add, append, or write more content to a note " +
                    "without overwriting existing content. " +
                    "The appended content is automatically placed on its own line — " +
                    "just provide the content body directly.",
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
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const content = args["content"] as string;

            const file = plugin.app.vault.getAbstractFileByPath(path);

            if (file instanceof TFile) {
                const existing = await plugin.app.vault.read(file);
                const needNewline = existing.length > 0 && !existing.endsWith("\n");
                const finalContent = needNewline ? "\n" + content : content;

                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "append_file",
                    perform: async () => { await plugin.app.vault.append(file, finalContent); },
                });
                if (lockErr) return lockErr;
                return { success: true, type: "object", content: { action: "appended", path } };
            }

            // File doesn't exist — create it. Require an explicit extension so
            // we never silently produce an extension-less file.
            const extErr = requireFileExtension(path);
            if (extErr) return extErr;
            const parentErr = await ensureParentFolder(plugin.app, path);
            if (parentErr) return parentErr;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "create",
                path,
                toolName: "append_file",
                perform: async () => { await plugin.app.vault.create(path, content); },
            });
            if (lockErr) return lockErr;
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}
