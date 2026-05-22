import { type CheerioAPI, type Cheerio, load as cheerioLoad } from "cheerio";
import { requestUrl, RequestUrlParam } from "obsidian";
import type { AnyNode, Element, Text } from "domhandler";
import { getUserAgent } from "./types";
import { withAbort, checkAbort } from "utils/abortable-request";

/**
 * Local type guard for domhandler text nodes.
 * Avoids importing `isText` as a value (would require declaring `domhandler`
 * as a direct dependency even though it's only a transitive dep of cheerio).
 * Comparing `node.type` (a `domelementtype` enum) against a bare string would
 * trigger `@typescript-eslint/no-unsafe-enum-comparison`; comparing the
 * enum-typed value against `String(...)` keeps the runtime check identical
 * while satisfying the rule, and the type predicate narrows `node` for callers.
 */
function isTextNode(node: AnyNode): node is Text {
    return String(node.type) === "text";
}

/**
 * Content block type
 */
export type ContentBlockType = 'heading' | 'paragraph' | 'list' | 'blockquote' | 'code' | 'text';

/**
 * Content block interface
 */
export interface ContentBlock {
    type: ContentBlockType;
    level?: number; // Heading level 1-6
    text: string;
}

/**
 * Content region interface
 */
export interface ContentElement {
    /** Region name, e.g., 'main', 'article', 'sidebar', 'header', 'footer' */
    name: string;
    /** Region selector */
    selector: string;
    /** Content blocks within the region */
    blocks: ContentBlock[];
}

/**
 * Outcome of trying to extract readable text from a fetched page.
 * Lets the calling tool tell the model the difference between
 * "the page is empty" (unlikely, but possible) and "we couldn't
 * extract anything useful — don't bother retrying the same URL".
 */
export type ExtractionStatus =
    | 'ok'                  // structured regions or body fallback produced usable text
    | 'empty'               // page fetched but no readable text after all heuristics
    | 'anti_bot_challenge'  // page looks like a CF/Akamai challenge or similar
    | 'http_error';         // non-2xx response from the server

/**
 * Crawl result interface
 */
export interface WebPageContent {
    /** URL address of the web page */
    url: string;
    
    /** Title of the web page */
    title: string;

    /** Structured content */
    contents: ContentElement[];

    /** List of links */
    links: string[];

    depth: number;
    timestamp: string;

    /**
     * Outcome of extraction. Only set when extraction returned something
     * other than the happy path; the toolcall layer uses this to convert
     * the result into a `success: false` for the model, so it stops
     * retrying URLs the plugin demonstrably cannot read.
     */
    extractionStatus?: ExtractionStatus;
    /** HTTP status code returned by the server. */
    httpStatus?: number;
    /**
     * Total readable character count across all extracted blocks. Used
     * by the toolcall layer to apply the "too small to be real content"
     * threshold uniformly across structured / body-fallback paths.
     */
    totalTextLength?: number;
}

/**
 * Crawl options interface
 */
