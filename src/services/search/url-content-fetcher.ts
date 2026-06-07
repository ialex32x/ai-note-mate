import { requestUrl, RequestUrlParam } from "obsidian";
import { getUserAgent } from "./types";
import { withAbort, checkAbort, isAbortError } from "utils/abortable-request";
import { parseDocument, extractTitle, type QueryFn, type QueryHandle } from "./dom-utils";

function isTextNode(node: Node): node is Text {
    return node.nodeType === Node.TEXT_NODE;
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

    /** Structured content (links within blocks are preserved as markdown [text](url)) */
    contents: ContentElement[];

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
 * Fetch options interface
 */
export interface PageFetchOptions {
    /** Request timeout in milliseconds, default is 10000 */
    timeout?: number;
    /** User-Agent */
    userAgent?: string;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: PageFetchOptions = {
    timeout: 10000,
    userAgent: undefined,
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
    private options: PageFetchOptions;

    constructor(options: PageFetchOptions = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Fetch and parse a single page. Returns a single-element array for
     * consistency with the original multi-page API.
     * @param url The URL to fetch
     * @returns Array containing the single page result (or empty on failure)
     */
    async fetch(url: string, signal?: AbortSignal): Promise<WebPageContent[]> {
        // Normalize starting URL
        const normalizedUrl = this.normalizeUrl(url);

        try {
            // Validate URL
            void new URL(normalizedUrl);
        } catch {
            throw new Error(`Invalid URL: ${url}`);
        }

        checkAbort(signal);

        try {
            const result = await this.fetchAndParse(normalizedUrl, signal);
            if (result) {
                return [result];
            }
            return [];
        } catch (error) {
            if (isAbortError(error)) throw error;
            console.error(`[Crawler] Error fetching ${url}:`, error instanceof Error ? error.message : String(error));
            return [];
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
    private async fetchAndParse(url: string, signal?: AbortSignal): Promise<WebPageContent | null> {
        try {
            const params: RequestUrlParam = {
                url,
                method: 'GET',
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
                    extractionStatus: 'http_error',
                    totalTextLength: 0,
                };
            }

            const html = response.text;
            const $ = parseDocument(html);
            const title = extractTitle($);

            // Structured-region extraction is the primary path. When it
            // returns nothing we fall back to body text (covers pages
            // that don't expose recognisable region selectors but still
            // have readable content in nested wrappers).
            let contents = this.extractContent($, url);
            let totalTextLength = sumBlockText(contents);

            if (totalTextLength === 0) {
                const fallback = this.extractBodyTextFallback($);
                if (fallback) {
                    contents = [fallback];
                    totalTextLength = sumBlockText(contents);
                }
            }

            // Anti-bot challenge detection: short body + a known
            // challenge marker. We check this AFTER extraction so the
            // marker phrase has a chance to land in `contents`.
            if (totalTextLength < EMPTY_PAGE_THRESHOLD * 4 && looksLikeAntiBotPage($)) {
                return {
                    ...baseResult,
                    title,
                    contents: [],
                    extractionStatus: 'anti_bot_challenge',
                    totalTextLength: 0,
                };
            }

            // Empty / under-threshold extraction → mark as empty so the
            // toolcall layer can convert it to a failure result.
            if (totalTextLength < EMPTY_PAGE_THRESHOLD) {
                return {
                    ...baseResult,
                    title,
                    contents,
                    extractionStatus: 'empty',
                    totalTextLength,
                };
            }

            return {
                ...baseResult,
                title,
                contents,
                extractionStatus: 'ok',
                totalTextLength,
            };
        } catch (error) {
            // Preserve the original `DOMException` identity for aborts —
            // wrapping it into a plain `Error` would strip the `name`
            // discriminator that higher layers use to distinguish
            // user-initiated cancellation from a real network failure.
            // Without this re-throw, an abort during web_fetch_url would
            // be logged as a normal "Request failed" and silently turned
            // into an empty result set instead of unwinding the turn.
            if (isAbortError(error)) throw error;
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
    private extractBodyTextFallback($: QueryFn): ContentElement | null {
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
    private extractContent($: QueryFn, baseUrl: string) {
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
            const regionElement = $region.get(0);
            if (regionElement && processedElements.has(regionElement)) continue;

            const blocks = this.extractBlocks($, $region, processedElements, baseUrl);
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
            const blocks = this.extractBlocks($, $('body'), processedElements, baseUrl);
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
        $: QueryFn,
        $container: QueryHandle,
        processedElements: Set<Element>,
        baseUrl: string,
    ): ContentBlock[] {
        const blocks: ContentBlock[] = [];

        // Iterate over all direct child elements and nested elements
        $container.find('h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, code, div, span').each((_, el) => {
            // Mark as processed
            processedElements.add(el);

            const $el = $(el);
            const tagName = $el.prop('tagName')?.toLowerCase() || '';

            // Extract content based on tag type
            const block = this.createBlock($, $el, tagName, baseUrl);
            if (block) {
                blocks.push(block);
            }
        });

        // Deduplicate and clean up
        return this.deduplicateBlocks(blocks);
    }

    /**
     * Create a content block. Links within the block are preserved as
     * markdown [text](url) so the model can see them in context.
     */
    private createBlock($: QueryFn, $el: QueryHandle, tagName: string, baseUrl: string): ContentBlock | null {
        // Handle div/span specially — only direct text nodes and direct
        // <a> children (non-recursive) to avoid duplicating content from
        // child blocks that are extracted separately.
        if (tagName === 'div' || tagName === 'span') {
            const directText = this.getDirectTextWithLinks($, $el, baseUrl);
            if (directText.length >= 20) {
                return { type: 'text', text: directText };
            }
            return null;
        }

        const text = this.getTextWithLinks($, $el, baseUrl);

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

        return null;
    }

    /**
     * Extract text from an element, recursively converting <a> children
     * to markdown [text](url) while preserving the rest of the structure.
     * Relative URLs are resolved against `baseUrl`.
     */
    private getTextWithLinks($: QueryFn, $el: QueryHandle, baseUrl: string): string {
        const parts: string[] = [];
        $el.contents().each((_, node) => {
            if (isTextNode(node)) {
                parts.push(node.data || '');
            } else {
                const childTag = node.tagName?.toLowerCase();
                if (childTag === 'a') {
                    const $a = $(node);
                    const href = $a.attr('href') || '';
                    const linkText = $a.text().trim();
                    if (href && linkText) {
                        try {
                            const resolved = new URL(href, baseUrl).href;
                            parts.push(`[${linkText}](${resolved})`);
                        } catch {
                            parts.push(`[${linkText}](${href})`);
                        }
                    } else if (linkText) {
                        parts.push(linkText);
                    }
                } else {
                    // Recurse into other inline elements
                    parts.push(this.getTextWithLinks($, $(node), baseUrl));
                }
            }
        });
        return parts.join('');
    }

    /**
     * Non-recursive variant of {@link getTextWithLinks}: only processes
     * direct text-node and <a> children. Used for div/span wrappers to
     * avoid pulling in text from child blocks that are already extracted
     * separately.
     */
    private getDirectTextWithLinks($: QueryFn, $el: QueryHandle, baseUrl: string): string {
        const parts: string[] = [];
        $el.contents().each((_, node) => {
            if (isTextNode(node)) {
                parts.push(node.data || '');
            } else {
                if (node.tagName?.toLowerCase() === 'a') {
                    const $a = $(node);
                    const href = $a.attr('href') || '';
                    const linkText = $a.text().trim();
                    if (href && linkText) {
                        try {
                            const resolved = new URL(href, baseUrl).href;
                            parts.push(`[${linkText}](${resolved})`);
                        } catch {
                            parts.push(`[${linkText}](${href})`);
                        }
                    } else if (linkText) {
                        parts.push(linkText);
                    }
                }
                // Non-<a> element children are silently skipped (their
                // content will be captured by their own createBlock calls).
            }
        });
        return parts.join('').trim();
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
     * Normalize URL. Thin instance wrapper around the module-level
     * {@link normalizeUrl} so the toolcall layer and the fetcher share
     * one implementation.
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

function looksLikeAntiBotPage($: QueryFn): boolean {
    // Sample the visible body text once and search for any known
    // signature. Lower-cased + whitespace-collapsed to keep matches
    // robust against minor layout/casing variants.
    const sample = $('body').text().replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 2000);
    if (!sample) return false;
    return ANTI_BOT_SIGNATURES.some(sig => sample.includes(sig));
}
