import { describe, it, expect } from "vitest";
import {
    processSSEPayload,
    parseAnthropicSSEStream,
    parseSSEFrame,
} from "../src/services/providers/anthropic-provider";
import { parseSSEFrames } from "../src/utils/sse-parser";
import type { StreamChunk } from "../src/services/llm-provider";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a ReadableStream from an array of SSE frame strings (each ending with \n\n). */
function sseStream(...frames: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const body = frames.map((f) => encoder.encode(f + "\n\n")).join("");
    // join Uint8Arrays into one
    const parts = frames.map((f) => encoder.encode(f + "\n\n"));
    const totalLen = parts.reduce((s, p) => s + p.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const p of parts) {
        merged.set(p, offset);
        offset += p.length;
    }
    return new ReadableStream({
        start(controller) {
            controller.enqueue(merged);
            controller.close();
        },
    });
}

/** Collect all chunks from an async iterable into an array. */
async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = [];
    for await (const chunk of iter) {
        chunks.push(chunk);
    }
    return chunks;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseSSEFrames
// ─────────────────────────────────────────────────────────────────────────────

describe("parseSSEFrames", () => {
    it("yields one frame per \\n\\n-delimited block", async () => {
        const stream = sseStream(
            "event: message_start\ndata: {\"type\":\"message_start\"}",
            "event: ping\ndata: {}",
        );
        const frames: string[] = [];
        for await (const frame of parseSSEFrames(stream, undefined)) {
            frames.push(frame);
        }
        expect(frames).toHaveLength(2);
        expect(frames[0]).toContain("message_start");
        expect(frames[1]).toContain("ping");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSSEFrame
// ─────────────────────────────────────────────────────────────────────────────

describe("parseSSEFrame", () => {
    it("parses a valid data: JSON line", () => {
        const result = parseSSEFrame('data: {"type":"ping"}');
        expect(result).toEqual({ type: "ping" });
    });

    it("returns null for empty data (ping frames)", () => {
        expect(parseSSEFrame("data: ")).toBeNull();
        expect(parseSSEFrame("data: {}")).toBeNull();
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
            0,
        );
        expect(chunk?.usage).toEqual({ promptTokens: 42, completionTokens: 0, totalTokens: 42, cachedPromptTokens: 0 });
    });

    it("maps message_start with cache_read_input_tokens to include cachedPromptTokens", () => {
        const chunk = processSSEPayload(
            { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude", usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 60 } } },
            100,
            60,
        );
        expect(chunk?.usage).toEqual({ promptTokens: 100, completionTokens: 0, totalTokens: 100, cachedPromptTokens: 60 });
    });

    it("emits a tool-call delta (id + name) on a tool_use block start", () => {
        const chunk = processSSEPayload(
            { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_1", name: "read_file" } },
            0,
            0,
        );
        expect(chunk?.toolCallDeltas).toEqual([{ index: 1, id: "tool_1", function: { name: "read_file" } }]);
    });

    it("emits reasoning + signature on a thinking block start", () => {
        const chunk = processSSEPayload(
            { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "hmm", signature: "sig-1" } },
            0,
            0,
        );
        expect(chunk?.reasoningContent).toBe("hmm");
        expect(chunk?.thoughtSignatures).toEqual(["sig-1"]);
    });

    it("does not emit a chunk for a text block start (no content yet)", () => {
        const chunk = processSSEPayload(
            { type: "content_block_start", index: 0, content_block: { type: "text" } },
            0,
            0,
        );
        expect(chunk).toBeNull();
    });

    it("maps a text_delta to a content chunk", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
            0,
            0,
        );
        expect(chunk?.content).toBe("Hello");
    });

    it("maps an input_json_delta to a tool-call arguments delta", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
            0,
            0,
        );
        expect(chunk?.toolCallDeltas).toEqual([{ index: 2, function: { arguments: '{"path":' } }]);
    });

    it("maps a thinking_delta to a reasoning chunk", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " more" } },
            0,
            0,
        );
        expect(chunk?.reasoningContent).toBe(" more");
    });

    it("maps a signature_delta to a thoughtSignatures chunk", () => {
        const chunk = processSSEPayload(
            { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-final" } },
            0,
            0,
        );
        expect(chunk?.thoughtSignatures).toEqual(["sig-final"]);
    });

    it("computes the total from the passed promptTokens on message_delta", () => {
        const chunk = processSSEPayload(
            { type: "message_delta", delta: { type: "message_delta", stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
            42,
            0,
        );
        expect(chunk?.finishReason).toBe("end_turn");
        expect(chunk?.usage).toEqual({ promptTokens: 42, completionTokens: 100, totalTokens: 142, cachedPromptTokens: 0 });
    });

    it("includes cachedPromptTokens in message_delta usage", () => {
        const chunk = processSSEPayload(
            { type: "message_delta", delta: { type: "message_delta", stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
            10,
            8,
        );
        expect(chunk?.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 8 });
    });

    it("throws on an SSE error event", () => {
        expect(() =>
            processSSEPayload(
                { type: "error", error: { message: "overloaded_error" } } as never,
                0,
                0,
            ),
        ).toThrow(/overloaded_error/);
    });

    it("returns null for unrecognised / no-op events (ping, message_stop, content_block_stop)", () => {
        expect(processSSEPayload({ type: "ping" }, 0, 0)).toBeNull();
        expect(processSSEPayload({ type: "message_stop" }, 0, 0)).toBeNull();
        expect(processSSEPayload({ type: "content_block_stop", index: 0 }, 0, 0)).toBeNull();
    });
});