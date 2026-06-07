import { requestUrl, Vault } from 'obsidian';
import { joinPath } from '../../utils/path-helper';
import { sha256 } from 'utils/hash';
import { SearchEngineScheduler } from './search-engine-scheduler';
import { withAbort, checkAbort, isAbortError } from 'utils/abortable-request';
import { getUserAgent } from './types';

type ImageEngineId = 'duckduckgo' | 'google' | 'bing';

export class ImageWebSearcher {
    private _scheduler = new SearchEngineScheduler<ImageEngineId>();

    constructor() {
        this._scheduler.register({
            id: 'duckduckgo',
            name: 'DuckDuckGo',
            search: (q, _l, signal) => this._searchDuckDuckGo(q, signal),
        });
        this._scheduler.register({
            id: 'google',
            name: 'Google',
            search: (q, _l, signal) => this._searchGoogle(q, signal),
        });
        this._scheduler.register({
            id: 'bing',
            name: 'Bing',
            search: (q, _l, signal) => this._searchBing(q, signal),
        });
    }

    private _getHeaders(): Record<string, string> {
        return { "User-Agent": getUserAgent() };
    }

    // ── DuckDuckGo ──────────────────────────────────────────────────────────

    private async _getVqd(query: string, signal?: AbortSignal): Promise<string | null> {
        try {
            const headers: Record<string, string> = {
                ...this._getHeaders(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "DNT": "1",
                "Connection": "keep-alive",
                "Upgrade-Insecure-Requests": "1",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Cache-Control": "max-age=0"
            };

            await withAbort(signal, () => new Promise(resolve => window.setTimeout(resolve, 1000 + Math.random() * 2000)));

            const resp = await withAbort(signal, () => requestUrl({
                url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
                method: 'GET',
                headers,
            }));
            const vqdMatch = /vqd=([\d-]+)/.exec(resp.text);
            if (vqdMatch) {
                return vqdMatch[1]!;
            }
        } catch (e) {
            // Never swallow user-initiated aborts. Letting AbortError fall
            // through to the `return null` path would force the engine
            // loop in `search()` to spend another full iteration (next
            // engine + its own request) before its top-of-loop
            // `checkAbort` notices the cancellation.
            if (isAbortError(e)) throw e;
            console.error(`Error getting VQD: ${String(e)}`);
        }
        return null;
    }

    private async _searchDuckDuckGo(query: string, signal?: AbortSignal): Promise<string[]> {
        const imageUrls: string[] = [];
        const vqd = await this._getVqd(query, signal);
        if (!vqd) {
            return [];
        }

        const headers: Record<string, string> = {
            ...this._getHeaders(),
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
            "X-Requested-With": "XMLHttpRequest"
        };

        const params = new URLSearchParams({
            "l": "us-en",
            "o": "json",
            "q": query,
            "vqd": vqd,
            "f": ",,,",
            "p": "1",
        });

        await withAbort(signal, () => new Promise(resolve => window.setTimeout(resolve, 500 + Math.random() * 1000)));

        const resp = await withAbort(signal, () => requestUrl({
            url: `https://duckduckgo.com/i.js?${params.toString()}`,
            method: 'GET',
            headers,
        }));

        const data = JSON.parse(resp.text) as { results?: { image?: string }[] };
        if (data && data.results) {
            for (const item of data.results) {
                if (item.image) {
                    imageUrls.push(item.image);
                }
            }
        }
        return imageUrls;
    }

    // ── Google ──────────────────────────────────────────────────────────────

    private async _searchGoogle(query: string, signal?: AbortSignal): Promise<string[]> {
        const imageUrls: string[] = [];
        const headers = this._getHeaders();
        const resp = await withAbort(signal, () => requestUrl({
            url: `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&ie=UTF-8`,
            method: 'GET',
            headers,
        }));

        const content = resp.text;
        const regex = /(https?:\/\/[^"]+?\.(?:jpg|jpeg|png))/g;
        let match;

        while ((match = regex.exec(content)) !== null) {
            let url = match[1]!;
            try {
                url = JSON.parse(`"${url}"`) as string;
            } catch {
                // Ignore decoding errors, use raw url
            }

            if (
                !imageUrls.includes(url) &&
                !url.includes("google") &&
                !url.includes("gstatic")
            ) {
                imageUrls.push(url);
            }
        }
        return imageUrls;
    }

    // ── Bing ───────────────────────────────────────────────────────────────

    private async _searchBing(query: string, signal?: AbortSignal): Promise<string[]> {
        const imageUrls: string[] = [];
        const headers: Record<string, string> = {
            ...this._getHeaders(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
            "Referer": "https://www.bing.com/",
        };

        const resp = await withAbort(signal, () => requestUrl({
            url: `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&count=30&qft=+filterui:photo-photo`,
            method: 'GET',
            headers,
        }));

        const html = resp.text;

        // Bing stores image data in class="iusc" elements with an m attribute:
        //   m="{&quot;murl&quot;:&quot;https://...&quot;,&quot;purl&quot;:&quot;https://...&quot;}"
        // The m attribute value is HTML-entity-encoded JSON.
        const iuscRegex = /class="iusc"[^>]*m="([^"]*)"/g;
        let match;
        while ((match = iuscRegex.exec(html)) !== null) {
            // Decode HTML entities: &quot; → " , &amp; → & , etc.
            const decoded = match[1]!
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>');

            // Extract murl (full-size image URL) from the decoded JSON string
            const murlMatch = /"murl"\s*:\s*"([^"]*)"/.exec(decoded);
            if (murlMatch) {
                const url = murlMatch[1]!;
                if (!imageUrls.includes(url)) {
                    imageUrls.push(url);
                }
            }
        }

        return imageUrls;
    }

    // ── Download ────────────────────────────────────────────────────────────

    async download(url: string, vault: Vault, saveDir: string, signal?: AbortSignal): Promise<string | null> {
        const headers = this._getHeaders();
        const response = await withAbort(signal, () => requestUrl({
            url,
            method: 'GET',
            headers,
        }));

        const contentType = (response.headers['content-type'] || "").toLowerCase();
        if (!contentType.includes("image")) {
            return null;
        }

        let ext = "jpg";
        if (contentType.includes("png") || url.toLowerCase().includes(".png")) {
            ext = "png";
        } else if (contentType.includes("jpeg")) {
            ext = "jpg";
        }

        const hash = await sha256(url);
        const filename = `DL_${hash.slice(0, 16)}_SHA256.${ext}`;
        const filepath = joinPath(saveDir, filename);

        // console.log(`Downloading image from ${url} to ${filepath}`);
        await vault.createBinary(filepath, response.arrayBuffer);
        return filepath;
    }

    // ── Search (scheduler-driven) ───────────────────────────────────────────

    async search(query: string, signal?: AbortSignal): Promise<string[]> {
        // console.log(`[WebImageSearch] Starting search for: '${query}'`);

        let results: string[] = [];
        const engines = this._scheduler.getSorted();

        for (const engine of engines) {
            checkAbort(signal);
            console.debug(`Trying ${engine.name} (priority=${this._scheduler.getPriority(engine.id)})`);
            try {
                const engineResults = await engine.search(query, 0, signal) as string[];
                this._scheduler.markSuccess(engine.id);

                if (engineResults.length > 0) {
                    results = engineResults;
                    console.debug(`Using ${engine.name} — got ${results.length} results`);
                    break;
                } else {
                    console.debug(`${engine.name} returned 0 results, trying next engine`);
                }
            } catch (err) {
                if (isAbortError(err)) throw err;
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
