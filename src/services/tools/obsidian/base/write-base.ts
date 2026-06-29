import { TAbstractFile, TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension } from "../_shared";
import { runVaultMutation } from "../../../vault";
import { prepareBaseContentForWrite } from "./base-schema";
import { inspectBaseContent, requireBaseExtension } from "./_base-io";

function validateBaseContentForWrite(content: string): { serialized: string } | ToolCallResult {
    const prepared = prepareBaseContentForWrite(content);
    if (!prepared.ok) {
        return { success: false, type: "text", content: prepared.error };
    }
    return { serialized: prepared.serialized };
}

export function vaultCreateBase(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "create_base",
                description:
                    "Create a NEW Obsidian Bases file (`.base`, YAML). Content is validated (YAML parse + " +
                    "view structure) before writing. REFUSES if the path already exists. Prefer this over " +
                    "`create_note` for Bases files. Does NOT execute filter expressions — only static validation.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path ending in `.base`, e.g. 'Bases/Orphans.base'. Must NOT already exist.",
                        },
                        content: {
                            type: "string",
                            description:
                                "YAML body with optional `filters`, `formulas`, `properties`, `summaries`, and `views`. " +
                                "Each view needs `type` (table|cards|list|map) and `name`. " +
                                "`groupBy` (any view type) must be an object: `{ property: file.folder }` " +
                                "(optional `direction`: ASC|DESC); a bare string is auto-normalized on write. " +
                                "Every `formula.X` used in a view `order` or in `properties` must be defined under `formulas`.",
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

            const baseExt = requireBaseExtension(path);
            if (!baseExt.ok) {
                return { success: false, type: "text", content: baseExt.message };
            }
            const extErr = requireFileExtension(path);
            if (extErr) return extErr;

            const validated = validateBaseContentForWrite(content);
            if ("success" in validated) return validated;

            const existing: TAbstractFile | null = plugin.app.vault.getAbstractFileByPath(path);
            if (existing instanceof TFile) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `File already exists: ${path}. \`create_base\` does not overwrite — use \`write_base\` instead.`,
                };
            }
            if (existing instanceof TFolder) {
                return {
                    success: false,
                    type: "text",
                    content: `Path already exists as a folder: ${path}.`,
                };
            }

            const parentErr = await ensureParentFolder(plugin.app, path);
            if (parentErr) return parentErr;
            const serialized = validated.serialized;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "create",
                path,
                toolName: "create_base",
                perform: async () => {
                    await plugin.app.vault.create(path, serialized);
                },
            });
            if (lockErr) return lockErr;

            const inspection = inspectBaseContent(serialized);
            return {
                success: true,
                type: "object",
                content: {
                    action: "created",
                    path,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultWriteBase(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "write_base",
                description:
                    "Replace the ENTIRE body of an existing `.base` file with new YAML content. Validated " +
                    "before writing. Does NOT create new files — use `create_base`.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .base file.",
                        },
                        content: {
                            type: "string",
                            description:
                                "Full replacement YAML body. `groupBy` (any view type) must be `{ property: ... }` " +
                                "(optional `direction`: ASC|DESC); string shorthand is auto-normalized on write.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Optional Unix ms; fail if on-disk mtime differs (concurrent-edit guard).",
                        },
                    },
                    required: ["path", "content"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const content = args["content"] as string;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const baseExt = requireBaseExtension(path);
            if (!baseExt.ok) {
                return { success: false, type: "text", content: baseExt.message };
            }

            const file = plugin.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                return {
                    success: false,
                    type: "text",
                    content: `Base file not found: ${path}. Use \`create_base\` to create a new file.`,
                };
            }

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}. ` +
                        `Re-read the file and retry.`,
                };
            }

            const validated = validateBaseContentForWrite(content);
            if ("success" in validated) return validated;

            const serialized = validated.serialized;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "modify",
                path,
                toolName: "write_base",
                perform: async () => {
                    await plugin.app.vault.modify(file, serialized);
                },
            });
            if (lockErr) return lockErr;

            const inspection = inspectBaseContent(serialized);
            return {
                success: true,
                type: "object",
                content: {
                    action: "overwritten",
                    path,
                    previous_mtime: previousMtime,
                    new_mtime: file.stat.mtime,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}
