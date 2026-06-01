import { describe, it, expect } from "vitest";
import {
    parseSSEFrame,
    processSSEPayload,
    parseAnthropicSSEStream,
} from "../src/services/providers/anthropic-provider";
import type { StreamChunk } from "../src/services/llm-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a ReadableStream<Uint8Array> that emits the given string segments as
 * separate chunks. Lets a single SSE frame be split across `read()` boundaries
 * so the buffer-reassembly path is exercised.
 */
function streamFrom(segments: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i < segments.length) {
                controller.enqueue(encoder.encode(segments[i]!));
                i++;
            } else {
                controller.close();
            }
        },
    });
}

/** Format an Anthropic SSE frame (event + data lines + blank-line terminator). */
function frame(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collect(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<StreamChunk[]> {
    const out: StreamChunk[] = [];
    for await (const chunk of parseAnthropicSSEStream(stream, signal)) {
        out.push(chunk);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseSSEFrame
// ─────────────────────────────────────────────────────────────────────────────

describe("parseSSEFrame", () => {
    it("parses the data line of an event+data frame", () => {
        const payload = parseSSEFrame('event: content_block_delta\ndata: {"type":"content_block_delta","index":0}');
        expect(payload).toEqual({ type: "content_block_delta", index: 0 });
    });

    it("parses a data-only frame", () => {
        const payload = parseSSEFrame('data: {"type":"ping"}');
        expect(payload).toEqual({ type: "ping" });
    });

    it("returns null for an empty data payload (ping keep-alive)", () => {
        expect(parseSSEFrame("data: ")).toBeNull();
    });

    it("returns null for an empty-object data payload", () => {
        expect(parseSSEFrame("data: {}")).toBeNull();
    });

    it("returns null for a frame with no data line", () => {
        expect(parseSSEFrame("event: ping")).toBeNull();
    });

    it("returns null (does not throw) on malformed JSON", () => {
        expect(parseSSEFrame("data: {not json")).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// processSSEPayload
// ─────────────────────────────────────────────────────────────────────────────

describe("processSSEPayload", () => {
    it("maps message_start to a prompt-token usage chunk", () => {
        const chunk = processSSEPayload(
            { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude", usage: { input_tokens: 42, output_tokens: 0 } } },
            0,
        );
        expect(chunk?.usage).toEqual({ promptTokens: 42, completionTokens: 0, totalTokens: 42 });
    });

    it("emits a tool-call delta (id + name) on a tool_use block start", () => {
        const chunk = processSSEPayload(
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "read_file" } },
            0,
        );
        expect(chunk?.toolCallDeltas).toEqual([{ index: 1, id: "tool_1", function: { name: "read_file" } }]);
    });

    it("emits reasoning + signature on a thinking block start", () => {
        const chunk = processSSEPayload(
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "hmm", signature: "sig-1" } },
            0,
        );
        expect(chunk?.reasoningContent).toBe("hmm");
        expect(chunk?.thoughtSignatures).toEqual(["sig-1"]);
    });

    it("does not emit a chunk for a text block start (no content yet)", () => {
        const chunk = processSSEPayload(
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            0,
        );
        expect(chunk).toBeNull();
    });

    it("maps a text_delta to a content chunk", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
            0,
        );
        expect(chunk?.content).toBe("Hello");
    });

    it("maps an input_json_delta to a tool-call arguments delta", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
            0,
        );
        expect(chunk?.toolCallDeltas).toEqual([{ index: 2, function: { arguments: '{"path":' } }]);
    });

    it("maps a thinking_delta to a reasoning chunk", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " more" } },
            0,
        );
        expect(chunk?.reasoningContent).toBe(" more");
    });

    it("maps a signature_delta to a thoughtSignatures chunk", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-final" } },
            0,
        );
        expect(chunk?.thoughtSignatures).toEqual(["sig-final"]);
    });

    it("computes the total from the passed promptTokens on message_delta", () => {
        const chunk = processSSEPayload(
            { type: "message_delta", delta: { type: "message_delta", stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
            42,
        );
        expect(chunk?.finishReason).toBe("end_turn");
        expect(chunk?.usage).toEqual({ promptTokens: 42, completionTokens: 100, totalTokens: 142 });
    });

    it("throws on an SSE error event", () => {
        expect(() =>
            processSSEPayload(
                { type: "error", error: { message: "overloaded_error" } } as never,
                0,
            ),
        ).toThrow(/overloaded_error/);
    });

    it("returns null for unrecognised / no-op events (ping, message_stop, content_block_stop)", () => {
        expect(processSSEPayload({ type: "ping" }, 0)).toBeNull();
        expect(processSSEPayload({ type: "message_stop" }, 0)).toBeNull();
        expect(processSSEPayload({ type: "content_block_stop", index: 0 }, 0)).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAnthropicSSEStream — end-to-end buffer reassembly
// ─────────────────────────────────────────────────────────────────────────────

describe("parseAnthropicSSEStream", () => {
    it("parses a full conversation turn into the expected chunk sequence", async () => {
        const segments = [
            frame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude", usage: { input_tokens: 10, output_tokens: 0 } } }),
            frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
            frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
            frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } }),
            frame("content_block_stop", { type: "content_block_stop", index: 0 }),
            frame("message_delta", { type: "message_delta", delta: { type: "message_delta", stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
            frame("message_stop", { type: "message_stop" }),
        ];

        const chunks = await collect(streamFrom(segments));
        const texts = chunks.map((c) => c.content).filter((c): c is string => c !== null);
        expect(texts.join("")).toBe("Hi there");

        const final = chunks[chunks.length - 1]!;
        expect(final.finishReason).toBe("end_turn");
        // promptTokens captured from message_start must flow into the total.
        expect(final.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    });

    it("reassembles a frame split across read() boundaries", async () => {
        const full = frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "split-safe" } });
        const mid = Math.floor(full.length / 2);
        // Split mid-frame so neither half contains a complete `\n\n` terminator.
        const chunks = await collect(streamFrom([full.slice(0, mid), full.slice(mid)]));
        expect(chunks).toHaveLength(1);
        expect(chunks[0]!.content).toBe("split-safe");
    });

    it("handles multiple frames arriving in a single read()", async () => {
        const combined =
            frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } }) +
            frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } });
        const chunks = await collect(streamFrom([combined]));
        expect(chunks.map((c) => c.content)).toEqual(["a", "b"]);
    });

    it("skips ping / empty frames without emitting chunks", async () => {
        const segments = [
            frame("ping", { type: "ping" }),
            "data: \n\n",
            frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
        ];
        const chunks = await collect(streamFrom(segments));
        expect(chunks.map((c) => c.content)).toEqual(["x"]);
    });

    it("stops early when the abort signal is already aborted", async () => {
        const segments = [
            frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "never" } }),
        ];
        const controller = new AbortController();
        controller.abort();
        const chunks = await collect(streamFrom(segments), controller.signal);
        expect(chunks).toHaveLength(0);
    });

    it("propagates an SSE error event as a thrown error", async () => {
        const segments = [
            frame("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude", usage: { input_tokens: 1, output_tokens: 0 } } }),
            frame("error", { type: "error", error: { message: "overloaded_error" } }),
        ];
        await expect(collect(streamFrom(segments))).rejects.toThrow(/overloaded_error/);
    });
});
