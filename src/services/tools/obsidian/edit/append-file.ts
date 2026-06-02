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
                            description:
                                "Text to append to the file. " +
                                "CRITICAL: This tool does NOT automatically add a newline before the appended content. " +
                                "If you intend the content to begin on a new line (e.g. a new heading, paragraph, or list item), " +
                                "you MUST include a leading '\\n' in this parameter — otherwise it will be glued to the end of the last line.",
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
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "append_file",
                    perform: async () => { await plugin.app.vault.append(file, content); },
                });
                if (lockErr) return lockErr;
                return { success: true, type: "object", content: { action: "appended", path } };
            }

            // File doesn't exist — create it. Require an explicit extension so
            // we never silently produce an extension-less file.
            const extErr = requireFileExtension(path);
            if (extErr) return extErr;
            await ensureParentFolder(plugin.app, path);
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
