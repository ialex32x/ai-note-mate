import { TAbstractFile, TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension } from "../_shared";
import { recordVaultEdit } from "./_log";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_file
//
// Strictly creates a NEW file. If the path already exists, the call
// fails with a pointer to the right tool for the caller's actual
// intent (overwrite the body / append / prepend). Wholesale overwrite
// of an existing file is intentionally NOT this tool's job — see
// `write-file.ts` (sub-agent only) and `docs/vault-editor-subagent-plan.md`.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultCreateFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "create_file",
                description:
                    "Create a NEW file in the vault with the given content. " +
                    "Parent folders are created automatically if they do not exist. " +
                    "Use this when the user wants to create, make, save, or store a new note or file. " +
                    "\n\n" +
                    "REFUSES if the path already exists — this tool does not overwrite. " +
                    "If you want to change an existing file, pick by intent: " +
                    "`replace_text` / `edit_lines` for surgical edits, " +
                    "`append_file` / `prepend_file` to add content, " +
                    "or delegate a full-body rewrite to the `vault_editor` sub-agent.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path for the new file, e.g. 'Notes/NewNote.md'. " +
                                "The file extension is required and will not be inferred — " +
                                "use '.md' for markdown notes. " +
                                "Must NOT already exist; the call fails otherwise.",
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
        capabilities: ["create_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const content = args["content"] as string;

            const extErr = requireFileExtension(path);
            if (extErr) return extErr;

            const existing: TAbstractFile | null = plugin.app.vault.getAbstractFileByPath(path);

            if (existing instanceof TFile) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `File already exists: ${path}. \`create_file\` does not overwrite. ` +
                        `For surgical edits use \`replace_text\` or \`edit_lines\`; ` +
                        `to add content use \`append_file\` or \`prepend_file\`; ` +
                        `for a full-body rewrite delegate to the \`vault_editor\` sub-agent.`,
                };
            }
            if (existing instanceof TFolder) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Path already exists as a folder: ${path}. ` +
                        `Pick a different path or rename the folder first.`,
                };
            }

            await ensureParentFolder(plugin.app, path);
            await plugin.app.vault.create(path, content);
            recordVaultEdit(plugin, chatStream, { kind: "create", path, toolName: "create_file" });
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}