export interface PageFetchOptions {
    /** Crawl depth, default is 1 (only crawl the starting page) */
    depth?: number;
    /** Maximum pages per depth, default is 10 */
    maxPages?: number;
    /** Request timeout in milliseconds, default is 10000 */
    timeout?: number;
    /** Whether to only crawl links under the same domain, default is true */
    sameDomain?: boolean;
    /** User-Agent */
    userAgent?: string;
    /** URL patterns to exclude (array of regex strings) */
    excludePatterns?: string[];
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: PageFetchOptions = {
    depth: 1,
    maxPages: 10,
    timeout: 10000,
    sameDomain: true,
    userAgent: undefined,
    excludePatterns: [],
};

/**
 * Heuristic signatures of anti-bot challenge pages (Cloudflare, Akamai,
 * Sucuri, etc.). When the visible body text is short AND contains one
 * of these, we treat it as an extraction failure rather than passing
 * the noise to the LLM as "page content".
 *
 * Lowercase, matched case-insensitively after collapsing whitespace.
 */
const ANTI_BOT_SIGNATURES: readonly string[] = [
    'just a moment',
    'checking your browser',
    'verify you are human',
    'verify you are a human',
    'enable javascript and cookies',
    'cf-browser-verification',
    'cf-challenge',
    'attention required! | cloudflare',
    'access denied',
    'pardon our interruption',
    'are you a robot',
];

/** Minimum extracted text length below which a page is considered empty. */
export const EMPTY_PAGE_THRESHOLD = 200;

/**
 * Module-level URL normalizer. Strips fragments and common tracking
 * params so the toolcall dedupe layer can compare two textually-different
 * URLs that point at the same resource. Returns the input unchanged on
 * any parsing error so callers never see normalization mask a typo.
 */
export function normalizeUrl(url: string): string {
    try {
        const urlObj = new URL(url);
        urlObj.hash = "";
        const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
        trackingParams.forEach(param => urlObj.searchParams.delete(param));
        return urlObj.href;
    } catch {
        return url;
    }
}

/**
 * Simple web crawler class
 */
export class UrlContentFetcher {
    private visitedUrls: Set<string> = new Set();
    private results: WebPageContent[] = [];
    private options: PageFetchOptions;
    private baseDomain: string = "";

