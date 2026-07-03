import type {
    LLMProvider,
    LLMProviderConfig,
    ModalityCapability,
    ToolDefinition,
    ToolCallDelta,
    StreamChunk,
    ChatMessageParam,
    CompleteToolCall,
    ThinkingLevel,
} from "../llm-provider";
import { sanitizeChatMessages } from "./_shared";
import { parseSSEFrames } from "../../utils/sse-parser";
import { fetchWithRetry } from "../../utils/retry-helper";

const retryLogger = (ctx: string) =>
    (err: unknown, n: number) => console.warn(`[gemini-provider] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Base URL for the Gemini API (Gemini via Google AI, not Vertex AI). */
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Header name for API key authentication. */
export const API_KEY_HEADER = "x-goog-api-key";

/**
 * Locally-narrowed view of a Gemini REST API `Part`.
 *
 * Since we do explicit `if (...)` checks before touching each field,
 * declaring a permissive optional-fields shape is the cleanest way to
 * keep this file `any`-free.
 */
interface GeminiPartView {
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: {
        name?: string;
        args?: Record<string, unknown>;
        signature?: string;
    };
    inlineData?: {
        mimeType?: string;
        data?: string;
    };
}

// ─────────────────────────────────────────────
// SSE Stream Parser (for `?alt=sse`)
// ─────────────────────────────────────────────

/**
 * Parse a Gemini SSE (Server-Sent Events) byte stream into individual
 * JSON objects.
 *
 * Gemini's `streamGenerateContent` with `?alt=sse` returns standard SSE:
 * each event is separated by a blank line, and the payload is on a
 * `data:` line as a complete JSON object.
 *
 * @param body   - The response body ReadableStream from `window.fetch`.
 * @param signal - Optional AbortSignal to cancel the stream early.
 */
export async function* parseGeminiSSEStream(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncIterable<Record<string, unknown>> {
    for await (const frame of parseSSEFrames(body, signal)) {
        // Extract data: payload from the frame
        for (const line of frame.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
                const jsonStr = trimmed.slice(6);
                // Skip empty data (ping frames)
                if (jsonStr === "" || jsonStr === "{}") break;
                try {
                    yield JSON.parse(jsonStr) as Record<string, unknown>;
                } catch {
                    console.warn(
                        "[gemini-provider] SSE JSON parse error:",
                        jsonStr.slice(0, 200),
                    );
                }
                break; // one data: line per frame is enough
            }
        }
    }
}

// ─────────────────────────────────────────────
// GeminiProvider
// ─────────────────────────────────────────────

/**
 * Google Gemini LLM provider using direct `window.fetch`.
 *
 * Talks directly to the Gemini REST API (`/v1beta/models/{model}:generateContent`,
 * `/v1beta/models/{model}:streamGenerateContent`, `/v1beta/models`) via raw
 * `window.fetch`. This keeps the plugin footprint minimal.
 */
export class GeminiProvider implements LLMProvider {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly modalities: Set<ModalityCapability>;

    constructor(config: LLMProviderConfig) {
        this.model = config.model;
        // Default to allowing every modality for Gemini: the API supports
        // image / audio / video / pdf via inlineData uniformly, and users
        // who want to gate cost can untick modalities in settings.
        this.modalities = new Set(config.modalities ?? ["image", "audio", "video", "pdf"]);
        this.apiKey = config.apiKey;
    }

    // ── listModels ────────────────────────────────────────────────

    async listModels(): Promise<string[]> {
        const models: string[] = [];
        let pageToken: string | undefined;

        do {
            const params = new URLSearchParams();
            params.set("pageSize", "50");
            if (pageToken) params.set("pageToken", pageToken);

            const url = `${GEMINI_BASE_URL}/models?${params.toString()}`;
            const response = await fetchWithRetry(url, {
                headers: { [API_KEY_HEADER]: this.apiKey },
            }, { onRetry: retryLogger("listModels") });

            if (!response.ok) {
                const errorBody = await response.text().catch(() => "");
                throw new Error(
                    `Gemini listModels failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ""}`,
                );
            }

            const data = (await response.json()) as {
                models?: Array<{ name?: string }>;
                nextPageToken?: string;
            };

            for (const model of data.models ?? []) {
                // Model names are returned as "models/gemini-2.5-flash" format.
                // Strip the "models/" prefix if present.
                const name = model.name?.replace(/^models\//, "");
                if (name) {
                    models.push(name);
                }
            }

            pageToken = data.nextPageToken;
        } while (pageToken);

        return models.sort((a, b) => a.localeCompare(b));
    }

    // ── createStream ───────────────────────────────────────────────

    async *createStream(
        messages: ChatMessageParam[],
        tools?: ToolDefinition[],
        signal?: AbortSignal,
        thinkingLevel?: ThinkingLevel,
    ): AsyncIterable<StreamChunk> {
        // Convert ChatMessageParam[] to Gemini Content[] format
        const contents = this.convertMessages(messages);

        // Extract system instruction
        const systemInstructionText = this.extractSystemInstruction(messages);

        // Convert tools to Gemini FunctionDeclaration format
        const geminiTools =
            tools && tools.length > 0 ? this.convertTools(tools) : undefined;

        // Map ThinkingLevel to Gemini's `thinkingBudget`
        const thinkingBudget =
            thinkingLevel === "off"
                ? 0
                : thinkingLevel === "low"
                    ? 1024
                    : thinkingLevel === "medium"
                        ? 8192
                        : thinkingLevel === "high"
                            ? 32768
                            : null;

        // Build request body
        const body: Record<string, unknown> = {
            contents,
        };

        if (systemInstructionText) {
            body.systemInstruction = {
                parts: [{ text: systemInstructionText }],
            };
        }
        if (geminiTools) {
            body.tools = geminiTools;
            // Explicitly enable automatic function calling. Without this,
            // some Gemini model versions may default to not calling tools
            // even when tools are provided in the request.
            body.toolConfig = {
                functionCallingConfig: {
                    mode: "AUTO",
                },
            };
        }
        // thinkingConfig lives inside generationConfig in the REST API
        if (thinkingBudget !== null) {
            body.generationConfig = {
                thinkingConfig: { thinkingBudget },
            };
        }

        // Fire streaming request with `?alt=sse` to get SSE format.
        // The default response format is a streaming JSON array (pretty-printed
        // with newlines inside objects), which is NOT NDJSON and cannot be
        // parsed line-by-line. `alt=sse` gives us standard SSE with one complete
        // JSON object per `data:` line.
        const response = await fetchWithRetry(
            `${GEMINI_BASE_URL}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`,
            {
                method: "POST",
                headers: {
                    [API_KEY_HEADER]: this.apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal,
            },
            { onRetry: retryLogger("createStream") },
        );

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(
                `Gemini API error ${response.status}: ${errorBody || response.statusText}`,
            );
        }

        if (!response.body) {
            throw new Error("Gemini returned no response body");
        }

        // Parse SSE stream and convert to StreamChunk
        for await (const chunk of parseGeminiSSEStream(response.body, signal)) {
            const rawFinishReason =
                (chunk.candidates as Array<Record<string, unknown>>)?.[0]
                    ?.finishReason;
            const finishReason =
                typeof rawFinishReason === "string"
                    ? geminiFinishReasonToString(rawFinishReason)
                    : null;

            const toolCallDeltas: ToolCallDelta[] = [];
            const thoughtSignatures: string[] = [];
            let thoughtText = "";
            let content: string | null = null;

            // Extract parts from the first candidate
            const parts = (
                (chunk.candidates as Array<Record<string, unknown>>)?.[0]?.content as Record<
                    string,
                    unknown
                >
            )?.parts as GeminiPartView[] | undefined;

            if (parts) {
                let fcIndex = 0;
                for (const part of parts) {
                    // Extract thought/reasoning text from thinking model parts
                    if (part.thought === true && part.text) {
                        thoughtText += part.text;
                    }
                    // Extract regular text content (not thought)
                    else if (part.text && !part.thought) {
                        content = (content ?? "") + part.text;
                    }
                    if (part.functionCall) {
                        const fc = part.functionCall;
                        toolCallDeltas.push({
                            index: fcIndex,
                            id: `call_${fc.name}_${fcIndex}`,
                            function: {
                                name: fc.name ?? "unknown",
                                arguments: JSON.stringify(fc.args ?? {}),
                            },
                        });
                        // Capture thoughtSignature from the SAME part as the functionCall
                        const sig = part.thoughtSignature || fc.signature;
                        if (sig) {
                            thoughtSignatures.push(sig);
                        }
                        fcIndex++;
                    }
                }
            }

            // Gemini reports usage at the end of the stream in usageMetadata
            const um = chunk.usageMetadata as
                | {
                      promptTokenCount?: number;
                      candidatesTokenCount?: number;
                      totalTokenCount?: number;
                      cachedContentTokenCount?: number;
                  }
                | undefined;
            const usage = um
                ? {
                      promptTokens: um.promptTokenCount ?? 0,
                      completionTokens: um.candidatesTokenCount ?? 0,
                      totalTokens: um.totalTokenCount ?? 0,
                      cachedPromptTokens: um.cachedContentTokenCount ?? 0,
                  }
                : null;

            yield {
                content,
                reasoningContent: thoughtText || null,
                toolCallDeltas:
                    toolCallDeltas.length > 0 ? toolCallDeltas : null,
                finishReason,
                usage,
                thoughtSignatures:
                    thoughtSignatures.length > 0 ? thoughtSignatures : undefined,
            };
        }
    }

    // ── Message / tool helpers ─────────────────────────────────────

    private extractSystemInstruction(
        messages: ChatMessageParam[],
    ): string | null {
        for (const msg of messages) {
            if (msg.role === "system") return msg.content;
        }
        return null;
    }

    private convertMessages(
        messages: ChatMessageParam[],
    ): Array<{
        role: "user" | "model";
        parts: Array<Record<string, unknown>>;
    }> {
        const contents: Array<{
            role: "user" | "model";
            parts: Array<Record<string, unknown>>;
        }> = [];

        const sanitized = sanitizeChatMessages(messages, "gemini-provider");

        for (const msg of sanitized) {
            if (msg.role === "system") continue; // handled separately

            if (msg.role === "user") {
                // User messages with multimodal attachments
                if (msg.media && msg.media.length > 0) {
                    const skipped: string[] = [];
                    const parts: Array<Record<string, unknown>> = [];
                    for (const att of msg.media) {
                        if (!this.modalities.has(att.kind)) {
                            const label = att.sourcePath
                                ? ` (${att.sourcePath})`
                                : "";
                            skipped.push(
                                `${att.kind}${label}: modality not enabled for this profile`,
                            );
                            continue;
                        }
                        // Gemini accepts image / audio / video / pdf via inlineData uniformly.
                        parts.push({
                            inlineData: {
                                mimeType: att.mimeType,
                                data: att.base64,
                            },
                        });
                    }
                    const text =
                        skipped.length > 0
                            ? `${msg.content}\n\n[Attachments omitted: ${skipped.join("; ")}]`
                            : msg.content;
                    // Gemini expects the text part first, then media parts.
                    contents.push({
                        role: "user",
                        parts: [{ text }, ...parts],
                    });
                } else {
                    contents.push({
                        role: "user",
                        parts: [{ text: msg.content }],
                    });
                }
            } else if (msg.role === "assistant") {
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    // Assistant message with function calls
                    const parts: Array<Record<string, unknown>> = [];
                    if (msg.content) {
                        parts.push({ text: msg.content });
                    }
                    // Build function call parts with thought signatures on the SAME part.
                    // Gemini 3 requires thoughtSignature to be on the same Part as functionCall.
                    for (let i = 0; i < msg.toolCalls.length; i++) {
                        const tc = msg.toolCalls[i]!;
                        let args: Record<string, unknown> = {};
                        try {
                            args = JSON.parse(tc.function.arguments) as Record<
                                string,
                                unknown
                            >;
                        } catch {
                            /* keep empty args */
                        }
                        const fcPart: Record<string, unknown> = {
                            functionCall: {
                                name: tc.function.name,
                                args,
                            },
                        };
                        // Attach thoughtSignature to the corresponding function call part
                        if (
                            msg.thoughtSignatures &&
                            msg.thoughtSignatures[i]
                        ) {
                            fcPart.thoughtSignature =
                                msg.thoughtSignatures[i];
                        }
                        parts.push(fcPart);
                    }
                    contents.push({ role: "model", parts });
                } else {
                    contents.push({
                        role: "model",
                        parts: [{ text: msg.content }],
                    });
                }
            } else if (msg.role === "tool_result") {
                // Tool result → functionResponse
                let response: Record<string, unknown> = {
                    result: msg.content,
                };
                try {
                    const parsed = JSON.parse(msg.content) as unknown;
                    if (typeof parsed === "object" && parsed !== null) {
                        // Gemini requires function_response.response to be an object, not an array
                        response = Array.isArray(parsed)
                            ? { result: parsed }
                            : (parsed as Record<string, unknown>);
                    }
                } catch {
                    /* keep string as result */
                }

                const name =
                    msg.toolCallId
                        ?.replace(/^call_/, "")
                        .split("_")[0] ?? "unknown";
                contents.push({
                    role: "user",
                    parts: [{ functionResponse: { name, response } }],
                });
            }
        }

        return contents;
    }

    private convertTools(tools: ToolDefinition[]) {
        return [
            {
                functionDeclarations: tools.map((t) => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: jsonSchemaToGeminiSchema(
                        t.function.parameters,
                    ),
                })),
            },
        ];
    }
}

// ─────────────────────────────────────────────
// Schema conversion helpers
// ─────────────────────────────────────────────

/** JSON Schema → Gemini `type` string mapping. */
function jsonTypeToGeminiType(jsonType: string): string {
    switch (jsonType) {
        case "string":
            return "STRING";
        case "number":
            return "NUMBER";
        case "integer":
            return "INTEGER";
        case "boolean":
            return "BOOLEAN";
        case "array":
            return "ARRAY";
        case "object":
            return "OBJECT";
        default:
            return "OBJECT";
    }
}

/**
 * Convert a JSON Schema object to Gemini's Schema format.
 * Gemini uses the same basic structure but with string `type` values.
 */
function jsonSchemaToGeminiSchema(
    schema: Record<string, unknown>,
): Record<string, unknown> {
    if (!schema || typeof schema !== "object")
        return { type: "OBJECT", properties: {} };

    const result: Record<string, unknown> = {};

    // Map JSON Schema type to Gemini type string
    const jsonType = schema.type as string | undefined;
    if (jsonType) {
        result.type = jsonTypeToGeminiType(jsonType);
    }

    if (schema.description) result.description = schema.description;
    if (schema.properties) {
        const props: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(
            schema.properties as Record<string, unknown>,
        )) {
            props[key] = jsonSchemaToGeminiSchema(
                value as Record<string, unknown>,
            );
        }
        result.properties = props;
    }
    if (Array.isArray(schema.required)) {
        result.required = schema.required;
    }
    if (Array.isArray(schema.items)) {
        result.items = schema.items.map((item) =>
            jsonSchemaToGeminiSchema(item as Record<string, unknown>),
        );
    } else if (
        typeof schema.items === "object" &&
        schema.items !== null
    ) {
        result.items = jsonSchemaToGeminiSchema(
            schema.items as Record<string, unknown>,
        );
    }

    return result;
}

/** Map Gemini finishReason to provider-agnostic reason string. */
function geminiFinishReasonToString(reason: string): string | null {
    switch (reason) {
        case "STOP":
            return "stop";
        case "MAX_TOKENS":
            return "length";
        case "SAFETY":
            return "content_filter";
        case "RECITATION":
            return "content_filter";
        default:
            return "stop";
    }
}

// ─────────────────────────────────────────────
// Non-streaming completion helper
// ─────────────────────────────────────────────

/**
 * Simple single-turn non-streaming chat completion for Gemini API.
 * Used for lightweight tasks like context summarization where streaming is unnecessary.
 */
export async function createGeminiCompletion(
    config: { apiKey: string; model: string },
    messages: { role: string; content: string }[],
    signal?: AbortSignal,
): Promise<string> {
    // Extract system instruction
    let systemInstruction: string | undefined;
    const nonSystemMessages: Array<{
        role: "user" | "model";
        parts: Array<{ text: string }>;
    }> = [];

    for (const msg of messages) {
        if (msg.role === "system") {
            systemInstruction = msg.content;
        } else if (msg.role === "user") {
            nonSystemMessages.push({
                role: "user",
                parts: [{ text: msg.content }],
            });
        } else if (msg.role === "assistant") {
            nonSystemMessages.push({
                role: "model",
                parts: [{ text: msg.content }],
            });
        }
    }

    // Build request body for the REST API
    const body: Record<string, unknown> = {
        contents: nonSystemMessages,
    };

    if (systemInstruction) {
        body.systemInstruction = {
            parts: [{ text: systemInstruction }],
        };
    }

    const response = await fetchWithRetry(
        `${GEMINI_BASE_URL}/models/${encodeURIComponent(config.model)}:generateContent`,
        {
            method: "POST",
            headers: {
                [API_KEY_HEADER]: config.apiKey,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
        },
        { onRetry: retryLogger("completion") },
    );

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `Gemini completion error ${response.status}: ${errorBody || response.statusText}`,
        );
    }

    const data = (await response.json()) as {
        candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
        }>;
    };

    // Extract text from all text parts of the first candidate
    const parts = data.candidates?.[0]?.content?.parts;
    if (parts) {
        const texts: string[] = [];
        for (const part of parts) {
            if (part.text) {
                texts.push(part.text);
            }
        }
        return texts.join("") || "";
    }

    return "";
}

// ─────────────────────────────────────────────
// Tool call extraction helper
// ─────────────────────────────────────────────

/**
 * Helper to extract complete tool calls from Gemini function call parts.
 * Since Gemini returns function calls all at once (not streamed delta by delta),
 * we need a helper to process them.
 */
export function extractGeminiToolCalls(
    parts: Array<{
        functionCall?: { name: string; args: Record<string, unknown> };
    }>,
): CompleteToolCall[] | null {
    if (!parts || parts.length === 0) return null;

    const calls: CompleteToolCall[] = [];
    for (let i = 0; i < parts.length; i++) {
        const fc = parts[i]?.functionCall;
        if (fc) {
            calls.push({
                id: `call_${fc.name}_${i}`,
                type: "function",
                function: {
                    name: fc.name,
                    arguments: JSON.stringify(fc.args ?? {}),
                },
            });
        }
    }

    return calls.length > 0 ? calls : null;
}

// ─────────────────────────────────────────────
// Embeddings helper
// ─────────────────────────────────────────────

/**
 * Create text embeddings using Google Gemini API.
 *
 * Calls the `models.embedContent` REST endpoint. Note: the raw REST API
 * returns `{ embedding: { values: [...] } }` (singular) — NOT the SDK's
 * `{ embeddings: [ContentEmbedding] }` (plural array). We read the
 * singular `embedding` field directly.
 */
export async function createGeminiEmbeddings(
    config: { apiKey: string; model: string },
    texts: string[],
    signal?: AbortSignal,
): Promise<number[][]> {
    const embeddings: number[][] = [];

    // Gemini embedding REST API processes one text at a time.
    // Check abort BEFORE each request and also forward via `signal`
    // so the in-flight HTTP call itself can be cancelled.
    for (const text of texts) {
        if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
        }

        const body = {
            content: {
                parts: [{ text }],
            },
        };

        const response = await fetchWithRetry(
            `${GEMINI_BASE_URL}/models/${encodeURIComponent(config.model)}:embedContent`,
            {
                method: "POST",
                headers: {
                    [API_KEY_HEADER]: config.apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal,
            },
            { onRetry: retryLogger("embeddings") },
        );

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(
                `Gemini embedding error ${response.status}: ${errorBody || response.statusText}`,
            );
        }

        const data = (await response.json()) as {
            embedding?: { values?: number[] };
        };

        // Raw REST API returns { embedding: { values: [...] } } (singular)
        const values = data.embedding?.values;
        if (values && values.length > 0) {
            embeddings.push(values);
        } else {
            throw new Error(
                "Gemini embedding response missing embedding values",
            );
        }
    }

    return embeddings;
}
