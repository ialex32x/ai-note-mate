import { TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool } from "../../chat-stream";
import { isFailure, requireFolder } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: browse_folder
// ─────────────────────────────────────────────────────────────────────────────

export function vaultBrowseFolder(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "browse_folder",
                description:
                    "List files and sub-folders inside a vault folder. File entries carry extension, " +
                    "ctime, mtime, and size; folder entries carry only their path. Pass `''` or `'/'` " +
                    "for the vault root. Prefer a SINGLE call with an appropriate `max_depth` (e.g. 2) " +
                    "over walking top-level folders one-at-a-time. Use `entries_type: 'folder'` to map " +
                    "vault structure without file noise, or `'file'` for files only. For vault-wide " +
                    "stats (sizes / extension breakdown / recency), call `get_overview` instead.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to the folder to list. Use '' or '/' for the vault root.",
                        },
                        max_depth: {
                            type: "number",
                            description:
                                "How many levels of descendants to include. " +
                                "0 (default) = only direct children of `path`. " +
                                "1 = direct children and their children. " +
                                "-1 = fully recursive, no depth limit. " +
                                "Use 2 as a good default when exploring an unfamiliar vault.",
                        },
                        entries_type: {
                            type: "string",
                            enum: ["all", "folder", "file"],
                            description:
                                "Filter entries by type. \"all\" (default) returns both files and folders. " +
                                "\"folder\" returns only folder entries. " +
                                "\"file\" returns only file entries.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of matching entries to skip before starting to collect results. " +
                                "Use together with `limit` for paginated browsing. Defaults to 0. " +
                                "When `has_more` is true, increase `skip` by the previous `count` to fetch the next page.",
                        },
                        limit: {
                            type: "number",
                            description:
                                "Maximum number of entries to return. Defaults to 1000. " +
                                "If there are more entries beyond `skip + limit`, the response will include `has_more: true`. " +
                                "Use `skip` to paginate through large folders.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        exec: async (_chatStream, args, _signal) => {
            const rawPath = (args["path"] as string) || "/";
            const rawMaxDepth = args["max_depth"];
            const skip = Math.max(0, (args["skip"] as number) ?? 0);
            const limit = Math.max(1, (args["limit"] as number) ?? 1000);
            const entriesType = (args["entries_type"] as string) || "all";

            if (entriesType !== "all" && entriesType !== "folder" && entriesType !== "file") {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid entries_type "${entriesType}". Must be "all", "folder", or "file".`,
                };
            }

            const maxDepth = typeof rawMaxDepth === "number" ? rawMaxDepth : 0;

            // Normalise: vault root is represented as '/'
            const folderPath = rawPath === "/" ? "/" : rawPath.replace(/\/$/, "");

            let folder: TFolder;
            if (folderPath === "/") {
                folder = plugin.app.vault.getRoot();
            } else {
                const folderOrErr = requireFolder(plugin.app, folderPath);
                if (isFailure(folderOrErr)) return folderOrErr;
                folder = folderOrErr;
            }

            type FolderProps = { type: "folder" };
            type FileProps = { type: "file", extension: string, ctime: number, mtime: number, size: number };
            type UniversalProps = { path: string } & (FolderProps | FileProps);
            const entries: UniversalProps[] = [];

            let hasMore = false;
            let totalScanned = 0;
            let skipped = 0;

            const collect = (f: TFolder, depth: number): boolean => {
                for (const child of f.children) {
                    totalScanned++;
                    if (child instanceof TFile) {
                        if (entriesType !== "folder") {
                            if (skipped < skip) {
                                skipped++;
                            } else if (entries.length < limit) {
                                entries.push({
                                    path: child.path,
                                    type: "file",
                                    extension: child.extension,
                                    ctime: child.stat.ctime,
                                    mtime: child.stat.mtime,
                                    size: child.stat.size,
                                });
                            }
                        }
                    } else if (child instanceof TFolder) {
                        if (entriesType !== "file") {
                            if (skipped < skip) {
                                skipped++;
                            } else if (entries.length < limit) {
                                entries.push({ path: child.path, type: "folder" });
                            }
                        }
                        // Descend if we still have depth budget. -1 means unlimited.
                        // Always descend into sub-folders regardless of entries_type,
                        // so we can find nested folders/files that match the filter.
                        if (maxDepth === -1 || depth < maxDepth) {
                            if (!collect(child, depth + 1)) return false;
                        }
                    }
                    if (entries.length >= limit && skipped >= skip) {
                        hasMore = true;
                        return false;
                    }
                }
                return true;
            };

            collect(folder, 0);

            return {
                success: true,
                type: "object",
                content: {
                    path: folderPath,
                    max_depth: maxDepth,
                    entries_type: entriesType,
                    count: entries.length,
                    total_scanned: totalScanned,
                    has_more: hasMore,
                    entries,
                },
            };
        },
    };
}
