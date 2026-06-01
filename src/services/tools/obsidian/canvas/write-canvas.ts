import { TAbstractFile, TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension } from "../_shared";
import { runVaultMutation } from "../../../vault";
import {
    hasCanvasErrors,
    parseCanvasContent,
    serializeCanvas,
    validateCanvas,
} from "./canvas-schema";
import { inspectCanvasContent, makePathResolver, requireCanvasExtension } from "./_canvas-io";

function validateCanvasContentForWrite(
    app: NoteAssistantPlugin["app"],
    content: unknown,
): { serialized: string } | ToolCallResult {
    const parsed = parseCanvasContent(content);
    if (!parsed.ok) {
        return { success: false, type: "text", content: parsed.error };
    }
    const issues = validateCanvas(parsed.data, makePathResolver(app));
    if (hasCanvasErrors(issues)) {
        const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
        return {
            success: false,
            type: "text",
            content:
                "Canvas validation failed:\n" +
                messages.map((m) => `- ${m}`).join("\n") +
                "\nFix the JSON and retry, or call read_canvas after a successful write to inspect structure.",
        };
    }
    return { serialized: serializeCanvas(parsed.data) };
}

export function vaultCreateCanvas(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "create_canvas",
                description:
                    "Create a NEW Obsidian Canvas file (`.canvas`, JSON Canvas 1.0). Content is validated " +
                    "against the JSON Canvas schema before writing. REFUSES if the path already exists. " +
                    "Prefer this over `create_file` for canvas files. Missing parent folders are created " +
                    "automatically. Place nodes at sensible coordinates and use `layout_canvas_grid` " +
                    "to rearrange specific nodes on a uniform grid if needed.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path ending in `.canvas`, e.g. 'Boards/Overview.canvas'. " +
                                "Must NOT already exist.",
                        },
                        content: {
                            type: "string",
                            description:
                                "JSON Canvas document body (object with `nodes` and/or `edges` arrays). " +
                                "Each node needs id, type, x, y, width, height; file nodes need `file`; link nodes need `url`. " +
                                "Coordinates are written as-is; use `layout_canvas_grid` to reposition afterwards.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
        },
        capabilities: ["create_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const content = args["content"];

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            const extErr = requireFileExtension(path);
            if (extErr) return extErr;

            const validated = validateCanvasContentForWrite(plugin.app, content);
            if ("success" in validated) return validated;

            const existing: TAbstractFile | null = plugin.app.vault.getAbstractFileByPath(path);
            if (existing instanceof TFile) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `File already exists: ${path}. \`create_canvas\` does not overwrite — use \`write_canvas\` instead.`,
                };
            }
            if (existing instanceof TFolder) {
                return {
                    success: false,
                    type: "text",
                    content: `Path already exists as a folder: ${path}.`,
                };
            }

            await ensureParentFolder(plugin.app, path);
            const serialized = validated.serialized;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "create",
                path,
                toolName: "create_canvas",
                perform: async () => {
                    await plugin.app.vault.create(path, serialized);
                },
            });
            if (lockErr) return lockErr;

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: "created",
                    path,
                    valid: inspection.valid,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultWriteCanvas(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "write_canvas",
                description:
                    "Replace the ENTIRE body of an existing `.canvas` file with new JSON Canvas content. " +
                    "Content is validated before writing. Does NOT create new files — use `create_canvas`. " +
                    "For incremental edits (add nodes/edges) prefer `add_canvas_nodes` / `add_canvas_edges`.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        content: {
                            type: "string",
                            description: "Full replacement JSON Canvas document body.",
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
            const content = args["content"];
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }

            const file = plugin.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                return {
                    success: false,
                    type: "text",
                    content: `Canvas file not found: ${path}. Use \`create_canvas\` to create a new file.`,
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

            const validated = validateCanvasContentForWrite(plugin.app, content);
            if ("success" in validated) return validated;

            const serialized = validated.serialized;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "modify",
                path,
                toolName: "write_canvas",
                perform: async () => {
                    await plugin.app.vault.modify(file, serialized);
                },
            });
            if (lockErr) return lockErr;

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: "overwritten",
                    path,
                    previous_mtime: previousMtime,
                    new_mtime: file.stat.mtime,
                    valid: inspection.valid,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}
