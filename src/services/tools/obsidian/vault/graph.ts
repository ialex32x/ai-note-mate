import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";

const MARKDOWN_EXTENSIONS = new Set(["md", "canvas"]);

// Bounded so a single call into a large vault cannot OOM the prompt.
const UNRESOLVED_LINKS_DEFAULT_LIMIT = 100;
const UNRESOLVED_LINKS_MAX_LIMIT = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_backlinks
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
                name: "get_backlinks",
                description:
                    "Return all notes that link TO the given file (incoming / backlinks). " +
                    "Use for 'which notes link to X?', 'what references this note?', or to walk the " +
                    "knowledge graph backward from a known target. Only explicit `[[...]]`, `![[...]]`, " +
                    "and `[text](path)` links are indexed (no frontmatter / code blocks / Dataview).",
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
// Tool: find_orphan_files
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
                name: "find_orphan_files",
                description:
                    "Find files that are NOT linked or embedded from any note, based on Obsidian's resolved " +
                    "link graph. Useful for cleanup review (orphan notes, unreferenced attachments). " +
                    "Results are CANDIDATES FOR REVIEW — Obsidian only indexes explicit `[[...]]`, " +
                    "`![[...]]`, and `[text](path)` links, so files referenced from YAML frontmatter, " +
                    "code blocks, Dataview, or plugins (Excalidraw, etc.) may show up as orphans. Frame " +
                    "results to the user as 'possibly unused' and recommend human verification before " +
                    "deletion.",
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

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_outgoing_links
//
// Mirror of `get_backlinks` for the OUTGOING direction. Reads the target's
// row in `metadataCache.resolvedLinks` (and optionally the same row in
// `unresolvedLinks`) so we expose only what Obsidian's typed API tracks —
// no scraping the file text ourselves.
//
// Caveat parallel to `find_orphan_files`: only explicit `[[wikilink]]`,
// `![[embed]]`, and `[text](path)` references are indexed. Frontmatter path
// fields, code blocks, and Dataview queries are NOT.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultGetOutgoingLinks(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "get_outgoing_links",
                description:
                    "Return every note this file links TO (outgoing / forward links) — symmetric " +
                    "counterpart to `get_backlinks`. By default lists only references that resolve to " +
                    "a vault file; set `include_unresolved` to also list broken wikilinks under " +
                    "`unresolved`. Each entry carries the source-side occurrence count. " +
                    "Caveat: only explicit `[[...]]`, `![[...]]`, and `[text](path)` links are indexed; " +
                    "frontmatter path fields, code blocks, and Dataview queries are NOT.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path of the source file whose outgoing links should be returned.",
                        },
                        include_unresolved: {
                            type: "boolean",
                            description:
                                "If true, also include unresolved (broken) wikilinks under `unresolved`. " +
                                "Defaults to false.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const includeUnresolved = (args["include_unresolved"] as boolean) ?? false;

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const sourcePath = fileOrErr.path;

            // resolvedLinks: Record<sourcePath, Record<targetPath, count>>
            const resolvedRow = plugin.app.metadataCache.resolvedLinks[sourcePath] ?? {};
            const resolved: { target: string; count: number }[] = [];
            for (const target of Object.keys(resolvedRow)) {
                const count = resolvedRow[target] ?? 0;
                if (count > 0) resolved.push({ target, count });
            }
            // Order: count desc, then path asc — stable & high-signal first.
            resolved.sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));

            const content: Record<string, unknown> = {
                source: sourcePath,
                total_resolved: resolved.length,
                resolved,
            };

            if (includeUnresolved) {
                // unresolvedLinks: Record<sourcePath, Record<linkText, count>>
                const unresolvedRow = plugin.app.metadataCache.unresolvedLinks[sourcePath] ?? {};
                const unresolved: { link: string; count: number }[] = [];
                for (const link of Object.keys(unresolvedRow)) {
                    const count = unresolvedRow[link] ?? 0;
                    if (count > 0) unresolved.push({ link, count });
                }
                unresolved.sort((a, b) => b.count - a.count || a.link.localeCompare(b.link));
                content["total_unresolved"] = unresolved.length;
                content["unresolved"] = unresolved;
            }

            return { success: true, type: "object", content };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_unresolved_links
