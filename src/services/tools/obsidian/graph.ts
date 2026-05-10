import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool } from "../../chat-stream";
import type { ToolCapability } from "../../llm-provider";
import { isFailure, requireFile } from "./_shared";

const MARKDOWN_EXTENSIONS = new Set(["md", "canvas"]);

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_get_backlinks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute incoming links (backlinks) for a target file by scanning `metadataCache.resolvedLinks`.
 *
 * `resolvedLinks` has shape `Record<sourcePath, Record<targetPath, count>>`, so we iterate its
 * entries and collect all sources whose targets include the requested path.
 *
 * This relies only on the officially typed Obsidian API (not the untyped internal `getBacklinksForFile`).
 */
export function vaultGetBacklinks(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_get_backlinks",
                description:
                    "Return all notes that link TO the given file (incoming/backlinks). " +
                    "Backlinks are a core Obsidian concept that reveals which notes reference the target, " +
                    "enabling the AI to understand the knowledge graph around a note. " +
                    "Use this when the user asks 'which notes link to X?', 'what references this note?', " +
                    "'show backlinks', or when you need to understand how a note is connected to the rest of the vault.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path of the target file whose backlinks should be returned.",
                        },
                        limit: {
                            type: "number",
                            description:
                                "Maximum number of backlink source files to return. Defaults to 50.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const limit = (args["limit"] as number) ?? 50;

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const targetPath = fileOrErr.path;

            // resolvedLinks: Record<sourcePath, Record<targetPath, count>>
            const resolved = plugin.app.metadataCache.resolvedLinks;

            const backlinks: { source: string; count: number }[] = [];
            for (const sourcePath of Object.keys(resolved)) {
                const targets = resolved[sourcePath];
                if (!targets) continue;
                const count = targets[targetPath];
                if (count && count > 0) {
                    backlinks.push({ source: sourcePath, count });
                }
            }

            backlinks.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

            return {
                success: true,
                type: "object",
                content: {
                    target: targetPath,
                    total: backlinks.length,
                    backlinks: backlinks.slice(0, limit),
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_find_orphan_files
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find files that are not linked or embedded from any note, according to Obsidian's
 * `metadataCache.resolvedLinks` index.
 *
 * Semantic caveat: `resolvedLinks` only tracks explicit markdown links and embeds
 * (`[[...]]`, `![[...]]`, standard `[text](path)`). Files can still be referenced
 * through:
 *   - YAML frontmatter path fields (e.g. `cover: image.png`)
 *   - Code blocks / inline code paths
 *   - Dataview queries and other dynamic sources
 *   - Other plugins (e.g. Excalidraw, templater, canvas auto-embeds)
 *
 * Results are therefore best described as "candidates for review", NOT
 * "safe to delete". The tool description makes this explicit to the LLM.
 */
export function vaultFindOrphanFiles(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_find_orphan_files",
                description:
                    "Find files that are NOT linked or embedded from any note, based on Obsidian's resolved link graph. " +
                    "Useful for cleanup review: surfacing notes with no backlinks, or attachments (images, PDFs, audio, etc.) " +
                    "that appear to be unreferenced. " +
                    "IMPORTANT: Results are CANDIDATES FOR REVIEW, not automatically safe to delete. " +
                    "Obsidian's link index only tracks explicit markdown links and embeds; files may still be referenced via " +
                    "YAML frontmatter (e.g. `cover: image.png`), code blocks, Dataview queries, or other plugins (e.g. Excalidraw). " +
                    "When presenting these to the user, frame them as 'possibly unused' and recommend human verification before deletion. " +
                    "Use this when the user asks 'find unused files', 'orphan notes', 'unreferenced attachments', 'which images are not used', " +
                    "'clean up vault', etc.",
                parameters: {
                    type: "object",
                    properties: {
                        kind: {
                            type: "string",
                            enum: ["all", "note", "attachment"],
                            description:
                                "Which kind of files to scan. 'all' (default) scans every file. " +
                                "'note' scans only markdown/canvas notes (.md, .canvas). " +
                                "'attachment' scans only non-note files (images, PDFs, audio, etc.).",
                        },
                        folder_prefix: {
                            type: "string",
                            description:
                                "Optional vault-relative folder prefix filter (e.g. 'Attachments/'). " +
                                "Only files whose path starts with this prefix are considered. Omit to scan the entire vault.",
                        },
                        extension: {
                            type: "string",
                            description:
                                "Optional exact extension filter (e.g. 'png', 'pdf'). " +
                                "Leading dot is tolerated. Omit to include every extension.",
                        },
                        sort_by: {
                            type: "string",
                            enum: ["path", "size", "mtime"],
                            description:
                                "Sort key for the result page. 'path' (default) gives stable, pageable ordering. " +
                                "'size' and 'mtime' are useful when the user wants to prioritise large or stale files.",
                        },
                        sort_order: {
                            type: "string",
                            enum: ["asc", "desc"],
                            description:
                                "Sort direction. Defaults to 'asc' for 'path', 'desc' for 'size' and 'mtime' when omitted.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of matching orphan files to skip before starting to collect results. " +
                                "Use together with `limit` for paginated browsing. Defaults to 0. " +
                                "When `has_more` is true, increase `skip` by the previous `count` to fetch the next page.",
                        },
                        limit: {
                            type: "number",
                            description:
                                "Maximum number of orphan files to return in this page. Defaults to 100. Hard maximum 500.",
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const kindRaw = (args["kind"] as string) ?? "all";
            if (kindRaw !== "all" && kindRaw !== "note" && kindRaw !== "attachment") {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid kind "${kindRaw}". Must be "all", "note", or "attachment".`,
                };
            }
            const kind = kindRaw;

            const folderPrefixRaw = args["folder_prefix"] as string | undefined;
            const normalizedPrefix = folderPrefixRaw
                ? folderPrefixRaw.endsWith("/") ? folderPrefixRaw : folderPrefixRaw + "/"
                : undefined;

            const extensionRaw = args["extension"] as string | undefined;
            const normalizedExt = extensionRaw ? extensionRaw.replace(/^\./, "").toLowerCase() : undefined;

            const sortByRaw = (args["sort_by"] as string) ?? "path";
            if (sortByRaw !== "path" && sortByRaw !== "size" && sortByRaw !== "mtime") {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid sort_by "${sortByRaw}". Must be "path", "size", or "mtime".`,
                };
            }
            const sortBy = sortByRaw;

            const sortOrderRaw = args["sort_order"] as string | undefined;
            if (sortOrderRaw !== undefined && sortOrderRaw !== "asc" && sortOrderRaw !== "desc") {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid sort_order "${sortOrderRaw}". Must be "asc" or "desc".`,
                };
            }
            const sortOrder: "asc" | "desc" = sortOrderRaw
                ? sortOrderRaw
                : sortBy === "path" ? "asc" : "desc";

            const skip = Math.max(0, (args["skip"] as number) ?? 0);
            const rawLimit = (args["limit"] as number) ?? 100;
            const limit = Math.max(1, Math.min(500, rawLimit));

            // Build the set of referenced paths from resolvedLinks.
            // `resolvedLinks[source][target] = count` — target paths are what we want.
            // This also covers embeds (`![[...]]`) since Obsidian resolves them into the same index.
            const resolved = plugin.app.metadataCache.resolvedLinks;
            const referenced = new Set<string>();
            for (const sourcePath of Object.keys(resolved)) {
                const targets = resolved[sourcePath];
                if (!targets) continue;
                for (const targetPath of Object.keys(targets)) {
                    if ((targets[targetPath] ?? 0) > 0) {
                        referenced.add(targetPath);
                    }
                }
            }

            // Collect candidate orphans.
            const orphans: TFile[] = [];
            let totalSizeBytes = 0;

            for (const file of plugin.app.vault.getFiles()) {
                const ext = file.extension.toLowerCase();
                const isNote = MARKDOWN_EXTENSIONS.has(ext);

                if (kind === "note" && !isNote) continue;
                if (kind === "attachment" && isNote) continue;
                if (normalizedExt && ext !== normalizedExt) continue;
                if (normalizedPrefix && !file.path.startsWith(normalizedPrefix)) continue;

                if (referenced.has(file.path)) continue;

                orphans.push(file);
                totalSizeBytes += file.stat.size;
            }

            // Sort.
            const dir = sortOrder === "asc" ? 1 : -1;
            orphans.sort((a, b) => {
                switch (sortBy) {
                    case "size":
                        return (a.stat.size - b.stat.size) * dir
                            || a.path.localeCompare(b.path);
                    case "mtime":
                        return (a.stat.mtime - b.stat.mtime) * dir
                            || a.path.localeCompare(b.path);
                    case "path":
                    default:
                        return a.path.localeCompare(b.path) * dir;
                }
            });

            const totalMatches = orphans.length;
            const page = orphans.slice(skip, skip + limit);
            const hasMore = skip + page.length < totalMatches;

            const items = page.map((f) => ({
                path: f.path,
                extension: f.extension,
                size: f.stat.size,
                mtime: f.stat.mtime,
                ctime: f.stat.ctime,
            }));

            return {
                success: true,
                type: "object",
                content: {
                    kind,
                    folder_prefix: normalizedPrefix ?? null,
                    extension: normalizedExt ?? null,
                    sort_by: sortBy,
                    sort_order: sortOrder,
                    total_matches: totalMatches,
                    total_size_bytes: totalSizeBytes,
                    skip,
                    count: items.length,
                    has_more: hasMore,
                    note:
                        "Orphan detection is based on Obsidian's resolved link index and does not account for " +
                        "references in YAML frontmatter, code blocks, Dataview queries, or other plugins. " +
                        "Treat results as candidates for human review, not as safe-to-delete.",
                    items,
                },
            };
        },
    };
}
