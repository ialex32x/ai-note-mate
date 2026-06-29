import { TAbstractFile, TFile, TFolder, stringifyYaml } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension, structuredFileCreateRedirect } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: create_note
//
// Strictly creates a NEW markdown note. If the path already exists, the call
// fails with a pointer to the right tool for the caller's actual
// intent (overwrite the body / append / prepend). Wholesale overwrite
// of an existing file is intentionally NOT this tool's job — see
// `write-file.ts` (sub-agent only) and `docs/vault-editor-subagent-plan.md`.
//
// Takes `body` and optional `frontmatter` as separate parameters so the LLM
// doesn't have to manually construct YAML delimiters — the tool embeds
// frontmatter as a proper `---` block.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultCreateNote(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "create_note",
                description:
                    "Create a NEW markdown note in the vault. Missing parent folders are " +
                    "created automatically. REFUSES if the path already exists — this tool does not " +
                    "overwrite (use the appropriate edit tool to change an existing file). " +
                    "Do NOT use for `.canvas` or `.base` files — use `create_canvas` / `create_base` instead." +
                    "\n\n" +
                    "Pass `body` (the markdown text) and optionally `frontmatter` (a flat key-value object " +
                    "for YAML frontmatter like {\"tags\":[\"a\"],\"title\":\"X\"}) — the tool handles the `---` delimiters.",
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
                        body: {
                            type: "string",
                            description: "The markdown body of the note (without frontmatter).",
                        },
                        frontmatter: {
                            type: "object",
                            description:
                                "Optional YAML frontmatter as a flat key-value object, e.g. " +
                                "{\"title\":\"My Note\", \"tags\":[\"project\",\"draft\"]}. " +
                                "The tool wraps this in `---` delimiters. Omit for a note without frontmatter.",
                        },
                    },
                    required: ["path", "body"],
                },
            },
        },
        capabilities: ["create_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const body = args["body"] as string;
            const frontmatter = args["frontmatter"] as Record<string, unknown> | undefined;

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
                        `File already exists: ${path}. \`create_note\` does not overwrite. ` +
                        `For surgical edits use \`replace_text\` or \`insert_text\`; ` +
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

            // Build content: optional frontmatter + body
            let content: string;
            if (frontmatter && typeof frontmatter === "object" && Object.keys(frontmatter).length > 0) {
                const yaml = stringifyYaml(frontmatter);
                content = `---\n${yaml}\n---\n${body}`;
            } else {
                content = body;
            }

            const parentErr = await ensureParentFolder(plugin.app, path);
            if (parentErr) return parentErr;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "create",
                path,
                toolName: "create_note",
                perform: async () => { await plugin.app.vault.create(path, content); },
            });
            if (lockErr) return lockErr;
            return {
                success: true,
                type: "object",
                content: {
                    action: "created",
                    path,
                    ...(frontmatter ? { has_frontmatter: true } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}
