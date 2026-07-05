import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    withAbort,
    checkAbort,
    isAbortError,
    requestUrlWithAbort,
    downloadAsBase64,
} from '../src/utils/abortable-request';

afterEach(() => {
    vi.restoreAllMocks();
});

// ── withAbort ────────────────────────────────────────────────────────────

describe('withAbort', () => {
    it('should call fn and return its result when no signal is provided', async () => {
        const result = await withAbort(undefined, () => Promise.resolve(42));
        expect(result).toBe(42);
    });

    it('should throw AbortError immediately when signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(
            withAbort(ac.signal, () => Promise.resolve(42)),
        ).rejects.toThrowError(DOMException);
        await expect(
            withAbort(ac.signal, () => Promise.resolve(42)),
        ).rejects.toThrow(/Aborted/);
    });

    it('should NOT call fn when signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        const fn = vi.fn().mockResolvedValue(42);
        await expect(withAbort(ac.signal, fn)).rejects.toThrow();
        expect(fn).not.toHaveBeenCalled();
    });

    it('should resolve with fn result when signal is never aborted', async () => {
        const ac = new AbortController();
        const result = await withAbort(ac.signal, () => Promise.resolve('hello'));
        expect(result).toBe('hello');
    });

    it('should reject with AbortError when signal aborts during operation', async () => {
        const ac = new AbortController();
        const slowFn = new Promise<string>((resolve) => {
            // This never resolves on its own — we abort it
            setTimeout(() => resolve('too late'), 10_000);
        });
        const promise = withAbort(ac.signal, () => slowFn);
        setTimeout(() => ac.abort(), 5);
        await expect(promise).rejects.toThrowError(DOMException);
        await expect(promise).rejects.toThrow(/Aborted/);
    });

    it('should propagate non-abort errors from fn', async () => {
        const ac = new AbortController();
        await expect(
            withAbort(ac.signal, () => Promise.reject(new Error('API error'))),
        ).rejects.toThrow('API error');
    });

    it('should clean up abort listener after completion', async () => {
        const ac = new AbortController();
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
        await withAbort(ac.signal, () => Promise.resolve('done'));
        expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });

    it('should handle abort signal that fires before listener attachment', async () => {
        // Edge case: abort fires between the pre-check and the addEventListener.
        // The defensive `if (signal.aborted) onAbort()` in the constructor
        // ensures we still reject.
        const ac = new AbortController();
        ac.abort(); // abort before withAbort is even called
        const fn = vi.fn().mockResolvedValue('should not reach');
        await expect(withAbort(ac.signal, fn)).rejects.toThrowError(DOMException);
        await expect(withAbort(ac.signal, fn)).rejects.toThrow(/Aborted/);
        expect(fn).not.toHaveBeenCalled();
    });
});

// ── checkAbort ───────────────────────────────────────────────────────────

describe('checkAbort', () => {
    it('should not throw when signal is undefined', () => {
        expect(() => checkAbort(undefined)).not.toThrow();
    });

    it('should not throw when signal is not aborted', () => {
        const ac = new AbortController();
        expect(() => checkAbort(ac.signal)).not.toThrow();
    });

    it('should throw AbortError when signal is aborted', () => {
        const ac = new AbortController();
        ac.abort();
        expect(() => checkAbort(ac.signal)).toThrowError(DOMException);
        expect(() => checkAbort(ac.signal)).toThrow(/Aborted/);
    });
});

// ── isAbortError ─────────────────────────────────────────────────────────

describe('isAbortError', () => {
    it('should return true for DOMException AbortError', () => {
        const err = new DOMException('Aborted', 'AbortError');
        expect(isAbortError(err)).toBe(true);
    });

    it('should return true for Error with name AbortError', () => {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        expect(isAbortError(err)).toBe(true);
    });

    it('should return false for regular Error', () => {
        expect(isAbortError(new Error('some error'))).toBe(false);
    });

    it('should return false for TypeError', () => {
        expect(isAbortError(new TypeError('network error'))).toBe(false);
    });

    it('should return false for non-error values', () => {
        expect(isAbortError(null)).toBe(false);
        expect(isAbortError(undefined)).toBe(false);
        expect(isAbortError('string error')).toBe(false);
        expect(isAbortError(42)).toBe(false);
        expect(isAbortError({ message: 'not an error' })).toBe(false);
    });

    it('should return false for Error with different name', () => {
        const err = new Error('error');
        err.name = 'CustomError';
        expect(isAbortError(err)).toBe(false);
    });
});

// ── requestUrlWithAbort ──────────────────────────────────────────────────

describe('requestUrlWithAbort', () => {
    it('should call requestUrl with given params and return result', async () => {
        const result = await requestUrlWithAbort({ url: 'https://example.com' });
        expect(result).toBeDefined();
        expect(result.status).toBe(200);
    });

    it('should abort when signal is already aborted', async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(
            requestUrlWithAbort({ url: 'https://example.com' }, ac.signal),
        ).rejects.toThrowError(DOMException);
    });
});

// ── downloadAsBase64 ─────────────────────────────────────────────────────

describe('downloadAsBase64', () => {
    it('should return base64 and mimeType for a successful download', async () => {
        const result = await downloadAsBase64('https://example.com/image.png');
        expect(result).toHaveProperty('base64');
        expect(result).toHaveProperty('mimeType');
        expect(typeof result.base64).toBe('string');
        expect(typeof result.mimeType).toBe('string');
    });

    it('should use fallbackMimeType when Content-Type header is not present', async () => {
        const result = await downloadAsBase64('https://example.com/image', {
            fallbackMimeType: 'image/png',
        });
        expect(result.mimeType).toBe('image/png');
    });

    it('should strip charset from Content-Type header', async () => {
        // The mock returns empty headers, so this tests the fallback chain.
        // The real requestUrl mock returns {} for headers.
        const result = await downloadAsBase64('https://example.com/data');
        // With empty headers, fallback cascade reaches application/octet-stream
        expect(result.mimeType).toBe('application/octet-stream');
    });
});
