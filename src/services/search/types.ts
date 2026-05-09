

/**
 * Search result interface
 */
export interface SearchResult {
    /** Search result title */
    title: string;

    /** Search result URL */
    url: string;

    /** Search result snippet/description */
    snippet: string;

    /** Search engine source (e.g., DuckDuckGo, Google, Bing) */
    source: string;

    /** Extracted description if page has abstract content */
    description?: string;

    /** (Informal) Relevance calculation */
    relevance?: number;

    /** Time when search result was generated */
    timestamp?: string;
}

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
];

export function getUserAgent(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}
