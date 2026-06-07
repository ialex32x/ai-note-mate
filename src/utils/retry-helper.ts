import { type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { isAbortError, requestUrlWithAbort } from "./abortable-request";
import { resolveFetch } from "./resolve-fetch";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface RetryOptions {
    /** Maximum number of retries (default: 3). */
    maxRetries?: number;
    /**
     * Optional callback invoked before each retry attempt.
     * Receives the error and the attempt number (1-based).
     * Use for logging.
     */
    onRetry?: (error: unknown, attempt: number) => void;
}

const DEFAULT_MAX_RETRIES = 3;

// ─────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────

/**
 * HTTP status codes that warrant an automatic retry.
 *
 * - 429: Rate-limit — the server is asking us to back off.
 * - 5xx: Server-side transient errors (502 Bad Gateway, 503 Service
 *   Unavailable, 504 Gateway Timeout, etc.).
 * - 408: Request Timeout — the server didn't receive the full request in
 *   time; safe to retry with an idempotent POST (LLM chat completions are
 *   effectively idempotent from the retry perspective).
 */
function isRetryableHttpStatus(status: number): boolean {
    return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

/**
 * Classify whether an error thrown during a network call is worth retrying.
 *
 * Retryable:
 *  - Network-level failures (TypeError from fetch, e.g. DNS, connection
 *    refused, timeout, "Failed to fetch").
 *  - HTTP 429 / 5xx / 408 responses.
 *
 * Not retryable:
 *  - AbortError (user-requested cancellation).
 *  - HTTP 4xx except 408/429 (authentication, bad request, not found,
 *    permission denied — retrying won't change the outcome).
 */
function isRetryableError(err: unknown, httpStatus?: number): boolean {
    // Never retry user-requested cancellation.
    if (isAbortError(err)) return false;

    // Explicit HTTP status: retry only 429 / 5xx / 408.
    if (httpStatus !== undefined) {
        return isRetryableHttpStatus(httpStatus);
    }

    // Network-level failures (TypeError from fetch for connection issues,
    // DNS failures, etc.). Also retry generic Error from fetch polyfills
    // on mobile.
    if (err instanceof TypeError) return true;
    if (err instanceof Error && !httpStatus) return true;

    return false;
}

// ─────────────────────────────────────────────
// Delay helper
// ─────────────────────────────────────────────

/**
 * Simple promise-based delay with exponential backoff.
 * Wait times: attempt 1 → 1s, 2 → 2s, 3 → 4s.
 */
function backoffDelay(attempt: number): Promise<void> {
    const ms = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────
// fetchWithRetry
// ─────────────────────────────────────────────

/**
 * Wrap `fetch` with automatic retry for transient failures.
 *
 * Retryable conditions:
 *  - Network errors (TypeError — DNS, connection refused, timeout).
 *  - HTTP 429 (rate-limit).
 *  - HTTP 5xx (server errors).
 *  - HTTP 408 (request timeout).
 *
 * Non-retryable (propagated immediately):
 *  - AbortError (user cancelled).
 *  - HTTP 4xx except 408/429 (auth, bad request, etc.).
 *
 * When a response comes back with a retryable HTTP status, the body is
 * consumed (for logging) and a fresh request is made.
 *
 * @param input   - URL or Request object.
 * @param init    - Fetch init options.
 * @param options - Retry configuration.
 */
export async function fetchWithRetry(
    input: RequestInfo,
    init?: RequestInit,
    options?: RetryOptions,
): Promise<Response> {
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const response = await resolveFetch()(input, init);

            // If the response is OK, return it immediately.
            if (response.ok) return response;

            // Non-OK response: classify the status.
            if (isRetryableHttpStatus(response.status)) {
                // Consume the body so the connection can be reused.
                const errorBody = await response.text().catch(() => "");
                const err = new Error(
                    `HTTP ${response.status}${errorBody ? `: ${errorBody.slice(0, 500)}` : ""}`,
                );
                lastError = err;

                if (attempt <= maxRetries) {
                    options?.onRetry?.(err, attempt);
                    await backoffDelay(attempt);
                    continue;
                }
                throw err;
            }

            // Non-retryable HTTP status (4xx except 408/429): return the
            // response as-is so the caller can inspect status and body.
            return response;
        } catch (err) {
            // If it's an HTTP retryable error that we threw above, it's
            // already been handled. For other errors (network failures),
            // classify and retry if appropriate.
            if (!isRetryableError(err)) throw err;

            lastError = err;

            if (attempt <= maxRetries) {
                options?.onRetry?.(err, attempt);
                await backoffDelay(attempt);
                continue;
            }
            throw err;
        }
    }

    // Should never reach here, but satisfy TypeScript.
    throw lastError;
}

// ─────────────────────────────────────────────
// requestUrlWithRetry
// ─────────────────────────────────────────────

/**
 * Wrap Obsidian's `requestUrl` (via `requestUrlWithAbort`) with automatic
 * retry for transient network failures.
 *
 * Retryable:
 *  - Network errors thrown by `requestUrl` or `requestUrlWithAbort`.
 *  - HTTP 429 / 5xx / 408 responses.
 *
 * Non-retryable:
 *  - AbortError (user cancelled).
 *  - HTTP 4xx except 408/429.
 *
 * @param params  - Request URL parameters.
 * @param signal  - Optional AbortSignal.
 * @param options - Retry configuration.
 */
export async function requestUrlWithRetry(
    params: RequestUrlParam,
    signal?: AbortSignal,
    options?: RetryOptions,
): Promise<RequestUrlResponse> {
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            const response = await requestUrlWithAbort(params, signal);

            // Check for retryable HTTP statuses and throw so the loop retries.
            if (isRetryableHttpStatus(response.status)) {
                const errorBody =
                    typeof response.json === "object" && response.json !== null
                        ? JSON.stringify(response.json).slice(0, 500)
                        : (response.text ?? "").slice(0, 500);
                const err = new Error(
                    `HTTP ${response.status}${errorBody ? `: ${errorBody}` : ""}`,
                );
                lastError = err;

                if (attempt <= maxRetries) {
                    options?.onRetry?.(err, attempt);
                    await backoffDelay(attempt);
                    continue;
                }
                throw err;
            }

            return response;
        } catch (err) {
            if (!isRetryableError(err)) throw err;

            lastError = err;

            if (attempt <= maxRetries) {
                options?.onRetry?.(err, attempt);
                await backoffDelay(attempt);
                continue;
            }
            throw err;
        }
    }

    throw lastError;
}

// ─────────────────────────────────────────────
// withRetry (generic)
// ─────────────────────────────────────────────

/**
 * Generic retry wrapper for an arbitrary async function.
 *
 * The function `fn` is called and retried on transient errors (network
 * failures). Use this for operations that don't map cleanly to a single
 * HTTP call (e.g. multi-step flows).
 *
 * @param fn      - The async function to wrap.
 * @param options - Retry configuration.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options?: RetryOptions,
): Promise<T> {
    const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isRetryableError(err)) throw err;

            lastError = err;

            if (attempt <= maxRetries) {
                options?.onRetry?.(err, attempt);
                await backoffDelay(attempt);
                continue;
            }
            throw err;
        }
    }

    throw lastError;
}