//
// Vault-wide aggregation of `metadataCache.unresolvedLinks`. Surfaces every
// broken wikilink so users (and the LLM) can plan fixes — create the missing
// note, rename the link, or remove it.
//
// Two views via `group_by`:
//   - "source" (default): per source file, what's broken
//   - "link":             per missing target, who points at it
// Both views are useful: "fix the references in this note" wants source view;
// "this note doesn't exist yet, who's pointing at it?" wants link view.
// ─────────────────────────────────────────────────────────────────────────────

interface UnresolvedPair {
    source: string;
    link: string;
    count: number;
}

export function vaultGetUnresolvedLinks(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "get_unresolved_links",
                description:
                    "List broken / unresolved wikilinks across the vault — every `[[Target]]` whose " +
                    "target does not (yet) exist as a file. Useful for finding references to fix, " +
                    "missing notes to create, or stale links after renames. " +
                    "Two views via `group_by`: 'source' (default) groups by the source file (how many " +
                    "broken links per note); 'link' groups by the missing target (which notes point at " +
                    "it — useful for 'who references X?' when X doesn't exist yet, or for ranking the " +
                    "most-pointed-at missing notes). Pagination operates on the chosen view's items. " +
                    "Caveat: only explicit links are indexed (no frontmatter / code blocks / Dataview).",
                parameters: {
                    type: "object",
                    properties: {
                        group_by: {
                            type: "string",
                            enum: ["source", "link"],
                            description:
                                "View shape. 'source' = one entry per source file with its broken links " +
                                "underneath. 'link' = one entry per missing target with the sources pointing " +
                                "at it underneath. Defaults to 'source'.",
                        },
                        folder_prefix: {
                            type: "string",
                            description:
                                "Optional vault-relative folder prefix filter on the SOURCE file path " +
                                "(e.g. 'Projects/'). Only broken links from files under this prefix are returned. " +
                                "Omit to scan the entire vault.",
                        },
                        link_filter: {
                            type: "string",
                            description:
                                "Optional case-insensitive substring filter on the unresolved link text. " +
                                "Use to narrow to a specific missing target name. Omit to include all.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of grouped entries to skip before collecting results. Defaults to 0. " +
                                "Use together with `limit` for pagination.",
                        },
                        limit: {
                            type: "number",
                            description:
                                `Maximum number of grouped entries to return per page. Defaults to ${UNRESOLVED_LINKS_DEFAULT_LIMIT}. ` +
                                `Hard maximum ${UNRESOLVED_LINKS_MAX_LIMIT}.`,
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const groupByRaw = (args["group_by"] as string | undefined) ?? "source";
            if (groupByRaw !== "source" && groupByRaw !== "link") {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid group_by '${groupByRaw}'. Must be 'source' or 'link'.`,
                };
            }
            const groupBy = groupByRaw;

            const folderPrefixRaw = args["folder_prefix"] as string | undefined;
            const normalizedPrefix = folderPrefixRaw
                ? (folderPrefixRaw.endsWith("/") ? folderPrefixRaw : folderPrefixRaw + "/")
                : undefined;

            const linkFilterRaw = args["link_filter"] as string | undefined;
            const linkFilter = linkFilterRaw && linkFilterRaw.length > 0
                ? linkFilterRaw.toLowerCase()
                : undefined;

            const skip = Math.max(0, (args["skip"] as number) ?? 0);
            const rawLimit = (args["limit"] as number) ?? UNRESOLVED_LINKS_DEFAULT_LIMIT;
            const limit = Math.max(1, Math.min(UNRESOLVED_LINKS_MAX_LIMIT, rawLimit));

            // Flatten the (source, link) sparse matrix into a single pair list,
            // then regroup according to `group_by`. This keeps the filter logic
            // in exactly one place regardless of view shape.
            const unresolvedAll = plugin.app.metadataCache.unresolvedLinks;
            const pairs: UnresolvedPair[] = [];
            let totalPairs = 0;
            let totalOccurrences = 0;
            for (const source of Object.keys(unresolvedAll)) {
                if (normalizedPrefix && !source.startsWith(normalizedPrefix)) continue;
                const row = unresolvedAll[source];
                if (!row) continue;
                for (const link of Object.keys(row)) {
                    const count = row[link] ?? 0;
                    if (count <= 0) continue;
                    if (linkFilter && !link.toLowerCase().includes(linkFilter)) continue;
                    pairs.push({ source, link, count });
                    totalPairs++;
                    totalOccurrences += count;
                }
            }

            if (groupBy === "source") {
                // Group by source path.
                const bySource = new Map<string, { source: string; total: number; links: { link: string; count: number }[] }>();
                for (const p of pairs) {
                    let entry = bySource.get(p.source);
                    if (!entry) {
                        entry = { source: p.source, total: 0, links: [] };
                        bySource.set(p.source, entry);
                    }
                    entry.links.push({ link: p.link, count: p.count });
                    entry.total += p.count;
                }
                const grouped = [...bySource.values()];
                // Order entries by descending total broken-link count, then by path; inside
                // each entry, sort links the same way for predictable, signal-first output.
                grouped.sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
                for (const g of grouped) {
                    g.links.sort((a, b) => b.count - a.count || a.link.localeCompare(b.link));
                }

                const total = grouped.length;
                const page = grouped.slice(skip, skip + limit);
                const hasMore = skip + page.length < total;

                return {
                    success: true,
                    type: "object",
                    content: {
                        group_by: groupBy,
                        folder_prefix: normalizedPrefix ?? null,
                        link_filter: linkFilterRaw ?? null,
                        total,
                        total_unresolved_pairs: totalPairs,
                        total_unresolved_occurrences: totalOccurrences,
                        skip,
                        count: page.length,
                        has_more: hasMore,
                        note:
                            "Only explicit wikilinks / embeds / markdown links are tracked. " +
                            "References in frontmatter path fields, code blocks, Dataview queries, " +
                            "and other dynamic sources are NOT included.",
                        items: page,
                    },
                };
            }

            // group_by === "link"
            const byLink = new Map<string, { link: string; total: number; sources: { source: string; count: number }[] }>();
            for (const p of pairs) {
                let entry = byLink.get(p.link);
                if (!entry) {
                    entry = { link: p.link, total: 0, sources: [] };
                    byLink.set(p.link, entry);
                }
                entry.sources.push({ source: p.source, count: p.count });
                entry.total += p.count;
            }
            const grouped = [...byLink.values()];
            grouped.sort((a, b) => b.total - a.total || a.link.localeCompare(b.link));
            for (const g of grouped) {
                g.sources.sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
            }

            const total = grouped.length;
            const page = grouped.slice(skip, skip + limit);
            const hasMore = skip + page.length < total;

            return {
                success: true,
                type: "object",
                content: {
                    group_by: groupBy,
                    folder_prefix: normalizedPrefix ?? null,
                    link_filter: linkFilterRaw ?? null,
                    total,
                    total_unresolved_pairs: totalPairs,
                    total_unresolved_occurrences: totalOccurrences,
                    skip,
                    count: page.length,
                    has_more: hasMore,
                    note:
                        "Only explicit wikilinks / embeds / markdown links are tracked. " +
                        "References in frontmatter path fields, code blocks, Dataview queries, " +
                        "and other dynamic sources are NOT included.",
                    items: page,
                },
            };
        },
    };
}
