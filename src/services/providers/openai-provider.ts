import OpenAI from "openai";
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

/**
 * Some OpenAI-compatible thinking models (DeepSeek R1, certain Qwen
 * thinking variants) require an out-of-spec `reasoning_content` field
 * to be echoed back on assistant messages, and also surface it on the
 * streaming `delta`. The OpenAI SDK types do not declare it.
 *
 * We use these narrow local extensions instead of `as any` so the only
 * untyped surface is the single `reasoning_content` property.
 */
type OpenAIMessageWithReasoning = OpenAI.Chat.ChatCompletionMessageParam & {
    reasoning_content?: string;
};

type OpenAIDeltaWithReasoning = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
    reasoning_content?: string | null;
};

/**
 * OpenAI-compatible LLM provider.
 * Works with any API that implements the OpenAI chat completions format
 * (DeepSeek, OpenRouter, Together AI, etc.)
 */
export class OpenAIProvider implements LLMProvider {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly modalities: Set<ModalityCapability>;

    constructor(config: LLMProviderConfig) {
        this.model = config.model;
        this.modalities = new Set(config.modalities ?? []);
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            dangerouslyAllowBrowser: true,
        });
    }

    async listModels(): Promise<string[]> {
        const response = await this.client.models.list();
        const models: string[] = [];
        for await (const model of response) {
            if (model.id) {
                models.push(model.id);
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
        // Some OpenAI-compatible thinking models (e.g. deepseek-v4-flash,
        // certain Qwen thinking variants) require the `reasoning_content`
        // of ALL assistant turns to be passed back. We attach it to every
        // assistant message that carries `thinkingContent` from a prior turn.

        // Defensive sanitization (last line of defense against 400 errors
        // caused by orphan tool_result / empty assistant messages that may
        // slip through the context reducer). See
        // docs/context-compression-fix-plan.md \u00a74.3.
        const sanitized: ChatMessageParam[] = [];
        const pendingToolCallIds = new Set<string>();
        for (const m of messages) {
            if (m.role === "assistant") {
                const hasToolCalls = !!(m.toolCalls && m.toolCalls.length > 0);
                const hasContent = typeof m.content === "string" && m.content.length > 0;
                const hasThinking = typeof m.thinkingContent === "string"
                    && m.thinkingContent.length > 0;
                if (!hasToolCalls && !hasContent && !hasThinking) {
                    console.warn("[openai-provider] dropping empty assistant message");
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
                    console.warn("[openai-provider] dropping orphan tool_result (toolCallId=", tcId, ")");
                    continue;
                }
                pendingToolCallIds.delete(tcId);
                sanitized.push(m);
                continue;
            }
            sanitized.push(m);
        }

        // Convert our messages to OpenAI format
        const openaiMessages = sanitized.map((m): OpenAI.Chat.ChatCompletionMessageParam => {
            if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
                const base: OpenAIMessageWithReasoning = {
                    role: "assistant" as const,
                    content: m.content || null,
                    tool_calls: m.toolCalls.map((tc) => ({
                        id: tc.id,
                        type: "function" as const,
                        function: { name: tc.function.name, arguments: tc.function.arguments },
                    })),
                };
                if (m.thinkingContent) {
                    base.reasoning_content = m.thinkingContent;
                }
                return base;
            }
            if (m.role === "tool_result") {
                return {
                    role: "tool" as const,
                    tool_call_id: m.toolCallId ?? "",
                    content: m.content,
                };
            }
            // User messages with multimodal attachments → multimodal content
            if (m.media && m.media.length > 0 && m.role === "user") {
                const parts: Array<
                    | { type: "text"; text: string }
                    | { type: "image_url"; image_url: { url: string } }
                    | { type: "input_audio"; input_audio: { data: string; format: string } }
                    | { type: "file"; file: { filename: string; file_data: string } }
                > = [{ type: "text" as const, text: m.content }];
                const skipped: string[] = [];
                for (const att of m.media) {
                    const part = this.buildOpenAIMediaPart(att, skipped);
                    if (part) parts.push(part);
                }
                // If skipped attachments exist, surface a single text note so
                // the model knows something was elided rather than silently
                // dropping it. Hard-coded English: this is model-facing, not
                // user-visible.
                if (skipped.length > 0) {
                    parts[0] = {
                        type: "text" as const,
                        text: `${m.content}\n\n[Attachments omitted: ${skipped.join("; ")}]`,
                    };
                }
                return {
                    role: "user" as const,
                    content: parts as unknown as OpenAI.Chat.ChatCompletionContentPart[],
                };
            }
            if (m.role === "assistant") {
                const base: OpenAIMessageWithReasoning = {
                    role: "assistant" as const,
                    content: m.content,
                };
                if (m.thinkingContent) {
                    base.reasoning_content = m.thinkingContent;
                }
                return base;
            }
            return {
                role: m.role as "system" | "user",
                content: m.content,
            };
        });

        // Convert our tools to OpenAI format (they are already compatible)
        const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined =
            tools && tools.length > 0
                ? tools.map((t) => ({
                      type: "function" as const,
                      function: {
                          name: t.function.name,
                          description: t.function.description,
                          parameters: t.function.parameters,
                      },
                  }))
                : undefined;

        // `reasoning_effort` is supported by OpenAI o-series / GPT-5 and a
        // handful of OpenAI-compatible thinking models (DeepSeek R1, certain
        // Qwen variants). Only forward the three explicit tiers; `auto` and
        // `off` both translate to "omit the parameter" because OpenAI's API
        // has no way to truly disable thinking on a reasoning-only model and
        // `auto` is precisely "let the model decide".
        const isExplicitTier = thinkingLevel === "low"
            || thinkingLevel === "medium"
            || thinkingLevel === "high";

        const stream = await this.client.chat.completions.create(
            {
                model: this.model,
                messages: openaiMessages,
                tools: openaiTools,
                stream: true,
                stream_options: { include_usage: true },
                ...(isExplicitTier ? { reasoning_effort: thinkingLevel } : {}),
            },
            { signal },
        );

        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta as OpenAIDeltaWithReasoning | undefined;
            const finishReason = chunk.choices[0]?.finish_reason ?? null;
            const usage = chunk.usage
                ? {
                      promptTokens: chunk.usage.prompt_tokens,
                      completionTokens: chunk.usage.completion_tokens,
                      totalTokens: chunk.usage.total_tokens,
                  }
                : null;

            const toolCallDeltas = delta?.tool_calls
                ? delta.tool_calls.map((tc) => ({
                      index: tc.index,
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
                content: delta?.content ?? null,
                // DeepSeek R1 and compatible models return reasoning_content in the delta
                reasoningContent: delta?.reasoning_content ?? null,
                toolCallDeltas,
                finishReason,
                usage,
            };
        }
    }

    /**
     * Build a single OpenAI Chat Completions content part from a media attachment,
     * filtered by the profile's `modalities` capability set.
     *
     * Returns null and pushes a short English note into `skipped` for any
     * attachment that cannot be delivered through this API. The note is
     * surfaced to the model as a single text addendum so it can either
     * proceed without the asset or ask the user to convert it.
     *
     * Capability matrix (OpenAI Chat Completions):
     *  - image: forwarded as `image_url` (data URL)
     *  - audio: forwarded as `input_audio` (only `gpt-4o-audio-*` understands it;
     *           plain text-only models will error — gated by the profile flag)
     *  - video: not accepted by Chat Completions in any form → always skipped
     *  - pdf:   forwarded as `file` part with inline base64 data URL
     *           (subject to OpenAI's 32 MB / 100-page hard limit; pre-checked
     *           upstream at the vault read step)
     */
    private buildOpenAIMediaPart(
        att: MediaAttachment,
        skipped: string[],
    ):
        | { type: "image_url"; image_url: { url: string } }
        | { type: "input_audio"; input_audio: { data: string; format: string } }
        | { type: "file"; file: { filename: string; file_data: string } }
        | null {
        const label = att.sourcePath ? ` (${att.sourcePath})` : "";

        if (att.kind === "image") {
            if (!this.modalities.has("image")) {
                skipped.push(`image${label}: model not configured for image input`);
                return null;
            }
            return {
                type: "image_url" as const,
                image_url: { url: `data:${att.mimeType};base64,${att.base64}` },
            };
        }
        if (att.kind === "audio") {
            if (!this.modalities.has("audio")) {
                skipped.push(`audio${label}: model not configured for audio input`);
                return null;
            }
            // OpenAI input_audio only accepts wav and mp3 right now.
            const format = openaiAudioFormat(att.mimeType);
            if (!format) {
                skipped.push(`audio${label}: unsupported MIME ${att.mimeType} for OpenAI input_audio`);
                return null;
            }
            return {
                type: "input_audio" as const,
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
            type: "file" as const,
            file: {
                filename: deriveOpenAIFilename(att.sourcePath, "document.pdf"),
                file_data: `data:${att.mimeType};base64,${att.base64}`,
            },
        };
    }
}

/**
 * Derive a `filename` for OpenAI's `file` content part from an attachment's
 * source path. Falls back to a generic name when the attachment was injected
 * synthetically (e.g. via paste / drag-and-drop without a vault path).
 */
function deriveOpenAIFilename(sourcePath: string | undefined, fallback: string): string {
    if (!sourcePath) return fallback;
    const base = sourcePath.split(/[\\/]/).pop();
    return base && base.length > 0 ? base : fallback;
}

/**
 * Normalise an audio MIME type to the `format` value OpenAI's input_audio
 * part accepts ("wav" | "mp3"). Returns null for anything else.
 */
function openaiAudioFormat(mime: string): string | null {
    const m = mime.toLowerCase();
    if (m === "audio/wav" || m === "audio/x-wav" || m === "audio/wave") return "wav";
    if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
    return null;
}

/**
 * Simple single-turn non-streaming chat completion for OpenAI-compatible APIs.
 * Used for lightweight tasks like context summarization where streaming is unnecessary.
 */
export async function createOpenAICompletion(
    config: { baseURL?: string; apiKey: string; model: string },
    messages: { role: string; content: string }[],
): Promise<string> {
    const client = new OpenAI({
        baseURL: config.baseURL || "https://api.openai.com/v1",
        apiKey: config.apiKey,
        dangerouslyAllowBrowser: true,
    });

    const response = await client.chat.completions.create({
        model: config.model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
    });

    return response.choices[0]?.message?.content || "";
}

/**
 * Create text embeddings using OpenAI-compatible API.
 * Works with OpenAI, DeepSeek, and other OpenAI-compatible providers.
 */
export async function createOpenAIEmbeddings(
    config: { baseURL?: string; apiKey: string; model: string },
    texts: string[],
): Promise<number[][]> {
    const client = new OpenAI({
        baseURL: config.baseURL || "https://api.openai.com/v1",
        apiKey: config.apiKey,
        dangerouslyAllowBrowser: true,
    });

    const response = await client.embeddings.create({
        model: config.model,
        input: texts,
    });

    // Sort by index to ensure correct order (API may return in different order)
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((item) => item.embedding);
}
