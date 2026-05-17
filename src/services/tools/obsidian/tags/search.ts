import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { collectTagsForFile } from "./_tag-ops";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: search_by_tag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all markdown files that carry the specified tag (exact or prefix match).
 */
export function vaultSearchByTag(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "search_by_tag",
                description:
                    "Find all markdown notes that carry the given tag(s). ALWAYS batch multiple tags " +
                    "(up to 10) into a single call — NEVER issue separate calls per tag. " +
                    "`match_mode` combines the tag list: 'any' (OR, default — file matches if it has any " +
                    "one tag) or 'all' (AND — file must carry every tag). With `include_descendants=true`, " +
                    "each searched tag is also satisfied by any of its descendants (so `match_mode='all'` " +
                    "+ descendants on `['project','urgent']` matches a file tagged `#project/alpha` + " +
                    "`#urgent/today`). Each returned file lists which searched tags it matched under " +
                    "`matched_tags` — enough to derive per-tag counts from one batch call.",
                parameters: {
                    type: "object",
                    properties: {
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Array of tags to search for (1–10 tags), with or without the leading '#'. " +
                                "Example: ['project', '#review'].",
                        },
                        match_mode: {
                            type: "string",
                            enum: ["any", "all"],
                            description:
                                "How to combine the tag list. 'any' (default) = OR — a file matches if it carries " +
                                "ANY one of the tags. 'all' = AND — a file must carry EVERY tag. With a single " +
                                "tag in the list, both modes are equivalent.",
                        },
                        include_descendants: {
                            type: "boolean",
                            description:
                                "If true, also match nested sub-tags (e.g. tag='project' matches #project/alpha). " +
                                "Defaults to false (exact match only).",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of matching files to return. Defaults to 200.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of matching results to skip. Defaults to 0. " +
                                "Set to previous skip + count to fetch the next page when has_more is true.",
                        },
                    },
                    required: ["tags"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const rawTags = args["tags"] as string[];
            const includeDescendants = (args["include_descendants"] as boolean) ?? false;
            const matchModeRaw = (args["match_mode"] as string | undefined) ?? "any";
            const limit = (args["limit"] as number) ?? 200;
            const skip = Math.max(0, (args["skip"] as number) ?? 0);

            if (matchModeRaw !== "any" && matchModeRaw !== "all") {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid match_mode '${matchModeRaw}'. Must be 'any' or 'all'.`,
                };
            }
            const matchMode = matchModeRaw;

            if (!Array.isArray(rawTags) || rawTags.length === 0) {
                return { success: false, type: "text", content: "tags must be a non-empty array of tag names." };
            }
            if (rawTags.length > 10) {
                return { success: false, type: "text", content: `Too many tags (${rawTags.length}); maximum is 10.` };
            }

            // Normalise all tags and build matchers
            const normalized = rawTags.map((raw) => {
                if (!raw || raw.trim() === "") return null;
                const n = raw.startsWith("#") ? raw : "#" + raw;
                return { original: raw, normalized: n, prefix: n.endsWith("/") ? n : n + "/" };
            });

            const invalidTag = normalized.find((n) => n === null);
            if (invalidTag) {
                return { success: false, type: "text", content: "Each tag must be a non-empty string." };
            }

            const tagMatchers = normalized as NonNullable<typeof normalized[number]>[];

            // Per-matcher predicate: does this single searched tag match a file
            // tag? (exact, or under-its-descendants when include_descendants).
            const tagMatchesMatcher = (
                fileTag: string,
                matcher: typeof tagMatchers[number],
            ): boolean => {
                if (fileTag === matcher.normalized) return true;
                if (includeDescendants && fileTag.startsWith(matcher.prefix)) return true;
                return false;
            };

            // Collect ALL matching files (do not break early — we need total count for pagination)
            const seen = new Set<string>();
            const allMatches: { path: string; mtime: number; matched_tags: string[] }[] = [];

            for (const file of plugin.app.vault.getMarkdownFiles()) {
                if (seen.has(file.path)) continue;

                const fileTags = collectTagsForFile(plugin, file);
                if (fileTags.length === 0) continue;

                // For each searched matcher, find which (if any) of the file's
                // tags satisfy it. In `any` mode any matcher's hit is enough;
                // in `all` mode every matcher must have at least one hit.
                const matchedSet = new Set<string>();
                let allMatchersSatisfied = true;
                for (const matcher of tagMatchers) {
                    let matcherSatisfied = false;
                    for (const ft of fileTags) {
                        if (tagMatchesMatcher(ft, matcher)) {
                            matchedSet.add(ft);
                            matcherSatisfied = true;
                            // For `any` we still keep scanning to populate
                            // matched_tags (which is per-file evidence,
                            // useful for the caller's downstream reporting).
                            // Continue rather than break.
                        }
                    }
                    if (!matcherSatisfied) {
                        allMatchersSatisfied = false;
                        if (matchMode === "all") break; // short-circuit AND
                    }
                }

                const isMatch = matchMode === "all" ? allMatchersSatisfied : matchedSet.size > 0;
                if (!isMatch) continue;

                seen.add(file.path);
                allMatches.push({
                    path: file.path,
                    mtime: file.stat.mtime,
                    matched_tags: [...matchedSet],
                });
            }

            // Sort by mtime descending (most recently modified first) for deterministic pagination
            allMatches.sort((a, b) => b.mtime - a.mtime);

            const totalMatches = allMatches.length;
            const files = allMatches.slice(skip, skip + limit);
            const hasMore = skip + files.length < totalMatches;

            return {
                success: true,
                type: "object",
                content: {
                    searched_tags: tagMatchers.map((m) => m.normalized),
                    match_mode: matchMode,
                    include_descendants: includeDescendants,
                    total_matches: totalMatches,
                    has_more: hasMore,
                    skip,
                    count: files.length,
                    files,
                },
            };
        },
    };
}
