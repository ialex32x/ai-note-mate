import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: search_files
// ─────────────────────────────────────────────────────────────────────────────

export function vaultSearchFiles(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "search_files",
                description:
                    "Find files in the vault by path / filename keyword (case-insensitive substring). " +
                    "Use for 'find file X', 'locate notes named …', etc. Paginated: when `has_more` is " +
                    "true, increase `skip` by the previous `count` for the next page.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "Keyword to match against file paths.",
                        },
                        extension: {
                            type: "string",
                            description:
                                "Optional file extension filter, e.g. 'md', 'pdf'. " +
                                "Omit to match all extensions.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of matching files to skip before collecting results. Defaults to 0. " +
                                "Use together with `limit` for pagination.",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of results to return. Defaults to 20.",
                        },
                    },
                    required: ["query"],
                },
            },
        },
        exec: async (_chatStream, args, _signal) => {
            const query = (args["query"] as string).toLowerCase();
            const extension = args["extension"] as string | undefined;
            const skip = Math.max(0, (args["skip"] as number) ?? 0);
            const limit = Math.max(1, (args["limit"] as number) ?? 20);

            const allFiles = plugin.app.vault.getFiles();
            const matches = allFiles.filter((f) => {
                const pathMatch = f.path.toLowerCase().includes(query);
                const extMatch = extension ? f.extension === extension.replace(/^\./, "") : true;
                return pathMatch && extMatch;
            });

            const total = matches.length;
            const page = matches.slice(skip, skip + limit);
            const hasMore = skip + page.length < total;
            const files = page.map((f) => ({ path: f.path, name: f.name, extension: f.extension }));

            return {
                success: true,
                type: "object",
                content: {
                    query,
                    total,
                    count: files.length,
                    skip,
                    has_more: hasMore,
                    files,
                },
            };
        },
    };
}
