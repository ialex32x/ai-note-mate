import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import { DEFAULT_RSS_FETCH_HARD_LIMIT, DEFAULT_RSS_FETCH_SOFT_LIMIT } from "../../settings/defaults";
import { RSSParser } from "../search/rss-parser";
import { isAbortError } from "../../utils/abortable-request";

// ─────────────────────────────────────────────────────────────────────────────
// Registration entry
// ─────────────────────────────────────────────────────────────────────────────

export function createRSSFetchTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    if (!plugin.settings.builtinRSSFetchEnabled) return [];
    return [rssFetch(plugin)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: rss_fetch_feed
// ─────────────────────────────────────────────────────────────────────────────

function rssFetch(_plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "rss_fetch_feed",
                description:
                    "Fetch and parse an RSS or Atom feed from a given URL. " +
                    "Returns the feed metadata and a list of items (title, link, description, date, author). " +
                    "Use this when the user wants to read, subscribe to, or check updates from a blog, news site, " +
                    "podcast, or any RSS/Atom feed source.",
                parameters: {
                    type: "object",
                    properties: {
                        url: {
                            type: "string",
                            description: "The RSS/Atom feed URL to fetch.",
                        },
                        max_items: {
                            type: "number",
                            description: "Maximum number of feed items to return (default 20, max 50).",
                        },
                    },
                    required: ["url"],
                },
            },
        },
        capabilities: ["network"] as ToolCapability[],
        maxCallsPerTurn: {
            soft: DEFAULT_RSS_FETCH_SOFT_LIMIT,
            hard: DEFAULT_RSS_FETCH_HARD_LIMIT,
        },
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const url = args["url"] as string;
            const maxItems = Math.min((args["max_items"] as number | undefined) ?? 20, 50);

            try {
                // Validate URL
                new URL(url);

                // Parse feed
                const parserInstance = new RSSParser({ maxItems });
                const result = await parserInstance.parseURL(url, signal);

                // Return structured data
                return {
                    success: true,
                    type: "object",
                    content: {
                        feed: result.feed,
                        items: result.items,
                        type: result.type,
                        sourceUrl: result.sourceUrl,
                        itemCount: result.items.length,
                    },
                };
            } catch (err) {
                if (isAbortError(err)) throw err;

                // Handle specific error cases
                if (err instanceof TypeError && err.message.includes('URL')) {
                    return { success: false, type: "text", content: `Invalid URL: ${url}` };
                }

                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, type: "text", content: `Failed to fetch RSS feed: ${msg}` };
            }
        },
    };
}
