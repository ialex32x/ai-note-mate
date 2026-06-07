/**
 * Resolve the default fetch implementation, mirroring the approach used by
 * the OpenAI SDK (`getDefaultFetch` in shims.ts).
 *
 * Uses the global `fetch` (without `window.` prefix) so that in Obsidian's
 * Node.js-backed runtime the request goes through undici's native HTTP
 * stack, which is not subject to browser CORS policy.
 * Falls back to `window.fetch` if the global is unavailable.
 */
export function resolveFetch(): typeof fetch {
    // eslint-disable-next-line no-restricted-globals -- global `fetch` is backed by undici in Obsidian's Node.js runtime, which bypasses CORS; `window.fetch` would go through Chromium and hit CORS on proxies/VPNs
    if (typeof fetch !== "undefined") {
        // eslint-disable-next-line no-restricted-globals -- returning the undici-backed global fetch, same approach as OpenAI SDK's getDefaultFetch()
        return fetch as typeof window.fetch;
    }
    if (typeof window !== "undefined" && typeof window.fetch !== "undefined") {
        return window.fetch.bind(window);
    }
    throw new Error(
        "`fetch` is not defined as a global or on `window`; the environment does not support HTTP requests.",
    );
}
