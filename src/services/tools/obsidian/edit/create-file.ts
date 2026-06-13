import { TAbstractFile, TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension, structuredFileCreateRedirect } from "../_shared";
import { runVaultMutation } from "../../../vault";

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
                    "Create a NEW file in the vault with the given content. Missing parent folders are " +
                    "created automatically. REFUSES if the path already exists — this tool does not " +
                    "overwrite (use the appropriate edit tool to change an existing file). " +
                    "Do NOT use for `.canvas` or `.base` files — use `create_canvas` / `create_base` instead.",
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

            const structuredRedirect = structuredFileCreateRedirect(path);
            if (structuredRedirect) return structuredRedirect;

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

            const parentErr = await ensureParentFolder(plugin.app, path);
            if (parentErr) return parentErr;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "create",
                path,
                toolName: "create_file",
                perform: async () => { await plugin.app.vault.create(path, content); },
            });
            if (lockErr) return lockErr;
            return { success: true, type: "object", content: { action: "created", path } };
        },
        requiresConfirmation: true,
    };
}
