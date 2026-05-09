import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import { UrlContentFetcher } from "../search/url-content-fetcher";

// ─────────────────────────────────────────────────────────────────────────────
// Registration entry
// ─────────────────────────────────────────────────────────────────────────────

export function createWebFetchTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    if (!plugin.settings.builtinWebFetchEnabled) return [];
    return [webFetch(plugin)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: web_fetch_url
// ─────────────────────────────────────────────────────────────────────────────

function webFetch(_plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "web_fetch_url",
                description:
                    "Fetch and extract the readable text content of a web page at the given URL. " +
                    "Returns structured markdown-formatted content including headings, paragraphs, and links. " +
                    "Use this when the user wants to read, fetch, retrieve, get, open, or access " +
                    "the content of a specific web page or URL.",
                parameters: {
                    type: "object",
                    properties: {
                        url: {
                            type: "string",
                            description: "The full URL of the page to fetch.",
                        },
                        depth: {
                            type: "number",
                            description: "How many link-levels deep to crawl from the starting URL (default 1, i.e. only the given page).",
                        },
                    },
                    required: ["url"],
                },
            },
        },
        capabilities: ["network"] as ToolCapability[],
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const url = args["url"] as string;
            const depth = (args["depth"] as number | undefined) ?? 1;
            try {
                const fetcher = new UrlContentFetcher({ depth, maxPages: 5 });
                const pages = await fetcher.fetch(url, signal);
                return { success: true, type: "object", content: pages };
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, type: "text", content: `Fetch failed: ${msg}` };
            }
        },
    };
}
