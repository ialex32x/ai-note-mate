/**
 * Generic SSE (Server-Sent Events) frame iterator.
 *
 * Reads a `ReadableStream<Uint8Array>` and yields each complete SSE frame
 * (delimited by `\n\n`). Handles line-ending normalisation and trailing-frame
 * flush. The caller is responsible for interpreting the frame content
 * (extracting `data:` lines, parsing JSON, etc.).
 *
 * Used by OpenAI, Gemini, Anthropic, and MCP SSE stream parsers to avoid
 * duplicating the low-level byte-stream → frame loop.
 *
 * @param body   - The response body ReadableStream from `window.fetch`.
 * @param signal - Optional AbortSignal for early cancellation.
 */
export async function* parseSSEFrames(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncIterable<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            if (signal?.aborted) break;

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Normalise line endings to LF (SSE spec allows \r\n and \r).
            buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

            // SSE frames are separated by double newlines
            while (true) {
                const frameEnd = buffer.indexOf("\n\n");
                if (frameEnd === -1) break;

                const frame = buffer.slice(0, frameEnd);
                buffer = buffer.slice(frameEnd + 2);
                yield frame;
            }
        }

        // Flush trailing frame (may lack final \n\n)
        if (buffer.trim()) {
            yield buffer;
        }
    } finally {
        reader.releaseLock();
    }
}
