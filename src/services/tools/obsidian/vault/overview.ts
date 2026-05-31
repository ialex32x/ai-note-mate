import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_overview
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provide a high-level snapshot of the entire vault without exhaustively listing every file.
 * Gives the AI a quick sense of the vault's size, shape, recency, and extremal files.
 */
export function vaultGetOverview(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "get_overview",
                description:
                    "High-level vault overview: total file / folder count, total size, breakdown by " +
                    "extension, plus the most-recently-modified / least-recently-modified / largest / " +
                    "smallest / earliest-created files. Use as a first step for broad questions ('how " +
                    "big is my vault?', 'what's my largest note?', 'oldest note?', etc.) and for " +
                    "extremal queries — far cheaper than scanning files manually.",
                parameters: {
                    type: "object",
                    properties: {
                        top_extensions: {
                            type: "number",
                            description:
                                "How many top file extensions to list by count in the response. Defaults to 10.",
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, _args, _signal) => {
            const topExtensions = (_args["top_extensions"] as number) ?? 10;

            const allFiles = plugin.app.vault.getFiles();
            const allFolders = plugin.app.vault.getAllLoadedFiles().filter((f) => !(f instanceof TFile));

            const extCount = new Map<string, number>();
            let totalSize = 0;
            let newest: TFile | null = null;
            let oldest: TFile | null = null;
            let largest: TFile | null = null;
            let smallest: TFile | null = null;
            let earliestCreated: TFile | null = null;

            for (const f of allFiles) {
                const ext = f.extension || "(none)";
                extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
                totalSize += f.stat.size;
                if (!newest || f.stat.mtime > newest.stat.mtime) newest = f;
                if (!oldest || f.stat.mtime < oldest.stat.mtime) oldest = f;
                if (!largest || f.stat.size > largest.stat.size) largest = f;
                if (!smallest || f.stat.size < smallest.stat.size) smallest = f;
                if (!earliestCreated || f.stat.ctime < earliestCreated.stat.ctime) earliestCreated = f;
            }

            const extensions = [...extCount.entries()]
                .map(([extension, count]) => ({ extension, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, topExtensions);

            const markdownCount = extCount.get("md") ?? 0;

            const describeWithMtime = (f: TFile | null) =>
                f ? { path: f.path, mtime: f.stat.mtime, size: f.stat.size } : null;

            const describeWithSize = (f: TFile | null) =>
                f ? { path: f.path, size: f.stat.size, mtime: f.stat.mtime } : null;

            const describeWithCtime = (f: TFile | null) =>
                f ? { path: f.path, ctime: f.stat.ctime, size: f.stat.size } : null;

            return {
                success: true,
                type: "object",
                content: {
                    total_files: allFiles.length,
                    total_folders: allFolders.length - 1, // exclude root
                    total_size_bytes: totalSize,
                    markdown_files: markdownCount,
                    extensions,
                    most_recent_file: describeWithMtime(newest),
                    oldest_file: describeWithMtime(oldest),
                    largest_file: describeWithSize(largest),
                    smallest_file: describeWithSize(smallest),
                    earliest_created_file: describeWithCtime(earliestCreated),
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_files_sorted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List files sorted by a chosen field, optionally filtered by a minimum timestamp,
 * file extension, or folder prefix.
 * Useful for "what did I change recently", "what are my largest notes", "what are my oldest notes" style questions.
 */
export function vaultListFilesSorted(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "list_files_sorted",
                description:
                    "List files sorted by `mtime` (default; most recent first), `ctime`, or `size`. " +
                    "Optionally filter by minimum mtime, file extension, or folder prefix. Use for " +
                    "'what did I edit recently?', 'what are my largest notes?', 'what are the oldest " +
                    "notes?' and similar recency / size queries.",
                parameters: {
                    type: "object",
                    properties: {
                        limit: {
                            type: "number",
                            description: "Maximum number of files to return. Defaults to 20.",
                        },
                        sort_by: {
                            type: "string",
                            enum: ["mtime", "ctime", "size"],
                            description:
                                "Field to sort by. 'mtime' = modification time (default), " +
                                "'ctime' = creation time, 'size' = file size in bytes.",
                        },
                        sort_order: {
                            type: "string",
                            enum: ["desc", "asc"],
                            description:
                                "Sort direction. 'desc' = descending (default, e.g. newest/largest first), " +
                                "'asc' = ascending (e.g. oldest/smallest first).",
                        },
                        since: {
                            type: "number",
                            description:
                                "Unix timestamp in milliseconds; only return files modified at or after this time. " +
                                "Omit to include all files.",
                        },
                        extension: {
                            type: "string",
                            description:
                                "Optional file extension filter (e.g. 'md', 'pdf'). Omit to include every extension.",
                        },
                        folder_prefix: {
                            type: "string",
                            description:
                                "Optional vault-relative folder prefix filter (e.g. 'Projects/'). " +
                                "Only files whose path starts with this prefix are returned. Omit to search the entire vault.",
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const limit = (args["limit"] as number) ?? 20;
            const sortBy = (args["sort_by"] as string) ?? "mtime";
            const sortOrder = (args["sort_order"] as string) ?? "desc";
            const since = args["since"] as number | undefined;
            const extension = args["extension"] as string | undefined;
            const folderPrefix = args["folder_prefix"] as string | undefined;

            const normalizedExt = extension ? extension.replace(/^\./, "") : undefined;
            const normalizedPrefix = folderPrefix
                ? folderPrefix.endsWith("/") ? folderPrefix : folderPrefix + "/"
                : undefined;

            const dir = sortOrder === "asc" ? 1 : -1;

            const comparator = (a: TFile, b: TFile): number => {
                switch (sortBy) {
                    case "ctime":
                        return (a.stat.ctime - b.stat.ctime) * dir;
                    case "size":
                        return (a.stat.size - b.stat.size) * dir;
                    case "mtime":
                    default:
                        return (a.stat.mtime - b.stat.mtime) * dir;
                }
            };

            const files = plugin.app.vault
                .getFiles()
                .filter((f) => {
                    if (since !== undefined && f.stat.mtime < since) return false;
                    if (normalizedExt && f.extension !== normalizedExt) return false;
                    if (normalizedPrefix && !f.path.startsWith(normalizedPrefix)) return false;
                    return true;
                })
                .sort(comparator)
                .slice(0, limit)
                .map((f) => ({
                    path: f.path,
                    extension: f.extension,
                    mtime: f.stat.mtime,
                    ctime: f.stat.ctime,
                    size: f.stat.size,
                }));

            return {
                success: true,
                type: "object",
                content: {
                    sort_by: sortBy,
                    sort_order: sortOrder,
                    count: files.length,
                    files,
                },
            };
        },
    };
}
