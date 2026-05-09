import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import { EnhancedWebSearcher } from "../search/enhanced-web-searcher";
import { ImageWebSearcher } from "../search/image-web-searcher";
import { joinPath } from "../../utils/path-helper";
import { DEFAULT_SETTINGS } from "settings";
import { checkAbort } from "../../utils/abortable-request";

export function createWebSearchTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    if (!plugin.settings.builtinWebSearchEnabled) return [];
    
    return [
        webSearch(plugin),
        imageSearch(plugin),
        saveImageUrls(plugin),
        downloadImages(plugin),
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: web_search
// ─────────────────────────────────────────────────────────────────────────────

function webSearch(_plugin: NoteAssistantPlugin): RegisteredTool {
    const searcher = new EnhancedWebSearcher();
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "web_search",
                description:
                    "Search the web using DuckDuckGo and return a list of results (title, URL, snippet). " +
                    "Use this when the user asks to search, look up, find information, check, or query something " +
                    "on the internet/web. Call this before using web_fetch_url to get the actual content.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The search query string.",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of results to return (default 10, max 20).",
                        },
                    },
                    required: ["query"],
                },
            },
        },
        capabilities: ["network"] as ToolCapability[],
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const query = args["query"] as string;
            const limit = Math.min((args["limit"] as number | undefined) ?? 10, 20);
            try {
                const results = await searcher.search(query, limit, signal);
                return { success: true, type: "object", content: results };
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, type: "text", content: `Search failed: ${msg}` };
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: image_search
// ─────────────────────────────────────────────────────────────────────────────

function imageSearch(_plugin: NoteAssistantPlugin): RegisteredTool {
    const searcher = new ImageWebSearcher();
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "image_search",
                description:
                    "Search for images on the web and return a list of image URLs matching the query. " +
                    "Use this when the user wants to find, look for, or search for images/pictures online. " +
                    "Note: Only URLs are returned; use save_image_urls or download_images to save images to the vault.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The search query for images.",
                        },
                    },
                    required: ["query"],
                },
            },
        },
        capabilities: ["network"] as ToolCapability[],
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const query = args["query"] as string;
            try {
                const urls = await searcher.search(query, signal);
                return { success: true, type: "object", content: urls };
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, type: "text", content: `Image search failed: ${msg}` };
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: save_image_urls
// ─────────────────────────────────────────────────────────────────────────────

// Common function to download images from URLs
async function downloadImagesFromUrls(
    plugin: NoteAssistantPlugin,
    urls: string[],
    limit: number,
    searcher: ImageWebSearcher,
    signal?: AbortSignal,
): Promise<ToolCallResult> {
    if (urls.length === 0) {
        return { success: false, type: "text", content: "No URLs provided." };
    }

    // Shuffle URLs randomly
    const shuffled = [...urls];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = shuffled[i]!;
        shuffled[i] = shuffled[j]!;
        shuffled[j] = temp;
    }

    try {
        const downloadDirName = plugin.settings.imageDownloadDir || DEFAULT_SETTINGS.imageDownloadDir;
        const vault = plugin.app.vault;
        const vaultRoot = vault.getRoot().path;
        const saveDir = joinPath(vaultRoot, downloadDirName);

        if (!vault.getAbstractFileByPath(saveDir)) {
            await vault.createFolder(saveDir);
        }

        const savedPaths: string[] = [];
        for (const url of shuffled) {
            checkAbort(signal);
            if (savedPaths.length >= limit) break;
            const savedPath = await searcher.download(url, vault, saveDir, signal);
            if (savedPath) {
                savedPaths.push(savedPath);
            }
        }

        if (savedPaths.length > 0) {
            const content = savedPaths.map(p => `Image saved to: ${p}`).join("\n");
            return { success: true, type: "text", content };
        } else {
            return { success: false, type: "text", content: "Failed to save any image: all URLs resulted in errors." };
        }
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, type: "text", content: `Save image failed: ${msg}` };
    }
}

function saveImageUrls(plugin: NoteAssistantPlugin): RegisteredTool {
    const searcher = new ImageWebSearcher();
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "save_image_urls",
                description:
                    "Save images from a list of URLs to the vault. " +
                    "Images are tried in random order until the requested count is successfully saved. " +
                    "Use this when the user has specific image URLs and wants to download, save, or store them in the vault.",
                parameters: {
                    type: "object",
                    properties: {
                        urls: {
                            type: "array",
                            description: "An array of image URLs to save.",
                            items: { type: "string" },
                        },
                        limit: {
                            type: "number",
                            description: "Number of images to save. Must not exceed 20.",
                        },
                    },
                    required: ["urls", "limit"],
                },
            },
        },
        capabilities: ["network", "create_file"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const urls = (args["urls"] as string[]) ?? [];
            const limit = Math.min(Math.max((args["limit"] as number) || 0, 1), 20);

            return downloadImagesFromUrls(plugin, urls, limit, searcher, signal);
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: download_images (combines image_search + save_image_urls)
// ─────────────────────────────────────────────────────────────────────────────

function downloadImages(plugin: NoteAssistantPlugin): RegisteredTool {
    const searcher = new ImageWebSearcher();
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "download_images",
                description:
                    "Search for images on the web and save them to the vault in one step. " +
                    "Combines image search and download in a single operation. " +
                    "Use this when the user wants to find and download/save images from the internet to the vault, " +
                    "without needing separate search and save steps.",
                parameters: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The search query for images.",
                        },
                        limit: {
                            type: "number",
                            description: "Number of images to save. Must not exceed 20.",
                        },
                    },
                    required: ["query", "limit"],
                },
            },
        },
        capabilities: ["network", "create_file"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const query = args["query"] as string;
            const limit = Math.min(Math.max((args["limit"] as number) || 0, 1), 20);

            try {
                const urls = await searcher.search(query, signal);

                if (urls.length === 0) {
                    return { success: false, type: "text", content: "No images found for the given query." };
                }

                return downloadImagesFromUrls(plugin, urls, limit, searcher, signal);
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                const msg = err instanceof Error ? err.message : String(err);
                return { success: false, type: "text", content: `Download images failed: ${msg}` };
            }
        },
    };
}


