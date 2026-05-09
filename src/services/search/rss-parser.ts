import { load as cheerioLoad, type CheerioAPI } from 'cheerio';
import { requestUrl, RequestUrlParam } from 'obsidian';
import { getUserAgent } from './types';
import { withAbort } from 'utils/abortable-request';

/**
 * RSS/Atom feed item
 */
export interface FeedItem {
    /** Item title */
    title: string;
    /** Item link/URL */
    link: string;
    /** Item description/summary (may contain HTML) */
    description?: string;
    /** Publication date (ISO 8601 string) */
    pubDate?: string;
    /** Author name */
    author?: string;
    /** GUID (unique identifier) */
    guid?: string;
    /** Enclosures (e.g., podcast audio) */
    enclosures?: FeedEnclosure[];
    /** Categories/tags */
    categories?: string[];
}

/**
 * Feed enclosure (media attachment)
 */
export interface FeedEnclosure {
    url: string;
    type?: string;
    length?: number;
}

/**
 * RSS/Atom feed metadata
 */
export interface FeedInfo {
    /** Feed title */
    title: string;
    /** Feed description */
    description?: string;
    /** Feed website URL */
    link?: string;
    /** Feed language */
    language?: string;
    /** Feed copyright */
    copyright?: string;
    /** Feed last build/update date */
    lastBuildDate?: string;
    /** Feed categories */
    categories?: string[];
}

/**
 * Parsed RSS/Atom feed result
 */
export interface ParsedFeed {
    /** Feed metadata */
    feed: FeedInfo;
    /** Feed items */
    items: FeedItem[];
    /** Feed type: 'rss' or 'atom' */
    type: 'rss' | 'atom';
    /** Feed URL */
    sourceUrl: string;
}

/**
 * RSS Parser options
 */
export interface RSSParserOptions {
    /** Request timeout in milliseconds (default: 15000) */
    timeout?: number;
    /** Maximum number of items to return (default: 50, max: 100) */
    maxItems?: number;
    /** User-Agent header */
    userAgent?: string;
}

const DEFAULT_OPTIONS: Required<RSSParserOptions> = {
    timeout: 15000,
    maxItems: 50,
    userAgent: getUserAgent(),
};

/**
 * Lightweight RSS/Atom parser using cheerio
 */
export class RSSParser {
    private options: Required<RSSParserOptions>;

