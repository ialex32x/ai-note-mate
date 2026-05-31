import { TFile, TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import { isFailure, requireFolder } from "../_shared";

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
                    "vault structure without file noise, or `'file'` for files only. Response includes " +
                    "`total` (matching entries within `max_depth`) for pagination alongside `count`, " +
                    "`skip`, and `has_more`. For vault-wide stats (sizes / extension breakdown / recency), " +
                    "call `get_overview` instead.",
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

            let totalScanned = 0;
            let total = 0;
            let skipped = 0;

            const visit = (f: TFolder, depth: number): void => {
                for (const child of f.children) {
                    totalScanned++;

                    const isFile = child instanceof TFile;
                    const isFolderChild = child instanceof TFolder;
                    const matchesType =
                        (isFile && entriesType !== "folder") ||
                        (isFolderChild && entriesType !== "file");

                    if (matchesType) {
                        total++;
                        if (skipped < skip) {
                            skipped++;
                        } else if (entries.length < limit) {
                            if (isFile) {
                                entries.push({
                                    path: child.path,
                                    type: "file",
                                    extension: child.extension,
                                    ctime: child.stat.ctime,
                                    mtime: child.stat.mtime,
                                    size: child.stat.size,
                                });
                            } else {
                                entries.push({ path: child.path, type: "folder" });
                            }
                        }
                    }

                    if (isFolderChild && (maxDepth === -1 || depth < maxDepth)) {
                        visit(child, depth + 1);
                    }
                }
            };

            visit(folder, 0);

            const hasMore = skip + entries.length < total;

            return {
                success: true,
                type: "object",
                content: {
                    path: folderPath,
                    max_depth: maxDepth,
                    entries_type: entriesType,
                    total,
                    count: entries.length,
                    skip,
                    total_scanned: totalScanned,
                    has_more: hasMore,
                    entries,
                },
            };
        },
    };
}
