import { type CheerioAPI, type Cheerio, load as cheerioLoad } from "cheerio";
import { requestUrl, RequestUrlParam } from "obsidian";
import type { Element } from "domhandler";
import { getUserAgent } from "./types";
import { withAbort, checkAbort } from "utils/abortable-request";

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
     * Fetch and parse page
     */
    private async fetchAndParse(url: string, depth: number, signal?: AbortSignal): Promise<WebPageContent | null> {
        try {
            const params: RequestUrlParam = {
                url,
                method: 'GET',
                headers: {
                    "User-Agent": this.options.userAgent || getUserAgent(),
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.5",
                },
            };

            const response = await withAbort(signal, () => requestUrl(params));

            const html = response.text;
            const $ = cheerioLoad(html);

            // Extract title
            const title = $("title").text().trim() || $("h1").first().text().trim() || "No Title";

            // Extract structured content
            const contents = this.extractContent($);

            // Extract links
            const links = this.extractLinks($, url);

            return {
                url,
                title,
                contents,
                links,
                depth,
                timestamp: new Date().toISOString(),
            };
        } catch (error) {
            throw new Error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
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
        $container: Cheerio<any>,
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
    private createBlock(_$: CheerioAPI, $el: Cheerio<any>, tagName: string): ContentBlock | null {
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
                .filter((_, node) => node.type === 'text')
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
     * Normalize URL
     */
    private normalizeUrl(url: string): string {
        try {
            const urlObj = new URL(url);
            // Remove hash and certain query parameters
            urlObj.hash = "";
            // Remove common tracking parameters
            const trackingParams = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
            trackingParams.forEach(param => urlObj.searchParams.delete(param));
            return urlObj.href;
        } catch {
            return url;
        }
    }
}
