import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: prepend_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultPrependFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "prepend_file",
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
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
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

                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "prepend_file",
                    perform: async () => { await plugin.app.vault.modify(file, newContent); },
                });
                if (lockErr) return lockErr;
                return { success: true, type: "object", content: { action: "prepended", path } };
            }

            // File doesn't exist — create it. Require an explicit extension so
            // we never silently produce an extension-less file.
            const extErr = requireFileExtension(path);
            if (extErr) return extErr;
            await ensureParentFolder(plugin.app, path);
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "create",
                path,
                toolName: "prepend_file",
                perform: async () => { await plugin.app.vault.create(path, contentToPrepend); },
            });
            if (lockErr) return lockErr;
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}