    constructor(options: RSSParserOptions = {}) {
        this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    /**
     * Parse an RSS/Atom feed from a URL
     * @param url Feed URL
     * @param signal Optional abort signal
     * @returns Parsed feed data
     */
    async parseURL(url: string, signal?: AbortSignal): Promise<ParsedFeed> {
        const params: RequestUrlParam = {
            url,
            method: 'GET',
            headers: {
                'User-Agent': this.options.userAgent,
                'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
                'Accept-Language': 'en-US,en;q=0.5',
            },
        };

        const response = await withAbort(signal, () => requestUrl(params));
        const xml = response.text;

        if (!xml || xml.trim().length === 0) {
            throw new Error('Empty response from feed URL');
        }

        return this.parse(xml, url);
    }

    /**
     * Parse RSS/Atom XML content
     * @param xml XML content
     * @param sourceUrl Original feed URL (for reference)
     * @returns Parsed feed data
     */
    parse(xml: string, sourceUrl: string): ParsedFeed {
        const $ = cheerioLoad(xml, { xmlMode: true });

        // Detect feed type
        const isAtom = $('feed').length > 0;

        if (isAtom) {
            return this.parseAtom($, sourceUrl);
        } else {
            return this.parseRSS($, sourceUrl);
        }
    }

    /**
     * Parse RSS 2.0 format
     */
    private parseRSS($: CheerioAPI, sourceUrl: string): ParsedFeed {
        const channel = $('channel').first();

        // Parse channel info
        const feed: FeedInfo = {
            title: this.getText($, channel, 'title') || 'Untitled Feed',
            description: this.getText($, channel, 'description'),
            link: this.getText($, channel, 'link'),
            language: this.getText($, channel, 'language'),
            copyright: this.getText($, channel, 'copyright'),
            lastBuildDate: this.getText($, channel, 'lastBuildDate'),
            categories: this.getCategories($, channel, 'category'),
        };

        // Parse items
        const items: FeedItem[] = [];
        const maxItems = Math.min(this.options.maxItems, 100);

        $('item').each((_, el) => {
            if (items.length >= maxItems) return false;

            const $item = $(el);
            const item: FeedItem = {
                title: this.getText($, $item, 'title') || 'Untitled',
                link: this.getRSSLink($, $item),
                description: this.getText($, $item, 'description'),
                pubDate: this.getText($, $item, 'pubDate'),
                author: this.getText($, $item, 'author') || this.getText($, $item, 'dc\\:creator'),
                guid: this.getText($, $item, 'guid'),
                categories: this.getCategories($, $item, 'category'),
                enclosures: this.getEnclosures($, $item),
            };

            // Skip items without title and link
            if (item.title || item.link) {
                items.push(item);
            }
            return;
        });

        return { feed, items, type: 'rss', sourceUrl };
    }

    /**
     * Parse Atom format
     */
    private parseAtom($: CheerioAPI, sourceUrl: string): ParsedFeed {
        const feedEl = $('feed').first();

        // Parse feed info
        const feed: FeedInfo = {
            title: this.getText($, feedEl, 'title') || 'Untitled Feed',
            description: this.getText($, feedEl, 'subtitle'),
            link: this.getAtomLink($, feedEl, 'alternate'),
            language: feedEl.attr('xml:lang') || undefined,
            copyright: this.getText($, feedEl, 'rights'),
            lastBuildDate: this.getText($, feedEl, 'updated'),
            categories: this.getCategories($, feedEl, 'category'),
        };

        // Parse entries
        const items: FeedItem[] = [];
        const maxItems = Math.min(this.options.maxItems, 100);

        $('entry').each((_, el) => {
            if (items.length >= maxItems) return false;

            const $entry = $(el);
            const item: FeedItem = {
                title: this.getText($, $entry, 'title') || 'Untitled',
                link: this.getAtomLink($, $entry, 'alternate') || '',
                description: this.getText($, $entry, 'summary') || this.getText($, $entry, 'content'),
                pubDate: this.getText($, $entry, 'published') || this.getText($, $entry, 'updated'),
                author: this.getText($, $entry, 'author name'),
                guid: $entry.attr('id') || this.getText($, $entry, 'id'),
                categories: this.getCategories($, $entry, 'category'),
            };

            // Skip items without title and link
            if (item.title || item.link) {
                items.push(item);
            }
            return;
        });

        return { feed, items, type: 'atom', sourceUrl };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Helper methods
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get text content from an element
     */
    private getText($: CheerioAPI, $el: ReturnType<CheerioAPI>, selector: string): string | undefined {
        const text = $el.find(selector).text().trim();
        return text || undefined;
    }

    /**
     * Get RSS item link (handles multiple link formats)
     */
    private getRSSLink($: CheerioAPI, $item: ReturnType<CheerioAPI>): string {
        // Standard <link> element
        let link = $item.find('link').not('[rel]').first().text().trim();

        // Self-referential link
        if (!link) {
            link = $item.find('link[rel="alternate"]').attr('href') || '';
        }

        // Enclosure URL as fallback
        if (!link) {
            link = $item.find('enclosure').attr('url') || '';
        }

        return link.trim();
    }

    /**
     * Get Atom link by rel attribute
     */
    private getAtomLink($: CheerioAPI, $el: ReturnType<CheerioAPI>, rel: string): string | undefined {
        // Try to find link with matching rel
        let link = $el.find(`link[rel="${rel}"]`).attr('href');

        // Fallback to link without rel (defaults to alternate)
        if (!link) {
            link = $el.find('link').not('[rel]').attr('href');
        }

        // Fallback to first link
        if (!link) {
            link = $el.find('link').first().attr('href');
        }

        return link || undefined;
    }

    /**
     * Get categories from element
     */
    private getCategories($: CheerioAPI, $el: ReturnType<CheerioAPI>, selector: string): string[] | undefined {
        const categories: string[] = [];

        $el.find(selector).each((_, catEl) => {
            // Atom uses 'term' attribute, RSS uses text content
            const term = $(catEl).attr('term') || $(catEl).text().trim();
            if (term) {
                categories.push(term);
            }
            return;
        });

        return categories.length > 0 ? categories : undefined;
    }

    /**
     * Get enclosures from RSS item
     */
    private getEnclosures($: CheerioAPI, $item: ReturnType<CheerioAPI>): FeedEnclosure[] | undefined {
        const enclosures: FeedEnclosure[] = [];

        $item.find('enclosure').each((_, encEl) => {
            const $enc = $(encEl);
            const url = $enc.attr('url');
            if (url) {
                enclosures.push({
                    url,
                    type: $enc.attr('type'),
                    length: $enc.attr('length') ? parseInt($enc.attr('length')!, 10) : undefined,
                });
            }
            return;
        });

        return enclosures.length > 0 ? enclosures : undefined;
    }
}
