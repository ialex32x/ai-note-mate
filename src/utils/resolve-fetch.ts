/**
 * Resolve the default fetch implementation.
 *
 * Kept as a function wrapper so that alternative fetch implementations
 * (e.g. proxy middleware, caching layer) can be plugged in later.
 */
export function resolveFetch(): typeof fetch {
    return window.fetch.bind(window);
}
