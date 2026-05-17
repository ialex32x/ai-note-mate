import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { collectTagsForFile } from "./_tag-ops";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: list_tags
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate all tags across the vault.
 */
export function vaultListTags(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "list_tags",
                description:
                    "List all tags in the vault with per-tag note counts. Tags are returned as `#tag`. " +
                    "Optionally filter by a prefix to narrow to a tag namespace (e.g. `project/`). " +
                    "Use to discover tag vocabulary before searching for notes.",
                parameters: {
                    type: "object",
                    properties: {
                        prefix: {
                            type: "string",
                            description:
                                "Optional tag prefix filter. Can be provided with or without the leading '#'. " +
                                "Example: 'project/' returns all sub-tags of #project. Omit to list all tags.",
                        },
                        limit: {
                            type: "number",
                            description:
                                "Maximum number of tags to return, sorted by descending note count. Defaults to 100.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of tags to skip. Defaults to 0. " +
                                "Set to previous skip + number of returned tags to fetch the next page when has_more is true.",
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const rawPrefix = args["prefix"] as string | undefined;
            const limit = (args["limit"] as number) ?? 100;
            const skip = Math.max(0, (args["skip"] as number) ?? 0);

            // Normalise prefix: always matches against the leading '#' form
            let prefix: string | undefined;
            if (rawPrefix && rawPrefix.length > 0) {
                prefix = rawPrefix.startsWith("#") ? rawPrefix : "#" + rawPrefix;
            }

            const counts = new Map<string, number>();
            for (const file of plugin.app.vault.getMarkdownFiles()) {
                const tags = collectTagsForFile(plugin, file);
                for (const tag of tags) {
                    if (prefix && !tag.startsWith(prefix)) continue;
                    counts.set(tag, (counts.get(tag) ?? 0) + 1);
                }
            }

            const sorted = [...counts.entries()]
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

            const totalUniqueTags = counts.size;
            const paginated = sorted.slice(skip, skip + limit);
            const hasMore = skip + paginated.length < totalUniqueTags;

            return {
                success: true,
                type: "object",
                content: {
                    total_unique_tags: totalUniqueTags,
                    has_more: hasMore,
                    skip,
                    tags: paginated,
                },
            };
        },
    };
}
