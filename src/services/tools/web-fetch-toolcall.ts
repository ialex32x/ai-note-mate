import type NoteAssistantPlugin from "../../main";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";
import {
    EMPTY_PAGE_THRESHOLD,
    UrlContentFetcher,
    normalizeUrl,
    type ExtractionStatus,
    type WebPageContent,
} from "../search/url-content-fetcher";
import { DEFAULT_WEB_FETCH_HARD_LIMIT, DEFAULT_WEB_FETCH_SOFT_LIMIT } from "../../settings/defaults";

// ─────────────────────────────────────────────────────────────────────────────
// Registration entry
// ─────────────────────────────────────────────────────────────────────────────

export function createWebFetchTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    if (!plugin.settings.builtinWebFetchEnabled) return [];
    const webSearchAvailable = plugin.settings.builtinWebSearchEnabled;
    return [webFetch(plugin, webSearchAvailable)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: web_fetch_url
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the per-turn budget for `web_fetch_url`. Values <= 0 from the
 * user settings fall back to the built-in defaults (matches how other
 * numeric settings in this plugin treat "0" / blank).
 */
function resolveBudget(plugin: NoteAssistantPlugin): { soft: number; hard: number } {
    const settings = plugin.settings;
    const rawSoft = settings.webFetchSoftLimit;
    const rawHard = settings.webFetchHardLimit;
    const soft = typeof rawSoft === 'number' && rawSoft > 0 ? rawSoft : DEFAULT_WEB_FETCH_SOFT_LIMIT;
    const hard = typeof rawHard === 'number' && rawHard > 0 ? rawHard : DEFAULT_WEB_FETCH_HARD_LIMIT;
    // Defensive: ensure soft <= hard so the reminder always trips before the block.
    return { soft: Math.min(soft, hard), hard };
}

/**
 * Look up whether the same URL was already fetched earlier in the current
 * user turn. Scope = messages after the most recent `user` message,
 * excluding the in-flight tool_call (which is already in history at the
 * point this runs — see ChatStream.prompt). Returns the prior tool_call
 * message if a hit is found, `null` otherwise.
 *
 * Why per-turn instead of per-session: across turns, the user might
 * legitimately ask "fetch X again, it should be updated now"; we don't
 * want stale-cache surprises. Within a single turn, repeated fetches of
 * the same URL are almost always the model spinning on a failure.
 */
function findPriorFetchInCurrentTurn(
    chatStream: ChatStream,
    currentToolCallId: string | undefined,
    targetUrlNormalized: string,
): string | null {
    const msgs = chatStream.messages;
    // Find the boundary: the most recent user message marks the start of
    // the current turn. Anything before it belongs to a previous turn.
    let turnStart = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === 'user') {
            turnStart = i;
            break;
        }
    }
    const slice = msgs.slice(turnStart + 1);
    for (const m of slice) {
        if (m.role !== 'tool_call') continue;
        const meta = m.toolCallMeta;
        if (!meta || meta.toolName !== 'web_fetch_url') continue;
        if (meta.toolCallId === currentToolCallId) continue; // skip self
        if (!m.toolCallResult) continue; // only count completed prior calls
        const prevUrl = meta.toolArgs?.['url'];
        if (typeof prevUrl !== 'string') continue;
        if (normalizeUrl(prevUrl) === targetUrlNormalized) {
            return meta.toolCallId;
        }
    }
    return null;
}

/**
 * Render a human-readable failure message for the model when the
 * fetcher reports `extractionStatus !== 'ok'`. Each branch ends with
 * an explicit instruction to *stop retrying this URL* — empirically,
 * without that instruction models will happily call us again with
 * minor URL variations.
 */
