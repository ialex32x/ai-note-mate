import { GoogleGenAI, Type } from "@google/genai";
import type {
    LLMProvider,
    LLMProviderConfig,
    ModalityCapability,
    ToolDefinition,
    StreamChunk,
    ChatMessageParam,
    CompleteToolCall,
    ThinkingLevel,
} from "../llm-provider";

/**
 * Locally-narrowed view of a Gemini `Part`.
 *
 * The `@google/genai` SDK types a `Part` as a wide discriminated union, which
 * makes structural property access (`part.text`, `part.thought`,
 * `part.functionCall`, `part.thoughtSignature`) cumbersome — we'd otherwise
 * need a chain of type guards just to read fields that every variant either
 * has or omits. Since we already do explicit `if (...)` checks before touching
 * each field, declaring a permissive optional-fields shape is the cleanest
 * way to keep this file `any`-free without fighting the SDK types.
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
}

/**
 * Google Gemini LLM provider using the @google/genai SDK.
 */
export class GeminiProvider implements LLMProvider {
    private readonly client: GoogleGenAI;
    private readonly model: string;
    private readonly modalities: Set<ModalityCapability>;

    constructor(config: LLMProviderConfig) {
        this.model = config.model;
        // Default to allowing every modality for Gemini: the SDK supports
        // image / audio / video / pdf via inlineData uniformly, and users
        // who want to gate cost can untick modalities in settings.
        this.modalities = new Set(config.modalities ?? ["image", "audio", "video", "pdf"]);
        this.client = new GoogleGenAI({ apiKey: config.apiKey });
    }