    constructor(options: PageFetchOptions = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Start crawling
     * @param startUrl Starting URL
     * @returns Array of crawl results
     */
    async fetch(startUrl: string, signal?: AbortSignal): Promise<WebPageContent[]> {
        // Reset state
        this.visitedUrls.clear();
        this.results = [];

        // Normalize starting URL
        const normalizedUrl = this.normalizeUrl(startUrl);

        try {
            const urlObj = new URL(normalizedUrl);
            this.baseDomain = urlObj.hostname;
        } catch {
            throw new Error(`Invalid URL: ${startUrl}`);
        }

        // Start recursive crawling
        await this.crawlRecursive(normalizedUrl, 0, signal);

        return this.results;
    }

    /**
     * Recursive crawling
     */
    private async crawlRecursive(url: string, currentDepth: number, signal?: AbortSignal): Promise<void> {
        // Check for abort
        checkAbort(signal);

        // Check depth limit
        if (currentDepth > this.options.depth!) {
            return;
        }

        // Check if already visited
        if (this.visitedUrls.has(url)) {
            return;
        }

        // Check page count limit
        if (this.results.length >= this.options.maxPages!) {
            return;
        }

        // Check exclusion patterns
        if (this.shouldExclude(url)) {
            return;
        }

        // Mark as visited
        this.visitedUrls.add(url);

        try {
            // Fetch page content
            const result = await this.fetchAndParse(url, currentDepth, signal);
            if (result) {
                this.results.push(result);

                // If there's remaining depth, continue crawling links
                if (currentDepth < this.options.depth!) {
                    const validLinks = result.links.filter(link => this.isValidLink(link));

                    for (const link of validLinks) {
                        // Check page count limit
                        if (this.results.length >= this.options.maxPages!) {
                            break;
                        }
                        await this.crawlRecursive(link, currentDepth + 1, signal);
                    }
                }
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            console.error(`[Crawler] Error crawling ${url}:`, error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Fetch and parse a single page.
     *
     * Failure modes are surfaced via the returned `WebPageContent.extractionStatus`
     * (rather than thrown) so the toolcall layer can distinguish:
     *   - HTTP errors (4xx/5xx),
     *   - anti-bot challenge pages,
     *   - structurally empty / JS-rendered pages,
     * from a genuine "the page is healthy and empty". This is the key
     * fix for the "model retries fetching a flaky URL forever" loop:
     * an `extractionStatus !== 'ok'` will be reported back to the LLM
     * as `success: false` with an instruction to stop retrying.
     *
     * Returns `null` only on a thrown / aborted request that we
     * genuinely cannot represent (network exception); the outer
     * crawler logs and continues.
     */
    private async fetchAndParse(url: string, depth: number, signal?: AbortSignal): Promise<WebPageContent | null> {
        try {
            const params: RequestUrlParam = {
                url,
                method: 'GET',
                // Obsidian's requestUrl defaults to throwing on 4xx/5xx; opt out so
                // we can attach the real HTTP status to the structured result and
                // tell the model "this URL is not fetchable" instead of dropping
                // the round-trip on the floor.
                throw: false,
                headers: {
                    "User-Agent": this.options.userAgent || getUserAgent(),
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
            };

            const response = await withAbort(signal, () => requestUrl(params));

            const httpStatus = response.status;
            const baseResult = {
                url,
                depth,
                timestamp: new Date().toISOString(),
                httpStatus,
            } as const;

            // HTTP-level failure: bail with a structured marker. We
            // intentionally do NOT try to parse the body — error pages
            // are usually short error blurbs that would confuse the model
            // into "great, I got content".
            if (httpStatus < 200 || httpStatus >= 300) {
                return {
                    ...baseResult,
                    title: `HTTP ${httpStatus}`,
                    contents: [],
                    links: [],
                    extractionStatus: 'http_error',
                    totalTextLength: 0,
                };
            }

            const html = response.text;
            const $ = cheerioLoad(html);
            const title = $("title").text().trim() || $("h1").first().text().trim() || "No Title";

            // Structured-region extraction is the primary path. When it
            // returns nothing we fall back to body text (covers pages
            // that don't expose recognisable region selectors but still
            // have readable content in nested wrappers).
            let contents = this.extractContent($);
            let totalTextLength = sumBlockText(contents);

            if (totalTextLength === 0) {
                const fallback = this.extractBodyTextFallback($);
                if (fallback) {
                    contents = [fallback];
                    totalTextLength = sumBlockText(contents);
                }
            }

            const links = this.extractLinks($, url);

            // Anti-bot challenge detection: short body + a known
            // challenge marker. We check this AFTER extraction so the
            // marker phrase has a chance to land in `contents`.
            if (totalTextLength < EMPTY_PAGE_THRESHOLD * 4 && looksLikeAntiBotPage($)) {
                return {
                    ...baseResult,
                    title,
                    contents: [],
                    links,
                    extractionStatus: 'anti_bot_challenge',
                    totalTextLength: 0,
                };
            }

            // Empty / under-threshold extraction → mark as empty so the
            // toolcall layer can convert it to a failure result. We still
            // return whatever links we could parse, in case the caller
            // can use them for a deeper crawl.
            if (totalTextLength < EMPTY_PAGE_THRESHOLD) {
                return {
                    ...baseResult,
                    title,
                    contents,
                    links,
                    extractionStatus: 'empty',
                    totalTextLength,
                };
            }

            return {
                ...baseResult,
                title,
                contents,
                links,
                extractionStatus: 'ok',
                totalTextLength,
            };
        } catch (error) {
            // Preserve the original `DOMException` identity for aborts —
            // wrapping it into a plain `Error` would strip the `name`
            // discriminator that `crawlRecursive` (and every higher
            // layer up to the tool-exec catch) uses to distinguish
            // user-initiated cancellation from a real network failure.
            // Without this re-throw, an abort during web_fetch_url would
            // be logged as a normal "Request failed" and silently turned
            // into an empty result set instead of unwinding the turn.
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            throw new Error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Last-ditch fallback when the structured-region path returns nothing.
     * Collapses the body's whitespace into paragraphs separated by blank
     * lines. Deliberately permissive (no per-block length filtering) —
     * we'd rather hand the model a noisy "OK-ish" result than say "the
     * page is empty" when it isn't.
     */
    private extractBodyTextFallback($: CheerioAPI): ContentElement | null {
        const $body = $('body');
        if ($body.length === 0) return null;
        // Strip JS/CSS/nav noise inline rather than mutating shared state.
        $body.find('script, style, noscript, nav, header, footer, aside').remove();
        const raw = $body.text();
        if (!raw) return null;
        // Normalize whitespace: collapse runs of spaces, but keep
        // paragraph breaks so the output isn't a 5KB single line.
        const lines = raw
            .split(/\n+/)
            .map(line => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
            .filter(line => line.length > 0);
        if (lines.length === 0) return null;
        return {
            name: 'body-fallback',
            selector: 'body',
            blocks: lines.map(text => ({ type: 'text', text })),
        };
    }

    /**
     * Extract structured content from page
     */
    private extractContent($: CheerioAPI) {
        // Remove unnecessary elements
        $("script, style, noscript").remove();

        // Define regions to extract
        const regionSelectors: { name: string; selector: string; priority: number }[] = [
            { name: 'article', selector: 'article', priority: 1 },
            { name: 'main', selector: 'main', priority: 2 },
            { name: 'content', selector: '.content, .post-content, .article-content, .entry-content, #content, #main', priority: 3 },
            { name: 'sidebar', selector: 'aside, .sidebar, .widget', priority: 4 },
            { name: 'header', selector: 'header', priority: 5 },
            { name: 'footer', selector: 'footer', priority: 6 },
        ];

        const regions: ContentElement[] = [];
        const processedElements = new Set<Element>();

        // Extract regions by priority
        for (const { name, selector } of regionSelectors) {
            const $region = $(selector).first();
            if ($region.length === 0) continue;

            // Check if already processed (avoid duplicate extraction for nested regions)
            const regionElement = $region.get(0) as Element | undefined;
            if (regionElement && processedElements.has(regionElement)) continue;

            const blocks = this.extractBlocks($, $region, processedElements);
            if (blocks.length > 0) {
                regions.push({
                    name,
                    selector,
                    blocks,
                });
            }
        }

        // If no regions found, extract from body
        if (regions.length === 0) {
            const blocks = this.extractBlocks($, $('body'), processedElements);
            if (blocks.length > 0) {
                regions.push({
                    name: 'body',
                    selector: 'body',
                    blocks,
                });
            }
        }

        return regions;
    }

    /**
     * Extract content blocks from a region
     */
    private extractBlocks(
        $: CheerioAPI,
        $container: Cheerio<AnyNode>,
        processedElements: Set<Element>
    ): ContentBlock[] {
        const blocks: ContentBlock[] = [];

        // Iterate over all direct child elements and nested elements
        $container.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, code, div, span').each((_, el) => {
            // Mark as processed
            processedElements.add(el);

            const $el = $(el);
            const tagName = $el.prop('tagName')?.toLowerCase() || '';

            // Extract content based on tag type
            const block = this.createBlock($, $el, tagName);
            if (block) {
                blocks.push(block);
            }
        });

        // Deduplicate and clean up
        return this.deduplicateBlocks(blocks);
    }

    /**
     * Create a content block
     */
    private createBlock(_$: CheerioAPI, $el: Cheerio<AnyNode>, tagName: string): ContentBlock | null {
        const text = $el.text().trim();

        // Ignore empty or too short content
        if (!text || text.length < 5) return null;

        // Handle headings
        if (/^h[1-6]$/.test(tagName)) {
            const level = parseInt(tagName.charAt(1));
            return { type: 'heading', level, text };
        }

        // Handle paragraphs
        if (tagName === 'p') {
            return { type: 'paragraph', text };
        }

        // Handle list items
        if (tagName === 'li') {
            return { type: 'list', text };
        }

        // Handle blockquotes
        if (tagName === 'blockquote') {
            return { type: 'blockquote', text };
        }

        // Handle code
        if (tagName === 'pre' || tagName === 'code') {
            return { type: 'code', text };
        }

        // Handle div/span (need to check if there's enough direct text)
        if (tagName === 'div' || tagName === 'span') {
            // Get direct text nodes
            const directText = $el.contents()
                .filter((_, node) => isTextNode(node))
                .text()
                .trim();

            // Only treat as text block when direct text is long enough
            if (directText.length >= 20) {
                return { type: 'text', text: directText };
            }
        }

        return null;
    }

    /**
     * Deduplicate and clean up content blocks
     */
    private deduplicateBlocks(blocks: ContentBlock[]): ContentBlock[] {
        const seen = new Set<string>();
        const result: ContentBlock[] = [];

        for (const block of blocks) {
            // Use text content hash as deduplication key
            const key = `${block.type}:${block.text}`;

            if (!seen.has(key)) {
                seen.add(key);
                result.push(block);
            }
        }

        return result;
    }

    /**
     * Extract links from page
     */
    private extractLinks($: CheerioAPI, baseUrl: string): string[] {
        const links: string[] = [];
        const seen = new Set<string>();

        $("a[href]").each((_, el) => {
            let href = $(el).attr("href");
            if (!href) return;

            try {
                // Handle relative URLs
                const absoluteUrl = new URL(href, baseUrl).href;
                const normalized = this.normalizeUrl(absoluteUrl);

                // Deduplicate
                if (!seen.has(normalized)) {
                    seen.add(normalized);
                    links.push(normalized);
                }
            } catch {
                // Ignore invalid URLs
            }
        });

        return links;
    }

    /**
     * Check if URL is a root URL (without path component)
     * Example: https://www.example.com/ or https://www.example.com
     */
    private isRootUrl(url: string): boolean {
        try {
            const urlObj = new URL(url);
            const path = urlObj.pathname;
            // Root URL has path as '/' or empty
            return path === '/' || path === '';
        } catch {
            return false;
        }
    }

    /**
     * Check if link is valid (should be crawled)
     */
    private isValidLink(url: string): boolean {
        // Check if already visited
        if (this.visitedUrls.has(url)) {
            return false;
        }

        // Filter out root URLs (links without path component)
        if (this.isRootUrl(url)) {
            return false;
        }

        // Check exclusion patterns
        if (this.shouldExclude(url)) {
            return false;
        }

        // Check if same domain
        if (this.options.sameDomain) {
            try {
                const urlObj = new URL(url);
                if (urlObj.hostname !== this.baseDomain) {
                    return false;
                }
            } catch {
                return false;
            }
        }

        // Check if valid web page URL
        try {
            const urlObj = new URL(url);
            // Only allow http and https
            if (!["http:", "https:"].includes(urlObj.protocol)) {
                return false;
            }
            // Exclude common non-webpage resources
            const ext = urlObj.pathname.split(".").pop()?.toLowerCase();
            const excludedExtensions = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rar", "jpg", "jpeg", "png", "gif", "svg", "mp3", "mp4", "avi", "mov"];
            if (ext && excludedExtensions.includes(ext)) {
                return false;
            }
        } catch {
            return false;
        }

        return true;
    }

    /**
     * Check if URL should be excluded
     */
    private shouldExclude(url: string): boolean {
        for (const pattern of this.options.excludePatterns!) {
            try {
                const regex = new RegExp(pattern, "i");
                if (regex.test(url)) {
                    return true;
                }
            } catch {
                // Ignore invalid regex patterns
            }
        }
        return false;
    }

    /**
     * Normalize URL. Thin instance wrapper around the module-level
     * {@link normalizeUrl} so the toolcall layer and the crawler share
     * one implementation; keeps the existing call sites unchanged.
     */
    private normalizeUrl(url: string): string {
        return normalizeUrl(url);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers used by fetchAndParse
// ─────────────────────────────────────────────────────────────────────────────

function sumBlockText(regions: ContentElement[]): number {
    let total = 0;
    for (const region of regions) {
        for (const block of region.blocks) {
            total += block.text.length;
        }
    }
    return total;
}

function looksLikeAntiBotPage($: CheerioAPI): boolean {
    // Sample the visible body text once and search for any known
    // signature. Lower-cased + whitespace-collapsed to keep matches
    // robust against minor layout/casing variants.
    const sample = $('body').text().replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 2000);
    if (!sample) return false;
    return ANTI_BOT_SIGNATURES.some(sig => sample.includes(sig));
}