function describeExtractionFailure(page: WebPageContent, status: ExtractionStatus, webSearchAvailable: boolean): string {
    const base = `Failed to extract content from ${page.url}.`;
    const searchHint = webSearchAvailable
        ? `try web_search to find an alternative source, `
        : '';
    switch (status) {
        case 'http_error':
            return `${base} HTTP ${page.httpStatus ?? '?'} returned by the server. ` +
                `Do NOT retry this URL — ${searchHint}` +
                `or tell the user the URL is not reachable.`;
        case 'anti_bot_challenge':
            return `${base} The page returned an anti-bot challenge (e.g. Cloudflare / "Just a moment…"). ` +
                `This plugin cannot solve such challenges. Do NOT retry this URL — ${searchHint}` +
                `for the same information elsewhere, or tell the user the page is gated.`;
        case 'empty': {
            const staticHint = webSearchAvailable
                ? `try web_search to find a static / text-based source.`
                : `look for a static / text-based source.`;
            return `${base} The page was fetched (HTTP ${page.httpStatus ?? 200}) but no readable text was extracted ` +
                `(${page.totalTextLength ?? 0} characters, below the ${EMPTY_PAGE_THRESHOLD}-char threshold). ` +
                `This is usually a JavaScript-rendered SPA, a paywall, or a thin landing page. ` +
                `Do NOT retry this URL — ${staticHint}`;
        }
        default:
            return base;
    }
}

function webFetch(plugin: NoteAssistantPlugin, webSearchAvailable: boolean): RegisteredTool {
    const searchFallback = webSearchAvailable
        ? `call \`web_search\` to find a different source, or summarize the material you already have.`
        : `summarize the material you already have or tell the user the URL is not reachable.`;
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
                    "the content of a specific web page or URL. " +
                    "IMPORTANT: this tool cannot execute JavaScript; SPAs, paywalls, and anti-bot pages will " +
                    "fail. When a fetch returns an error or 'no readable content', do NOT retry the same URL " +
                    `and do NOT iterate through many alternative URLs in a row — ${searchFallback} ` +
                    "Repeated calls in one turn are budgeted and will start to be refused.",
                parameters: {
                    type: "object",
                    properties: {
                        url: {
                            type: "string",
                            description: "The full URL of the page to fetch.",
                        },
                    },
                    required: ["url"],
                },
            },
        },
        capabilities: ["network"] as ToolCapability[],
        maxCallsPerTurn: resolveBudget(plugin),
        exec: async (chatStream, args, signal, context): Promise<ToolCallResult> => {
            const url = args["url"] as string;

            // ── Per-turn URL dedupe ──────────────────────────────────
            // Skip a second hit on the same URL within the same user
            // turn; the previous result is still visible in the
            // conversation, so we just point the model at it instead
            // of re-paying the network round-trip (and risking the
            // same "empty page" reply trapping it in a loop).
            let normalized: string;
            try {
                normalized = normalizeUrl(url);
            } catch {
                normalized = url;
            }
            const priorId = findPriorFetchInCurrentTurn(chatStream, context?.toolCallId, normalized);
            if (priorId) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `This URL was already fetched in the current turn (previous tool_call ${priorId}). ` +
                        `Refer to the earlier result instead of re-fetching. ` +
                        `If you need fresh data, ask the user to start a new turn.`,
                };
            }

            try {
                const fetcher = new UrlContentFetcher();
                const pages = await fetcher.fetch(url, signal);

                // If the entry page extraction failed, surface that as a
                // structured failure so the model gets a clear "stop"
                // signal instead of an empty `contents: []` it tends to
                // interpret as "this page is just empty; try another".
                const entry = pages[0];
                if (entry && entry.extractionStatus && entry.extractionStatus !== 'ok') {
                    return {
                        success: false,
                        type: "text",
                        content: describeExtractionFailure(entry, entry.extractionStatus, webSearchAvailable),
                    };
                }
                if (pages.length === 0) {
                    const noPageHint = webSearchAvailable
                        ? `try web_search for an alternative source.`
                        : `report this to the user.`;
                    return {
                        success: false,
                        type: "text",
                        content:
                            `Failed to fetch ${url}: no pages returned. ` +
                            `Do NOT retry this URL — ${noPageHint}`,
                    };
                }
                return { success: true, type: "object", content: pages };
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                const msg = err instanceof Error ? err.message : String(err);
                const catchHint = webSearchAvailable
                    ? `try web_search for an alternative source.`
                    : `report this to the user.`;
                return {
                    success: false,
                    type: "text",
                    content:
                        `Fetch failed: ${msg}. ` +
                        `Do NOT retry this URL — ${catchHint}`,
                };
            }
        },
    };
}