    async listModels(): Promise<string[]> {
        const pager = await this.client.models.list();
        const models: string[] = [];
        for await (const model of pager) {
            // Gemini model names are returned as "models/gemini-2.5-flash" format
            // Strip the "models/" prefix if present
            const name = model.name?.replace(/^models\//, '');
            if (name) {
                models.push(name);
            }
        }
        return models.sort((a, b) => a.localeCompare(b));
    }

    async *createStream(
        messages: ChatMessageParam[],
        tools?: ToolDefinition[],
        signal?: AbortSignal,
        thinkingLevel?: ThinkingLevel,
    ): AsyncIterable<StreamChunk> {
        // Convert ChatMessageParam[] to Gemini Content[] format
        const contents = this.convertMessages(messages);

        // Extract system instruction
        const systemInstruction = this.extractSystemInstruction(messages);

        // Convert tools to Gemini FunctionDeclaration format
        const geminiTools = tools && tools.length > 0 ? this.convertTools(tools) : undefined;

        // Map the provider-agnostic ThinkingLevel to Gemini's `thinkingBudget`:
        //   - "auto" / undefined → omit entirely; Gemini picks its own default
        //     (dynamic on 2.5 Pro; dynamic-with-default on 2.5 Flash).
        //   - "off" → budget 0. Supported on Flash; will error on models that
        //     mandate thinking (e.g. Gemini 3 Pro / 2.5 Pro). The error is
        //     surfaced verbatim to the user — picking "off" on a thinking-only
        //     model is a misconfiguration we don't try to silently rewrite.
        //   - "low" / "medium" / "high" → fixed integer budgets sized to span
        //     the practical range without burning the entire output budget on
        //     thought tokens.
        const thinkingBudget = thinkingLevel === "off"
            ? 0
            : thinkingLevel === "low"
                ? 1024
                : thinkingLevel === "medium"
                    ? 8192
                    : thinkingLevel === "high"
                        ? 32768
                        : null;
        const thinkingConfig = thinkingBudget !== null
            ? { thinkingConfig: { thinkingBudget } }
            : {};

        const response = await this.client.models.generateContentStream({
            model: this.model,
            contents,
            config: {
                systemInstruction: systemInstruction || undefined,
                tools: geminiTools,
                ...thinkingConfig,
            },
            // @ts-expect-error -- abortSignal is supported but not yet in the type definitions
            abortSignal: signal,
        });

        for await (const chunk of response) {
            const finishReason = chunk.candidates?.[0]?.finishReason
                ? geminiFinishReasonToString(chunk.candidates[0].finishReason)
                : null;

            // Gemini returns function calls in the response parts.
            // For thinking models (Gemini 2.5/3), thoughtSignature is on the SAME
            // Part as the functionCall — it must be echoed back on that same part.
            // NOTE: We manually extract text from parts instead of using chunk.text,
            // because chunk.text triggers a warning when functionCall parts are present.
            const toolCallDeltas: import("../llm-provider").ToolCallDelta[] | null = [];
            const thoughtSignatures: string[] = [];
            let thoughtText = "";
            let content: string | null = null;

            // Iterate raw parts to capture text, thought text, function calls AND their thought signatures together
            const parts = chunk.candidates?.[0]?.content?.parts;
            if (parts) {
                let fcIndex = 0;
                for (const rawPart of parts) {
                    const part = rawPart as GeminiPartView;
                    // Extract thought/reasoning text from thinking model parts
                    if (part.thought === true && part.text) {
                        thoughtText += part.text;
                    }
                    // Extract regular text content (not thought)
                    else if (part.text) {
                        content = (content ?? "") + part.text;
                    }
                    if (part.functionCall) {
                        const fc = part.functionCall;
                        toolCallDeltas.push({
                            index: fcIndex,
                            id: `call_${fc.name}_${fcIndex}`,
                            function: {
                                name: fc.name,
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
            const usage = chunk.usageMetadata
                ? {
                      promptTokens: chunk.usageMetadata.promptTokenCount ?? 0,
                      completionTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
                      totalTokens: chunk.usageMetadata.totalTokenCount ?? 0,
                  }
                : null;

            yield {
                content,
                reasoningContent: thoughtText || null,
                toolCallDeltas: toolCallDeltas.length > 0 ? toolCallDeltas : null,
                finishReason,
                usage,
                thoughtSignatures: thoughtSignatures.length > 0 ? thoughtSignatures : undefined,
            };
        }
    }

    private extractSystemInstruction(messages: ChatMessageParam[]): string | null {
        for (const msg of messages) {
            if (msg.role === "system") return msg.content;
        }
        return null;
    }

    private convertMessages(
        messages: ChatMessageParam[],
    ): Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> {
        const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];

        // Defensive sanitization parallel to openai-provider. See
        // docs/context-compression-fix-plan.md \u00a74.3.
        const pendingToolCallIds = new Set<string>();
        const sanitized: ChatMessageParam[] = [];
        for (const m of messages) {
            if (m.role === "assistant") {
                const hasToolCalls = !!(m.toolCalls && m.toolCalls.length > 0);
                const hasContent = typeof m.content === "string" && m.content.length > 0;
                const hasThinking = typeof m.thinkingContent === "string"
                    && m.thinkingContent.length > 0;
                if (!hasToolCalls && !hasContent && !hasThinking) {
                    console.warn("[gemini-provider] dropping empty assistant message");
                    continue;
                }
                if (hasToolCalls) {
                    for (const tc of m.toolCalls!) pendingToolCallIds.add(tc.id);
                }
                sanitized.push(m);
                continue;
            }
            if (m.role === "tool_result") {
                const tcId = m.toolCallId;
                if (!tcId || !pendingToolCallIds.has(tcId)) {
                    console.warn("[gemini-provider] dropping orphan tool_result (toolCallId=", tcId, ")");
                    continue;
                }
                pendingToolCallIds.delete(tcId);
                sanitized.push(m);
                continue;
            }
            sanitized.push(m);
        }

        for (const msg of sanitized) {
            if (msg.role === "system") continue; // handled separately

            if (msg.role === "user") {
                // User messages with multimodal attachments
                if (msg.media && msg.media.length > 0) {
                    const skipped: string[] = [];
                    const parts: Array<Record<string, unknown>> = [];
                    for (const att of msg.media) {
                        if (!this.modalities.has(att.kind)) {
                            const label = att.sourcePath ? ` (${att.sourcePath})` : "";
                            skipped.push(`${att.kind}${label}: modality not enabled for this profile`);
                            continue;
                        }
                        // Gemini accepts image / audio / video / pdf via inlineData uniformly.
                        parts.push({ inlineData: { mimeType: att.mimeType, data: att.base64 } });
                    }
                    const text = skipped.length > 0
                        ? `${msg.content}\n\n[Attachments omitted: ${skipped.join("; ")}]`
                        : msg.content;
                    // Gemini expects the text part first, then media parts.
                    contents.push({ role: "user", parts: [{ text }, ...parts] });
                } else {
                    contents.push({ role: "user", parts: [{ text: msg.content }] });
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
                            args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        } catch { /* keep empty args */ }
                        const fcPart: Record<string, unknown> = {
                            functionCall: { name: tc.function.name, args },
                        };
                        // Attach thoughtSignature to the corresponding function call part
                        if (msg.thoughtSignatures && msg.thoughtSignatures[i]) {
                            fcPart.thoughtSignature = msg.thoughtSignatures[i];
                        }
                        parts.push(fcPart);
                    }
                    contents.push({ role: "model", parts });
                } else {
                    contents.push({ role: "model", parts: [{ text: msg.content }] });
                }
            } else if (msg.role === "tool_result") {
                // Tool result → functionResponse
                let response: Record<string, unknown> = { result: msg.content };
                try {
                    const parsed = JSON.parse(msg.content) as unknown;
                    if (typeof parsed === "object" && parsed !== null) {
                        // Gemini requires function_response.response to be an object, not an array
                        response = Array.isArray(parsed) ? { result: parsed } : (parsed as Record<string, unknown>);
                    }
                } catch { /* keep string as result */ }

                const name = msg.toolCallId?.replace(/^call_/, "").split("_")[0] ?? "unknown";
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
                    parameters: jsonSchemaToGeminiSchema(t.function.parameters),
                })),
            },
        ];
    }
}

/**
 * Convert a JSON Schema object to Gemini's Schema format.
 * Gemini uses the same basic structure but with a `type` enum.
 */
function jsonSchemaToGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
    if (!schema || typeof schema !== "object") return { type: Type.OBJECT, properties: {} };

