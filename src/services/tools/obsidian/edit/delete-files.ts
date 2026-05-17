import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: delete_files
// ─────────────────────────────────────────────────────────────────────────────

export function vaultDeleteFiles(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "delete_files",
                description:
                    "Move one or more files to trash. Disposal honours the user's Obsidian " +
                    "\"Files & Links → Deleted files\" setting (system trash, vault `.trash`, or " +
                    "permanent), so recoverability depends on that. Each path is processed " +
                    "independently. To delete a folder and its contents, use `delete_folder` instead.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "List of vault-relative file paths to delete. " +
                                "Each entry is processed independently; failures on one path do not stop the others.",
                        },
                    },
                    required: ["paths"],
                },
            },
        },
        capabilities: ["delete_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            const rawPaths = args["paths"];
            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return { success: false, type: "text", content: "`paths` must be a non-empty array of strings." };
            }

            // Deduplicate while preserving order to avoid trashing the same file twice.
            const seen = new Set<string>();
            const paths: string[] = [];
            for (const p of rawPaths) {
                if (typeof p !== "string" || p.length === 0) continue;
                if (seen.has(p)) continue;
                seen.add(p);
                paths.push(p);
            }
            if (paths.length === 0) {
                return { success: false, type: "text", content: "`paths` must contain at least one non-empty string." };
            }

            const deleted: string[] = [];
            const failed: { path: string; error: string }[] = [];

            for (const path of paths) {
                const fileOrErr = requireFile(plugin.app, path);
                if (isFailure(fileOrErr)) {
                    const error = typeof fileOrErr.content === "string" ? fileOrErr.content : `Failed to resolve: ${path}`;
                    failed.push({ path, error });
                    continue;
                }
                try {
                    const lockErr = await runVaultMutation(plugin, chatStream, {
                        kind: "delete",
                        path,
                        toolName: "delete_files",
                        perform: async () => { await plugin.app.fileManager.trashFile(fileOrErr); },
                    });
                    if (lockErr) {
                        const msg = typeof lockErr.content === "string" ? lockErr.content : "locked";
                        failed.push({ path, error: msg });
                    } else {
                        deleted.push(path);
                    }
                } catch (e) {
                    failed.push({ path, error: e instanceof Error ? e.message : String(e) });
                }
            }

            return {
                success: deleted.length > 0,
                type: "object",
                content: { deleted, failed },
            };
        },
        requiresConfirmation: true,
    };
}
