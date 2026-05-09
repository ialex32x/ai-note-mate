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