    const result: Record<string, unknown> = {};

    // Map JSON Schema type to Gemini Type enum
    const jsonType = schema.type as string | undefined;
    if (jsonType) {
        result.type = jsonTypeToGeminiType(jsonType);
    }

    if (schema.description) result.description = schema.description;
    if (schema.properties) {
        const props: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
            props[key] = jsonSchemaToGeminiSchema(value as Record<string, unknown>);
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
    } else if (typeof schema.items === "object" && schema.items !== null) {
        result.items = jsonSchemaToGeminiSchema(schema.items as Record<string, unknown>);
    }

    return result;
}

function jsonTypeToGeminiType(jsonType: string): string {
    switch (jsonType) {
        case "string": return Type.STRING;
        case "number": return Type.NUMBER;
        case "integer": return Type.INTEGER;
        case "boolean": return Type.BOOLEAN;
        case "array": return Type.ARRAY;
        case "object": return Type.OBJECT;
        default: return Type.OBJECT;
    }
}

function geminiFinishReasonToString(reason: string): string | null {
    switch (reason) {
        case "STOP": return "stop";
        case "MAX_TOKENS": return "length";
        case "SAFETY": return "content_filter";
        case "RECITATION": return "content_filter";
        default: return "stop";
    }
}

/**
 * Simple single-turn non-streaming chat completion for Gemini API.
 * Used for lightweight tasks like context summarization where streaming is unnecessary.
 */
export async function createGeminiCompletion(
    config: { apiKey: string; model: string },
    messages: { role: string; content: string }[],
): Promise<string> {
    const client = new GoogleGenAI({ apiKey: config.apiKey });

    // Extract system instruction
    let systemInstruction: string | undefined;
    const nonSystemMessages: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
        if (msg.role === "system") {
            systemInstruction = msg.content;
        } else if (msg.role === "user") {
            nonSystemMessages.push({ role: "user", parts: [{ text: msg.content }] });
        } else if (msg.role === "assistant") {
            nonSystemMessages.push({ role: "model", parts: [{ text: msg.content }] });
        }
    }

    const response = await client.models.generateContent({
        model: config.model,
        contents: nonSystemMessages,
        config: {
            systemInstruction: systemInstruction,
        },
    });

    return response.text || "";
}

/**
 * Helper to extract complete tool calls from Gemini function call parts.
 * Since Gemini returns function calls all at once (not streamed delta by delta),
 * we need a helper to process them.
 */
export function extractGeminiToolCalls(
    parts: Array<{ functionCall?: { name: string; args: Record<string, unknown> } }>,
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

/**
 * Create text embeddings using Google Gemini API.
 * Gemini's embedding model returns embeddings for text content.
 */
export async function createGeminiEmbeddings(
    config: { apiKey: string; model: string },
    texts: string[],
): Promise<number[][]> {
    const client = new GoogleGenAI({ apiKey: config.apiKey });

    const embeddings: number[][] = [];

    // Gemini embedding API processes one text at a time
    for (const text of texts) {
        const response = await client.models.embedContent({
            model: config.model,
            contents: text,
        });

        if (response.embeddings && response.embeddings.length > 0) {
            // Extract the embedding values from the response
            const values = response.embeddings[0]?.values;
            if (values) {
                embeddings.push(values);
            } else {
                throw new Error("Gemini embedding response missing values");
            }
        } else {
            throw new Error("Gemini embedding response missing embeddings");
        }
    }

    return embeddings;
}
