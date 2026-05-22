import { arrayBufferToBase64, requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

/**
 * Wrap an async operation with cooperative abort support.
 *
 * Semantics:
 *  - If `signal` is already aborted, `fn()` is NOT invoked and we throw
 *    `AbortError` immediately.
 *  - Otherwise we kick off `fn()` and race it against the signal. The
 *    instant the signal fires we reject with `AbortError`, regardless of
 *    whether `fn()` has resolved. The caller stops waiting immediately.
 *  - The underlying `fn()` promise keeps running in the background when
 *    abort wins the race (uncancellable operations like Obsidian's
 *    `requestUrl` have no native cancellation mechanism). Its eventual
 *    result is silently discarded so it cannot pollute downstream state.
 *
 * Why race instead of "wait then check": for uncancellable operations
 * the wait-then-check pattern delays the user-perceived abort by the
 * full duration of the in-flight request / sleep. Racing collapses that
 * to one event-loop tick.
 */
export async function withAbort<T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
): Promise<T> {
    if (!signal) return fn();
    if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }

    const fnPromise = fn();
    // If abort wins the race below, `fn()` keeps running and may settle
    // later. Attach an early no-op handler so V8 doesn't classify a late
    // rejection as unhandled. `Promise.race` also attaches a handler, but
    // this is cheap insurance against engine differences and against
    // callers replacing the race with `.then` later.
    fnPromise.catch(() => { /* swallowed: see race below */ });

    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        signal.addEventListener('abort', onAbort, { once: true });
        // Defensive: if the signal aborted between the pre-check above
        // and this listener being attached (e.g. `fn()` synchronously
        // triggered abort before returning its promise), the 'abort'
        // event has already fired and `addEventListener` will NOT
        // replay it. Fire the listener manually so we still reject.
        if (signal.aborted) onAbort();
    });

    try {
        return await Promise.race([fnPromise, abortPromise]);
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Check if the given AbortSignal is aborted. If so, throw AbortError.
 * Useful as a lightweight checkpoint inside loops that cannot be wrapped with withAbort.
 */
export function checkAbort(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }
}

/**
 * Issue an Obsidian `requestUrl` with cooperative abort support.
 *
 * NOTE: Obsidian's `requestUrl` has no native cancellation mechanism.
 * When the signal aborts, the caller unwinds immediately with
 * `AbortError`, but the underlying HTTP request still runs to completion
 * in the background — its response is silently discarded by `withAbort`
 * so it can't leak back into the caller's state. For most callers this
 * is acceptable because the wasted work is bounded.
 */
export async function requestUrlWithAbort(
    params: RequestUrlParam,
    signal?: AbortSignal,
): Promise<RequestUrlResponse> {
    return withAbort(signal, () => requestUrl(params));
}

/**
 * Result of {@link downloadAsBase64}.
 */
export interface DownloadAsBase64Result {
    /** Base64-encoded body (no data: prefix). */
    base64: string;
    /** Best-effort Content-Type from the response, or the provided fallback. */
    mimeType: string;
}

/**
 * Download a binary resource over HTTP(S) using Obsidian's `requestUrl`
 * (CORS-friendly, mobile-safe) and return its body as base64.
 *
 * Suitable for non-streaming binary fetches (e.g. image URLs returned by
 * generative APIs). For streaming / SSE / chunked-transfer scenarios use
 * native `fetch` instead — `requestUrl` always buffers the full body.
 *
 * Throws on non-2xx status or abort.
 */
export async function downloadAsBase64(
    url: string,
    options?: {
        signal?: AbortSignal;
        headers?: Record<string, string>;
        /** MIME type used when the server does not return Content-Type. */
        fallbackMimeType?: string;
    },
): Promise<DownloadAsBase64Result> {
    const response = await requestUrlWithAbort(
        {
            url,
            method: "GET",
            headers: options?.headers,
            throw: false,
        },
        options?.signal,
    );

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
    }

    const mimeType =
        response.headers?.["content-type"]
        ?? response.headers?.["Content-Type"]
        ?? options?.fallbackMimeType
        ?? "application/octet-stream";

    return {
        base64: arrayBufferToBase64(response.arrayBuffer),
        // Strip any charset / parameters: keep just the media type.
        mimeType: mimeType.split(";")[0]!.trim(),
    };
}
