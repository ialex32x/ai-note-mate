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
                    "Find all markdown notes that carry any of the given tags. " +
                    "ALWAYS batch multiple tags into a single call (up to 10) — NEVER issue separate calls for each tag. " +
                    "A file is included if it matches ANY of the provided tags (OR semantics). " +
                    "Each returned file lists which of the searched tags it matched in its matched_tags field, " +
                    "so you can derive per-tag counts from a single batch call without querying tags individually. " +
                    "By default matches each tag exactly; set 'include_descendants' to true to also match nested sub-tags " +
                    "(e.g. tag='project' with descendants matches #project/alpha, #project/beta, etc.).",
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
            const limit = (args["limit"] as number) ?? 200;
            const skip = Math.max(0, (args["skip"] as number) ?? 0);

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

            const matchesTag = (t: string): boolean => {
                for (const m of tagMatchers) {
                    if (t === m.normalized) return true;
                    if (includeDescendants && t.startsWith(m.prefix)) return true;
                }
                return false;
            };

            // Collect ALL matching files (do not break early — we need total count for pagination)
            const seen = new Set<string>();
            const allMatches: { path: string; mtime: number; matched_tags: string[] }[] = [];

            for (const file of plugin.app.vault.getMarkdownFiles()) {
                if (seen.has(file.path)) continue;

                const fileTags = collectTagsForFile(plugin, file);
                const matched: string[] = [];
                for (const ft of fileTags) {
                    if (matchesTag(ft)) {
                        matched.push(ft);
                    }
                }

                if (matched.length > 0) {
                    seen.add(file.path);
                    allMatches.push({ path: file.path, mtime: file.stat.mtime, matched_tags: matched });
                }
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
