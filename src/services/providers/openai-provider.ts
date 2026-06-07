import type {
    LLMProvider,
    LLMProviderConfig,
    MediaAttachment,
    ModalityCapability,
    ToolDefinition,
    ChatMessageParam,
    StreamChunk,
    ThinkingLevel,
} from "../llm-provider";
import { sanitizeChatMessages } from "./_shared";
import { parseSSEFrames } from "../../utils/sse-parser";
import { corsFreeFetchWithRetry } from "../../utils/retry-helper";

const retryLogger = (ctx: string) =>
    (err: unknown, n: number) => console.warn(`[openai-provider] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Default base URL for the OpenAI API. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// ─────────────────────────────────────────────
// SSE Stream Parser
// ─────────────────────────────────────────────

/**
 * Parse an OpenAI SSE (Server-Sent Events) byte stream into individual
 * JSON objects.
 *
 * OpenAI's streaming chat completions return standard SSE: each event is
 * separated by a blank line, and the payload is on a `data:` line. The
 * stream ends with `data: [DONE]`.
 *
 * @param body   - The response body ReadableStream from `window.fetch`.
 * @param signal - Optional AbortSignal to cancel the stream early.
 */
async function* parseOpenAISSEStream(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
    for await (const frame of parseSSEFrames(body, signal)) {
        // Extract data: payload from the frame
        for (const line of frame.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
                const jsonStr = trimmed.slice(6);
                // [DONE] signals end of stream
                if (jsonStr === "[DONE]") return;
                // Skip empty data (ping frames)
                if (jsonStr === "" || jsonStr === "{}") break;
                try {
                    yield JSON.parse(jsonStr) as Record<string, unknown>;
                } catch {
                    console.warn(
                        "[openai-provider] SSE JSON parse error:",
                        jsonStr.slice(0, 200),
                    );
                }
                break;
            }
        }
    }
}

// ─────────────────────────────────────────────
// OpenAIProvider
// ─────────────────────────────────────────────

/**
 * OpenAI-compatible LLM provider using direct `window.fetch`.
 *
 * Talks directly to the OpenAI REST API without the `openai` npm SDK.
 * Works with any API that implements the OpenAI chat completions format
 * (DeepSeek, OpenRouter, Together AI, etc.).
 */
export class OpenAIProvider implements LLMProvider {
    private readonly apiKey: string;
    private readonly baseURL: string;
    private readonly model: string;
    private readonly modalities: Set<ModalityCapability>;

    constructor(config: LLMProviderConfig) {
        this.model = config.model;
        this.modalities = new Set(config.modalities ?? []);
        this.apiKey = config.apiKey;
        this.baseURL = config.baseURL || DEFAULT_BASE_URL;
    }

    // ── listModels ────────────────────────────────────────────────

    async listModels(): Promise<string[]> {
        const models: string[] = [];

        // OpenAI's /v1/models returns { object: "list", data: [...] }.
        // There is no standard pagination param; we rely on the default page.
        const response = await corsFreeFetchWithRetry(`${this.baseURL}/models`, {
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
            },
        }, { onRetry: retryLogger("listModels") });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(
                `OpenAI listModels failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ""}`,
            );
        }

        const data = (await response.json()) as {
            data?: Array<{ id?: string }>;
        };

        for (const model of data.data ?? []) {
            if (model.id) {
                models.push(model.id);
            }
        }

        return models.sort((a, b) => a.localeCompare(b));
    }

    // ── createStream ───────────────────────────────────────────────

    async *createStream(
        messages: ChatMessageParam[],
        tools?: ToolDefinition[],
        signal?: AbortSignal,
        thinkingLevel?: ThinkingLevel,
    ): AsyncIterable<StreamChunk> {
        const sanitized = sanitizeChatMessages(messages, "openai-provider");

        // Convert our messages to OpenAI format
        const openaiMessages = sanitized.map((m): Record<string, unknown> => {
            if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
                const msg: Record<string, unknown> = {
                    role: "assistant",
                    content: m.content || null,
                    tool_calls: m.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: "function",
                        function: { name: tc.function.name, arguments: tc.function.arguments },
                    })),
                };
                if (m.thinkingContent) {
                    msg.reasoning_content = m.thinkingContent;
                }
                return msg;
            }
            if (m.role === "tool_result") {
                return {
                    role: "tool",
                    tool_call_id: m.toolCallId ?? "",
                    content: m.content,
                };
            }
            // User messages with multimodal attachments → multimodal content array
            if (m.media && m.media.length > 0 && m.role === "user") {
                const parts: Array<Record<string, unknown>> = [
                    { type: "text", text: m.content },
                ];
                const skipped: string[] = [];
                for (const att of m.media) {
                    const part = this.buildOpenAIMediaPart(att, skipped);
                    if (part) parts.push(part as unknown as Record<string, unknown>);
                }
                if (skipped.length > 0) {
                    parts[0] = {
                        type: "text",
                        text: `${m.content}\n\n[Attachments omitted: ${skipped.join("; ")}]`,
                    };
                }
                return { role: "user", content: parts };
            }
            if (m.role === "assistant") {
                const msg: Record<string, unknown> = {
                    role: "assistant",
                    content: m.content,
                };
                if (m.thinkingContent) {
                    msg.reasoning_content = m.thinkingContent;
                }
                return msg;
            }
            return { role: m.role, content: m.content };
        });

        // Convert tools to OpenAI format
        const openaiTools: Record<string, unknown>[] | undefined =
            tools && tools.length > 0
                ? tools.map((t) => ({
                      type: "function",
                      function: {
                          name: t.function.name,
                          description: t.function.description,
                          parameters: t.function.parameters,
                      },
                  }))
                : undefined;

        // reasoning_effort for o-series / GPT-5
        const isExplicitTier =
            thinkingLevel === "low" ||
            thinkingLevel === "medium" ||
            thinkingLevel === "high";

        // Build request body
        const body: Record<string, unknown> = {
            model: this.model,
            messages: openaiMessages,
            stream: true,
            stream_options: { include_usage: true },
        };
        if (openaiTools) body.tools = openaiTools;
        if (isExplicitTier) body.reasoning_effort = thinkingLevel;

        // Fire streaming request
        const response = await corsFreeFetchWithRetry(`${this.baseURL}/chat/completions`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
        }, { onRetry: retryLogger("createStream") });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(
                `OpenAI API error ${response.status}: ${errorBody || response.statusText}`,
            );
        }

        if (!response.body) {
            throw new Error("OpenAI returned no response body");
        }

        // Parse SSE stream and convert to StreamChunk
        for await (const chunk of parseOpenAISSEStream(response.body, signal)) {
            const choice = (chunk.choices as Array<Record<string, unknown>>)?.[0] as
                | Record<string, unknown>
                | undefined;
            const delta = choice?.delta as Record<string, unknown> | undefined;
            const finishReason = (choice?.finish_reason as string) ?? null;
            const usageRaw = chunk.usage as
                | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
                | undefined;
            const usage = usageRaw
                ? {
                      promptTokens: usageRaw.prompt_tokens ?? 0,
                      completionTokens: usageRaw.completion_tokens ?? 0,
                      totalTokens: usageRaw.total_tokens ?? 0,
                  }
                : null;

            // Tool call deltas (streamed incrementally)
            const rawToolCalls = delta?.tool_calls as
                | Array<{
                      index?: number;
                      id?: string;
                      function?: { name?: string; arguments?: string };
                  }>
                | undefined;
            const toolCallDeltas = rawToolCalls
                ? rawToolCalls.map((tc) => ({
                      index: tc.index ?? 0,
                      id: tc.id ?? undefined,
                      function: tc.function
                          ? {
                                name: tc.function.name ?? undefined,
                                arguments: tc.function.arguments ?? undefined,
                            }
                          : undefined,
                  }))
                : null;

            yield {
                content: (delta?.content as string) ?? null,
                // DeepSeek R1 / Qwen thinking variants return reasoning_content
                reasoningContent: (delta?.reasoning_content as string) ?? null,
                toolCallDeltas,
                finishReason,
                usage,
            };
        }
    }

    // ── Media attachment (unchanged logic) ─────────────────────────

    private buildOpenAIMediaPart(
        att: MediaAttachment,
        skipped: string[],
    ): Record<string, unknown> | null {
        const label = att.sourcePath ? ` (${att.sourcePath})` : "";

        if (att.kind === "image") {
            if (!this.modalities.has("image")) {
                skipped.push(`image${label}: model not configured for image input`);
                return null;
            }
            return {
                type: "image_url",
                image_url: { url: `data:${att.mimeType};base64,${att.base64}` },
            };
        }
        if (att.kind === "audio") {
            if (!this.modalities.has("audio")) {
                skipped.push(`audio${label}: model not configured for audio input`);
                return null;
            }
            const format = openaiAudioFormat(att.mimeType);
            if (!format) {
                skipped.push(`audio${label}: unsupported MIME ${att.mimeType} for OpenAI input_audio`);
                return null;
            }
            return {
                type: "input_audio",
                input_audio: { data: att.base64, format },
            };
        }
        if (att.kind === "video") {
            skipped.push(`video${label}: OpenAI Chat Completions does not accept video input`);
            return null;
        }
        // pdf
        if (!this.modalities.has("pdf")) {
            skipped.push(`pdf${label}: model not configured for pdf input`);
            return null;
        }
        if (att.mimeType.toLowerCase() !== "application/pdf") {
            skipped.push(`pdf${label}: unsupported MIME ${att.mimeType} for OpenAI file input`);
            return null;
        }
        return {
            type: "file",
            file: {
                filename: deriveOpenAIFilename(att.sourcePath, "document.pdf"),
                file_data: `data:${att.mimeType};base64,${att.base64}`,
            },
        };
    }
}

// ─────────────────────────────────────────────
// Helpers (unchanged from original)
// ─────────────────────────────────────────────

function deriveOpenAIFilename(
    sourcePath: string | undefined,
    fallback: string,
): string {
    if (!sourcePath) return fallback;
    const base = sourcePath.split(/[\\/]/).pop();
    return base && base.length > 0 ? base : fallback;
}

function openaiAudioFormat(mime: string): string | null {
    const m = mime.toLowerCase();
    if (m === "audio/wav" || m === "audio/x-wav" || m === "audio/wave") return "wav";
    if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
    return null;
}

// ─────────────────────────────────────────────
// Non-streaming completion helper
// ─────────────────────────────────────────────

/**
 * Simple single-turn non-streaming chat completion for OpenAI-compatible APIs.
 * Used for lightweight tasks like context summarization where streaming is unnecessary.
 */
export async function createOpenAICompletion(
    config: { baseURL?: string; apiKey: string; model: string },
    messages: { role: string; content: string }[],
    signal?: AbortSignal,
): Promise<string> {
    const baseURL = config.baseURL || DEFAULT_BASE_URL;

    const body = {
        model: config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    const response = await corsFreeFetchWithRetry(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
    }, { onRetry: retryLogger("completion") });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `OpenAI completion error ${response.status}: ${errorBody || response.statusText}`,
        );
    }

    const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
    };

    return data.choices?.[0]?.message?.content || "";
}

// ─────────────────────────────────────────────
// Embeddings helper
// ─────────────────────────────────────────────

/**
 * Create text embeddings using OpenAI-compatible API.
 * Works with OpenAI, DeepSeek, and other OpenAI-compatible providers.
 */
export async function createOpenAIEmbeddings(
    config: { baseURL?: string; apiKey: string; model: string },
    texts: string[],
    signal?: AbortSignal,
): Promise<number[][]> {
    const baseURL = config.baseURL || DEFAULT_BASE_URL;

    const body = {
        model: config.model,
        input: texts,
    };

    const response = await corsFreeFetchWithRetry(`${baseURL}/embeddings`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
    }, { onRetry: retryLogger("embeddings") });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `OpenAI embedding error ${response.status}: ${errorBody || response.statusText}`,
        );
    }

    const data = (await response.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
    };

    // Sort by index to ensure correct order
    const sorted = (data.data ?? []).sort(
        (a, b) => (a.index ?? 0) - (b.index ?? 0),
    );
    return sorted.map((item) => item.embedding ?? []);
}
