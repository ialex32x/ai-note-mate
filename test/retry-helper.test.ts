import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { fetchWithRetry, requestUrlWithRetry, withRetry } from '../src/utils/retry-helper';
import * as resolveFetchModule from '../src/utils/resolve-fetch';

// retry-helper uses window.setTimeout (via backoffDelay) and window.fetch
// (via resolveFetch). In vitest's vmThreads pool there is no DOM, so we
// provide a minimal window shim with the globals the code under test needs.

beforeEach(() => {
    // Provide window shim if not present (vmThreads pool has no DOM)
    if (typeof (globalThis as any).window === 'undefined') {
        (globalThis as any).window = {
            setTimeout: globalThis.setTimeout.bind(globalThis),
            fetch: vi.fn(),
        };
    }

    // Reassign window.fetch to a fresh mock every test.
    // Without this, vi.restoreAllMocks() in afterEach breaks the fetch stub.
    (globalThis as any).window.fetch = vi.fn();

    // Mock resolveFetch to return our controllable mock fetch
    vi.spyOn(resolveFetchModule, 'resolveFetch').mockReturnValue(
        (globalThis as any).window.fetch,
    );

    // Mock setTimeout to execute immediately (prevent real backoff delays)
    vi.spyOn((globalThis as any).window, 'setTimeout').mockImplementation((fn: any) => {
        if (typeof fn === 'function') fn();
        return 0 as any;
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

// Helper to create a mock fetch response
function mockResponse(status: number, body = ''): Response {
    return new Response(body, { status });
}

function fetchCallCount(): number {
    return (globalThis as any).window.fetch.mock?.calls?.length ?? 0;
}

// ── fetchWithRetry ───────────────────────────────────────────────────────

describe('fetchWithRetry', () => {
    it('should return response on first successful attempt', async () => {
        (globalThis as any).window.fetch.mockResolvedValue(mockResponse(200, 'ok'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('ok');
    });

    it('should retry on 429 and succeed on second attempt', async () => {
        (globalThis as any).window.fetch
            .mockResolvedValueOnce(mockResponse(429, 'rate limited'))
            .mockResolvedValueOnce(mockResponse(200, 'ok'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(200);
        expect(fetchCallCount()).toBe(2);
    });

    it('should retry on 503 and succeed on third attempt', async () => {
        (globalThis as any).window.fetch
            .mockResolvedValueOnce(mockResponse(503, 'unavailable'))
            .mockResolvedValueOnce(mockResponse(502, 'bad gateway'))
            .mockResolvedValueOnce(mockResponse(200, 'ok'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(200);
        expect(fetchCallCount()).toBe(3);
    });

    it('should throw after exhausting all retries on 429', async () => {
        (globalThis as any).window.fetch.mockResolvedValue(mockResponse(429, 'too many'));
        await expect(
            fetchWithRetry('https://example.com', undefined, { maxRetries: 3 }),
        ).rejects.toThrow('HTTP 429');
        expect(fetchCallCount()).toBe(4); // 1 initial + 3 retries
    });

    it('should retry on network error (TypeError) and succeed', async () => {
        (globalThis as any).window.fetch
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(mockResponse(200, 'ok'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(200);
        expect(fetchCallCount()).toBe(2);
    });

    it('should NOT retry on 404 and return response as-is', async () => {
        (globalThis as any).window.fetch.mockResolvedValue(mockResponse(404, 'not found'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(404);
        expect(fetchCallCount()).toBe(1);
    });

    it('should NOT retry on 401 and return response as-is', async () => {
        (globalThis as any).window.fetch.mockResolvedValue(mockResponse(401, 'unauthorized'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(401);
        expect(fetchCallCount()).toBe(1);
    });

    it('should NOT retry on 400 and return response as-is', async () => {
        (globalThis as any).window.fetch.mockResolvedValue(mockResponse(400, 'bad request'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(400);
        expect(fetchCallCount()).toBe(1);
    });

    it('should retry on non-retryable Error even from network call (see retry-helper contract)', async () => {
        // retry-helper treats ANY Error from a network call as retryable
        // (mobile fetch polyfills may throw plain Error for network issues).
        // With maxRetries=3, we expect 4 calls (1 initial + 3 retries).
        (globalThis as any).window.fetch.mockRejectedValue(new Error('SyntaxError: unexpected token'));
        await expect(
            fetchWithRetry('https://example.com'),
        ).rejects.toThrow('SyntaxError');
        expect(fetchCallCount()).toBe(4); // 1 initial + 3 retries
    });

    it('should invoke onRetry callback before each retry', async () => {
        const onRetry = vi.fn();
        (globalThis as any).window.fetch
            .mockResolvedValueOnce(mockResponse(429, 'first'))
            .mockResolvedValueOnce(mockResponse(503, 'second'))
            .mockResolvedValueOnce(mockResponse(200, 'ok'));
        await fetchWithRetry('https://example.com', undefined, {
            maxRetries: 2,
            onRetry,
        });
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
        expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 2);
    });

    it('should respect custom maxRetries', async () => {
        (globalThis as any).window.fetch.mockResolvedValue(mockResponse(429, 'rate limit'));
        await expect(
            fetchWithRetry('https://example.com', undefined, { maxRetries: 1 }),
        ).rejects.toThrow('HTTP 429');
        expect(fetchCallCount()).toBe(2); // 1 initial + 1 retry
    });

    it('should handle 408 Request Timeout as retryable', async () => {
        (globalThis as any).window.fetch
            .mockResolvedValueOnce(mockResponse(408, 'timeout'))
            .mockResolvedValueOnce(mockResponse(200, 'ok'));
        const response = await fetchWithRetry('https://example.com');
        expect(response.status).toBe(200);
        expect(fetchCallCount()).toBe(2);
    });
});

// ── withRetry (generic) ──────────────────────────────────────────────────

describe('withRetry', () => {
    it('should return result on first successful call', async () => {
        const result = await withRetry(() => Promise.resolve('success'));
        expect(result).toBe('success');
    });

    it('should retry on TypeError and succeed', async () => {
        let calls = 0;
        const result = await withRetry(async () => {
            calls++;
            if (calls === 1) throw new TypeError('network error');
            return 'success';
        });
        expect(result).toBe('success');
        expect(calls).toBe(2);
    });

    it('should throw after exhausting retries on persistent network error', async () => {
        const fn = vi.fn().mockRejectedValue(new TypeError('network error'));
        await expect(
            withRetry(fn, { maxRetries: 2 }),
        ).rejects.toThrow('network error');
        expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it('should retry on non-network Error when using withRetry (network-only wrapper)', async () => {
        // Per the retry-helper contract, withRetry treats ANY Error as
        // potentially retryable because it's designed for network operations.
        // Non-network Errors will be retried, then the final error propagates.
        const err = new Error('business logic error');
        const fn = vi.fn().mockRejectedValue(err);
        await expect(
            withRetry(fn),
        ).rejects.toThrow('business logic error');
        expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries (default)
    });

    it('should invoke onRetry callback with error and attempt number', async () => {
        const onRetry = vi.fn();
        let calls = 0;
        const result = await withRetry(async () => {
            calls++;
            if (calls <= 2) throw new TypeError('network');
            return 'ok';
        }, { maxRetries: 3, onRetry });
        expect(result).toBe('ok');
        expect(onRetry).toHaveBeenCalledTimes(2);
    });
});

// ── requestUrlWithRetry ──────────────────────────────────────────────────

describe('requestUrlWithRetry', () => {
    it('should return response on successful call', async () => {
        // Uses mocked obsidian.requestUrl which returns status 200
        const response = await requestUrlWithRetry({ url: 'https://example.com' });
        expect(response.status).toBe(200);
    });
});
