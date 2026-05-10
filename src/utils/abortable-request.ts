import { arrayBufferToBase64, requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";

/**
 * Wrap an uncancellable async operation (e.g. Obsidian's requestUrl) with abort support.
 * The underlying operation runs to completion, but its result is discarded if the
 * signal was aborted during execution.
 */
export async function withAbort<T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
): Promise<T> {
    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }
    const result = await fn();
    if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
    }
    return result;
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
 * NOTE: Obsidian's `requestUrl` has no native cancellation mechanism. The
 * underlying network call will always run to completion; aborting only causes
 * the resolved response to be discarded (AbortError is thrown to the caller).
 * For most callers this is acceptable because the wasted work is bounded.
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
