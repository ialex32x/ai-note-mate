import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, normalizeVaultPathsArg, requireFile } from "../_shared";
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
                    "Remove one or more files from the vault. Disposal follows the user's Obsidian " +
                    "\"Files & Links → Deleted files\" setting (system trash, vault `.trash`, or " +
                    "permanent deletion), so recoverability is not guaranteed. Each path is processed " +
                    "independently. To remove a folder and its contents, use `delete_folder` instead.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "List of vault-relative file paths to remove. " +
                                "Each entry is processed independently; failures on one path do not stop the others. " +
                                'Example: {"paths": ["folder/note.md", "other.md"]}',
                        },
                    },
                    required: ["paths"],
                },
            },
        },
        capabilities: ["delete_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            // Accept `paths` (array, canonical), `file_paths` (alternative), and `path` (single string).
            const argsCopy = { ...args };
            if (argsCopy["file_paths"] !== undefined && argsCopy["paths"] === undefined) {
                argsCopy["paths"] = argsCopy["file_paths"];
            }
            const normalized = normalizeVaultPathsArg(argsCopy);
            if (!Array.isArray(normalized)) return normalized;

            // Deduplicate while preserving order to avoid trashing the same file twice.
            const seen = new Set<string>();
            const paths: string[] = [];
            for (const p of normalized) {
                if (seen.has(p)) continue;
                seen.add(p);
                paths.push(p);
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
