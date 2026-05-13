import { load as cheerioLoad } from 'cheerio';
import { requestUrl } from 'obsidian';
import { getUserAgent, SearchResult } from './types';
import { SearchEngineScheduler } from './search-engine-scheduler';
import { withAbort, checkAbort } from 'utils/abortable-request';

type SearchEngineId = 'bing' | 'baidu' | 'duckduckgo';

export class EnhancedWebSearcher {
    private _getHeaders(): Record<string, string> {
        return {
            "User-Agent": getUserAgent(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive"
        };
    }

    private _scheduler = new SearchEngineScheduler<SearchEngineId>();

    constructor() {
        this._scheduler.register({
            id: 'bing',
            name: 'Bing',
            search: (q, l, signal) => this._searchBing(q, l, signal),
        });
        this._scheduler.register({
            id: 'baidu',
            name: 'Baidu',
            search: (q, l, signal) => this._searchBaidu(q, l, signal),
        });
        this._scheduler.register({
            id: 'duckduckgo',
            name: 'DuckDuckGo',
            search: (q, l, signal) => this._searchDuckDuckGo(q, l, signal),
        });
    }

    // ── Bing ──────────────────────────────────────────────────────────────────

    private async _searchBing(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        try {
            const headers = this._getHeaders();
            await withAbort(signal, () => new Promise(resolve => window.setTimeout(resolve, 500 + Math.random() * 1000)));

            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}`;
            const resp = await withAbort(signal, () => requestUrl({ url: searchUrl, method: 'GET', headers }));

            const $ = cheerioLoad(resp.text);
            $('li.b_algo').each((_i, elem) => {
                if (results.length >= limit) return;
                const titleElem = $(elem).find('h2 a');
                const snippetElem = $(elem).find('.b_caption p');

                const title = titleElem.text().trim();
                const url = titleElem.attr('href') || '';
                const snippet = snippetElem.text().trim();

                if (title && url) {
                    results.push({ title, url, snippet, source: 'Bing' });
                }
            });

            console.debug(`Bing search returned ${results.length} results`);
        } catch (err) {
            console.warn(`Bing search failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
        return results;
    }

    // ── Baidu ─────────────────────────────────────────────────────────────────

    private async _searchBaidu(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        try {
            const headers = this._getHeaders();
            await withAbort(signal, () => new Promise(resolve => window.setTimeout(resolve, 500 + Math.random() * 1000)));

            const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${limit}`;
            const resp = await withAbort(signal, () => requestUrl({ url: searchUrl, method: 'GET', headers }));

            const $ = cheerioLoad(resp.text);
            $('div.result, div.c-container').each((_i, elem) => {
                if (results.length >= limit) return;
                const titleElem = $(elem).find('h3 a');
                const snippetElem = $(elem).find('div.c-abstract, div.c-span9, span.content-right_8Zs40');

                const title = titleElem.text().trim();
                const url = titleElem.attr('href') || '';
                const snippet = snippetElem.text().trim();

                if (title && url) {
                    results.push({ title, url, snippet, source: 'Baidu' });
                }
            });

            console.debug(`Baidu search returned ${results.length} results`);
        } catch (err) {
            console.warn(`Baidu search failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
        return results;
    }

    // ── DuckDuckGo ────────────────────────────────────────────────────────────

    private async _searchDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
        const results: SearchResult[] = [];
        try {
            const headers = this._getHeaders();
            await withAbort(signal, () => new Promise(resolve => window.setTimeout(resolve, 1000 + Math.random() * 1000)));

            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
            const resp = await withAbort(signal, () => requestUrl({ url: searchUrl, method: 'GET', headers }));

            const $ = cheerioLoad(resp.text);
            $('.result').each((_i, elem) => {
                if (results.length >= limit) return;

                const titleElem = $(elem).find('.result__a');
                const snippetElem = $(elem).find('.result__snippet');

                const title = titleElem.text().trim();
                const url = titleElem.attr('href') || '';
                const snippet = snippetElem.text().trim();

                if (title && url) {
                    results.push({
                        title,
                        url,
                        snippet,
                        source: 'DuckDuckGo'
                    });
                }
            });

            console.debug(`DuckDuckGo search returned ${results.length} results`);
        } catch (err) {
            console.warn(`DuckDuckGo search failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
        return results;
    }

    /**
     * Search web pages and return results
     * @param query Search keywords
     * @param limit Number of results to return
     * @returns Array of search results
     */
    public async search(
        query: string,
        limit: number = 10,
        signal?: AbortSignal,
    ): Promise<SearchResult[]> {
        console.debug(`[EnhancedWebSearch] Starting search for: '${query}' (limit=${limit})`);

        let results: SearchResult[] = [];
        const engines = this._scheduler.getSorted();

        for (const engine of engines) {
            checkAbort(signal);
            console.debug(`Trying ${engine.name} (priority=${this._scheduler.getPriority(engine.id)})`);
            try {
                const engineResults = await engine.search(query, limit, signal) as SearchResult[];
                this._scheduler.markSuccess(engine.id);

                if (engineResults.length > 0) {
                    results = engineResults.slice(0, limit);
                    console.debug(`Using ${engine.name} — got ${results.length} results`);
                    break;
                } else {
                    console.debug(`${engine.name} returned 0 results, trying next engine`);
                }
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                this._scheduler.markFailure(engine.id);
                console.warn(`${engine.name} failed or timed out, trying next engine`);
            }
        }

        if (results.length === 0) {
            throw new Error('Failed to search due to network issues.');
        }
        return results;
    }
}

