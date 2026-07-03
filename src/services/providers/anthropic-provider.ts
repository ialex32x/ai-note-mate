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
import { fetchWithRetry } from "../../utils/retry-helper";

const retryLogger = (ctx: string) =>
    (err: unknown, n: number) => console.warn(`[anthropic-provider] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * Anthropic API version header value.
 *
 * `2023-06-01` is the current, required value for the Messages API — it is NOT
 * outdated. Anthropic has not shipped a newer dated version; subsequent
 * features are opted into via `anthropic-beta` headers rather than a new
 * `anthropic-version`. Their own SDKs still send `2023-06-01`. Do not "bump"
 * this to an invented date — the API rejects unknown versions.
 */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Output budget reserved for the *visible* reply (Anthropic requires `max_tokens`).
 * When extended thinking is enabled, the thinking budget is added on top of this so
 * that `max_tokens` always stays strictly greater than `thinking.budget_tokens`
 * (Anthropic rejects requests where `max_tokens <= budget_tokens`).
 */
const DEFAULT_MAX_TOKENS = 8192;

/** Default base URL for the Anthropic Messages API */
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";

// ─────────────────────────────────────────────
// Anthropic API wire types (narrow, local-only)
// ─────────────────────────────────────────────

interface AnthropicMessageParam {
    role: "user" | "assistant";
    content: AnthropicContentBlock[];
}

type AnthropicContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string | Array<{ type: "text"; text: string }> }
    | { type: "thinking"; thinking: string; signature: string };

/**
 * A `user` message whose content is exclusively `tool_result` blocks. Used to
 * decide whether the next `tool_result` should be merged into the previous turn
 * (parallel tool calls) rather than emitted as a separate `user` message.
 */
function isToolResultOnlyUserMessage(msg: AnthropicMessageParam): boolean {
    return (
        msg.role === "user" &&
        msg.content.length > 0 &&
        msg.content.every((block) => block.type === "tool_result")
    );
}

interface AnthropicToolDef {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}

interface AnthropicThinkingConfig {
    type: "enabled" | "disabled";
    budget_tokens?: number;
}

// SSE event payload types
interface SSEEventPayload {
    type: string;
    message?: {
        id: string;
        type: string;
        role: string;
        model: string;
        usage: {
            input_tokens: number;
            output_tokens: number;
            cache_read_input_tokens?: number | null;
            cache_creation_input_tokens?: number | null;
        };
    };
    index?: number;
    content_block?: {
        type: string;
        id?: string;
        name?: string;
        thinking?: string;
        signature?: string;
    };
    delta?: {
        type: string;
        text?: string;
        partial_json?: string;
        thinking?: string;
        signature?: string;
        stop_reason?: string;
    };
    usage?: { output_tokens: number };
    stop_reason?: string;
}

// ─────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────

/**
 * Anthropic (Claude) LLM provider using native `fetch`.
 *
 * Talks directly to the Anthropic Messages API (`/v1/messages`) with
 * Server-Sent Events (SSE) streaming. No SDK dependency — the payload
 * shapes are simple enough that a raw-fetch approach keeps the plugin
 * footprint minimal while giving full control over stream parsing and
 * abort handling.
 */
export class AnthropicProvider implements LLMProvider {
    private readonly apiKey: string;
    private readonly baseURL: string;
    private readonly model: string;
    private readonly modalities: Set<ModalityCapability>;

    constructor(config: LLMProviderConfig) {
        this.apiKey = config.apiKey;
        this.baseURL = config.baseURL || DEFAULT_BASE_URL;
        this.model = config.model;
        // Anthropic supports image input on all Claude 3+ models.
        // Audio / video / pdf are not accepted via the Messages API.
        this.modalities = new Set(config.modalities ?? ["image"]);
    }

    // ── listModels ────────────────────────────────────────────────

    async listModels(): Promise<string[]> {
        const response = await fetchWithRetry(`${this.baseURL}/models`, {
            headers: {
                "x-api-key": this.apiKey,
                "anthropic-version": ANTHROPIC_VERSION,
            },
        }, { onRetry: retryLogger("listModels") });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(
                `Anthropic listModels failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ""}`,
            );
        }

        const data = (await response.json()) as { data?: Array<{ id: string }> };
        return (data.data ?? []).map((m) => m.id).sort((a, b) => a.localeCompare(b));
    }

    // ── createStream ───────────────────────────────────────────────

    async *createStream(
        messages: ChatMessageParam[],
        tools?: ToolDefinition[],
        signal?: AbortSignal,
        thinkingLevel?: ThinkingLevel,
    ): AsyncIterable<StreamChunk> {
        // --- sanitize & convert ---
        const sanitized = sanitizeChatMessages(messages, "anthropic-provider");

        // Extract system message(s). Anthropic surfaces these as a
        // top-level `system` field (string or array of text blocks).
        let systemText = "";
        for (const m of sanitized) {
            if (m.role === "system") {
                systemText += (systemText ? "\n\n" : "") + m.content;
            }
        }

        const anthropicMessages = this.convertMessages(sanitized);

        // Convert tools to Anthropic format
        const anthropicTools: AnthropicToolDef[] | undefined =
            tools && tools.length > 0
                ? tools.map((t) => ({
                      name: t.function.name,
                      description: t.function.description,
                      input_schema: t.function.parameters,
                  }))
                : undefined;

        // Build thinking config
        const thinkingConfig = this.buildThinkingConfig(thinkingLevel);

        // --- build request body ---
        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: this.resolveMaxTokens(thinkingConfig),
            messages: anthropicMessages,
            stream: true,
        };
        if (systemText) {
            body.system = systemText;
        }
        if (anthropicTools) {
            body.tools = anthropicTools;
        }
        if (thinkingConfig) {
            body.thinking = thinkingConfig;
        }

        // --- fire request ---
        const response = await fetchWithRetry(`${this.baseURL}/messages`, {
            method: "POST",
            headers: {
                "x-api-key": this.apiKey,
                "anthropic-version": ANTHROPIC_VERSION,
                "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
        }, { onRetry: retryLogger("createStream") });

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            throw new Error(
                `Anthropic API error ${response.status}: ${errorBody || response.statusText}`,
            );
        }

        if (!response.body) {
            throw new Error("Anthropic returned no response body");
        }

        // --- parse SSE stream ---
        yield* parseAnthropicSSEStream(response.body, signal);
    }

    // ── Message conversion ─────────────────────────────────────────

    private convertMessages(messages: ChatMessageParam[]): AnthropicMessageParam[] {
        const result: AnthropicMessageParam[] = [];

        for (const msg of messages) {
            if (msg.role === "system") {
                continue; // handled via top-level `system` field
            }

            if (msg.role === "user") {
                const content: AnthropicContentBlock[] = [];

                // Text content
                content.push({ type: "text", text: msg.content });

                // Multimodal attachments
                if (msg.media && msg.media.length > 0) {
                    const skipped: string[] = [];
                    for (const att of msg.media) {
                        const block = this.buildMediaBlock(att, skipped);
                        if (block) content.push(block);
                    }
                    if (skipped.length > 0) {
                        content[0] = {
                            type: "text",
                            text: `${msg.content}\n\n[Attachments omitted: ${skipped.join("; ")}]`,
                        };
                    }
                }

                result.push({ role: "user", content });
            } else if (msg.role === "assistant") {
                const content: AnthropicContentBlock[] = [];

                // Thinking block (if the assistant had thinking from a prior turn)
                if (msg.thinkingContent && msg.thoughtSignatures && msg.thoughtSignatures.length > 0) {
                    const sig = msg.thoughtSignatures[0];
                    content.push({
                        type: "thinking",
                        thinking: msg.thinkingContent,
                        signature: sig ?? "",
                    });
                }

                // Text content
                if (msg.content) {
                    content.push({ type: "text", text: msg.content });
                }

                // Tool use blocks
                if (msg.toolCalls && msg.toolCalls.length > 0) {
                    for (const tc of msg.toolCalls) {
                        let input: Record<string, unknown> = {};
                        try {
                            input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
                        } catch {
                            /* keep empty input */
                        }
                        content.push({
                            type: "tool_use",
                            id: tc.id,
                            name: tc.function.name,
                            input,
                        });
                    }
                }

                result.push({ role: "assistant", content });
            } else if (msg.role === "tool_result") {
                const block: AnthropicContentBlock = {
                    type: "tool_result",
                    tool_use_id: msg.toolCallId ?? "",
                    content: msg.content,
                };
                // Anthropic requires the results of parallel tool calls to live in a
                // single `user` message (one `tool_result` block per call). Merge into
                // the preceding message when it is a tool-result-only `user` turn so
                // consecutive `tool_result` messages don't produce back-to-back `user`
                // turns, which the API rejects with a 400.
                const prev = result[result.length - 1];
                if (prev && isToolResultOnlyUserMessage(prev)) {
                    prev.content.push(block);
                } else {
                    result.push({ role: "user", content: [block] });
                }
            }
        }

        return result;
    }

    // ── Media attachment ───────────────────────────────────────────

    private buildMediaBlock(
        att: MediaAttachment,
        skipped: string[],
    ): AnthropicContentBlock | null {
        const label = att.sourcePath ? ` (${att.sourcePath})` : "";

        if (att.kind === "image") {
            if (!this.modalities.has("image")) {
                skipped.push(`image${label}: model not configured for image input`);
                return null;
            }
            return {
                type: "image",
                source: {
                    type: "base64",
                    media_type: att.mimeType,
                    data: att.base64,
                },
            };
        }

        // Anthropic Messages API only supports image input natively.
        // Audio, video, and PDF are not accepted as content blocks.
        const kindLabel = att.kind;
        skipped.push(`${kindLabel}${label}: Anthropic Messages API does not support ${kindLabel} input`);
        return null;
    }

    // ── Thinking config ────────────────────────────────────────────

    private buildThinkingConfig(
        thinkingLevel?: ThinkingLevel,
    ): AnthropicThinkingConfig | null {
        if (!thinkingLevel || thinkingLevel === "auto") {
            // Let Anthropic's model defaults decide
            return null;
        }
        if (thinkingLevel === "off") {
            return { type: "disabled" };
        }
        // Map tiers to token budgets. Anthropic models support up to
        // 16 384 thinking tokens (Claude 3.7+); the three tiers span the
        // practical range without eating the entire output budget.
        const budget =
            thinkingLevel === "low" ? 1024
            : thinkingLevel === "medium" ? 4096
            : 16384; // "high"
        return { type: "enabled", budget_tokens: budget };
    }

    /**
     * Resolve `max_tokens` for a request. When extended thinking is enabled,
     * `max_tokens` must exceed `thinking.budget_tokens`, so we add the visible
     * reply budget on top of the thinking budget (e.g. high tier: 16384 + 8192).
     */
    private resolveMaxTokens(
        thinkingConfig: AnthropicThinkingConfig | null,
    ): number {
        if (
            thinkingConfig?.type === "enabled" &&
            typeof thinkingConfig.budget_tokens === "number"
        ) {
            return thinkingConfig.budget_tokens + DEFAULT_MAX_TOKENS;
        }
        return DEFAULT_MAX_TOKENS;
    }
}

// ─────────────────────────────────────────────
// SSE stream parsing (module-level, pure — unit-tested)
// ─────────────────────────────────────────────
//
// These were previously private methods but use no instance state, so
// they live at module scope: that keeps `createStream` thin and, more
// importantly, makes the hand-written SSE parser directly unit-testable
// (see test/anthropic-sse.test.ts) without constructing a provider or
// mocking the network.

/**
 * Parse the Anthropic Messages SSE byte stream into {@link StreamChunk}s.
 *
 * Frames are delimited by a blank line (`\n\n`). The reader can split a
 * frame across two `read()` calls, so partial data is held in `buffer`
 * until a full frame is available.
 *
 * The only cross-frame state is `promptTokens`: `message_start` reports
 * input-token usage that the trailing `message_delta` needs to compute an
 * accurate total. (The previous per-block `Map` bookkeeping was dead — the
 * payloads are self-describing, so nothing downstream read it.)
 */
export async function* parseAnthropicSSEStream(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncIterable<StreamChunk> {
    let promptTokens = 0;
    let cachedPromptTokens = 0;

    for await (const frame of parseSSEFrames(body, signal)) {
        const payload = parseSSEFrame(frame);
        if (!payload) continue;

        // message_start carries the prompt-token count the trailing
        // message_delta needs; capture it before emitting so the
        // total is accurate regardless of event ordering. Also
        // capture cache-read tokens for the cached-prompt stat.
        if (payload.type === "message_start" && payload.message) {
            promptTokens = payload.message.usage.input_tokens;
            cachedPromptTokens =
                payload.message.usage.cache_read_input_tokens ?? 0;
        }

        const chunk = processSSEPayload(payload, promptTokens, cachedPromptTokens);
        if (chunk) yield chunk;
    }
}

/**
 * Parse a single SSE frame (lines before `\n\n`).
 *
 * Returns the JSON payload from the `data:` line, or null for
 * empty/ping frames.
 */
export function parseSSEFrame(frame: string): SSEEventPayload | null {
    // SSE frames look like:
    //   event: content_block_delta
    //   data: {"type":"content_block_delta",...}
    //
    // We only care about the data line; the event type is repeated
    // inside the JSON as `type` anyway.
    for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            // Skip empty data (ping frames)
            if (jsonStr === "" || jsonStr === "{}") return null;
            try {
                return JSON.parse(jsonStr) as SSEEventPayload;
            } catch {
                console.warn("[anthropic-provider] SSE JSON parse error:", jsonStr.slice(0, 200));
                return null;
            }
        }
    }
    return null;
}

/**
 * Convert a single SSE event payload into a StreamChunk.
 *
 * Deltas are emitted as-is (the caller accumulates). Tool-call
 * start events emit the id + name so the consumer can initialize
 * its tool-call map; subsequent input_json deltas supply the
 * arguments piece by piece.
 *
 * @param promptTokens Input-token count captured from `message_start`,
 *   used only to compute the total in the trailing `message_delta`.
 * @param cachedPromptTokens Prompt tokens read from cache (Anthropic
 *   `cache_read_input_tokens`), captured from `message_start`.
 */
export function processSSEPayload(
    payload: SSEEventPayload,
    promptTokens: number,
    cachedPromptTokens: number,
): StreamChunk | null {
    const type = payload.type;

    // --- message_start ---
    if (type === "message_start" && payload.message) {
        return {
            content: null,
            reasoningContent: null,
            toolCallDeltas: null,
            finishReason: null,
            usage: {
                promptTokens: payload.message.usage.input_tokens,
                completionTokens: 0,
                totalTokens: payload.message.usage.input_tokens,
                cachedPromptTokens,
            },
        };
    }

    // --- content_block_start ---
    if (type === "content_block_start" && payload.content_block) {
        const block = payload.content_block;
        const index = payload.index!;

        // Tool use block starting
        if (block.type === "tool_use") {
            return {
                content: null,
                reasoningContent: null,
                toolCallDeltas: [
                    {
                        index,
                        id: block.id,
                        function: { name: block.name },
                    },
                ],
                finishReason: null,
                usage: null,
            };
        }

        // Thinking block — may carry initial thinking text and signature
        if (block.type === "thinking") {
            const result: StreamChunk = {
                content: null,
                reasoningContent: block.thinking ?? null,
                toolCallDeltas: null,
                finishReason: null,
                usage: null,
            };
            if (block.signature) {
                result.thoughtSignatures = [block.signature];
            }
            return result;
        }

        // Text block starting — no content yet, don't emit
        return null;
    }

    // --- content_block_delta ---
    if (type === "content_block_delta" && payload.delta) {
        const delta = payload.delta;

        if (delta.type === "text_delta" && delta.text) {
            return {
                content: delta.text,
                reasoningContent: null,
                toolCallDeltas: null,
                finishReason: null,
                usage: null,
            };
        }

        if (delta.type === "input_json_delta" && delta.partial_json) {
            return {
                content: null,
                reasoningContent: null,
                toolCallDeltas: [
                    {
                        index: payload.index!,
                        function: { arguments: delta.partial_json },
                    },
                ],
                finishReason: null,
                usage: null,
            };
        }

        if (delta.type === "thinking_delta" && delta.thinking) {
            return {
                content: null,
                reasoningContent: delta.thinking,
                toolCallDeltas: null,
                finishReason: null,
                usage: null,
            };
        }

        if (delta.type === "signature_delta" && delta.signature) {
            return {
                content: null,
                reasoningContent: null,
                toolCallDeltas: null,
                finishReason: null,
                usage: null,
                thoughtSignatures: [delta.signature],
            };
        }
    }

    // --- content_block_stop ---
    // No content to emit, just signals end of a block.

    // --- message_delta ---
    if (type === "message_delta" && payload.delta && payload.usage) {
        return {
            content: null,
            reasoningContent: null,
            toolCallDeltas: null,
            finishReason: payload.delta.stop_reason ?? null,
            usage: {
                promptTokens,
                completionTokens: payload.usage.output_tokens,
                totalTokens: promptTokens + payload.usage.output_tokens,
                cachedPromptTokens,
            },
        };
    }

    // --- message_stop ---
    // End of stream — no chunk to emit.

    // --- ping / error ---
    // Ping: ignore. Error: Anthropic sends an SSE `error` event
    // which is rare but possible. Surface it as a thrown error so the
    // consumer doesn't silently treat a failed turn as a clean finish.
    if (type === "error" && (payload as unknown as Record<string, unknown>).error) {
        const err = ((payload as unknown as Record<string, unknown>).error as { message?: string });
        throw new Error(`Anthropic stream error: ${err.message ?? "unknown error"}`);
    }

    return null;
}

// ─────────────────────────────────────────────
// Non-streaming completion helper
// ─────────────────────────────────────────────

/**
 * Simple single-turn non-streaming chat completion for Anthropic.
 *
 * Used for lightweight tasks like context summarization where streaming
 * is unnecessary. Talks directly to the Messages API with `stream: false`.
 */
export async function createAnthropicCompletion(
    config: { baseURL?: string; apiKey: string; model: string },
    messages: { role: string; content: string }[],
    signal?: AbortSignal,
): Promise<string> {
    const baseURL = config.baseURL || DEFAULT_BASE_URL;

    // Extract system message
    let systemText = "";
    const anthropicMessages: AnthropicMessageParam[] = [];
    for (const msg of messages) {
        if (msg.role === "system") {
            systemText += (systemText ? "\n\n" : "") + msg.content;
        } else if (msg.role === "user") {
            anthropicMessages.push({
                role: "user",
                content: [{ type: "text", text: msg.content }],
            });
        } else if (msg.role === "assistant") {
            anthropicMessages.push({
                role: "assistant",
                content: [{ type: "text", text: msg.content }],
            });
        }
    }

    const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: anthropicMessages,
    };
    if (systemText) body.system = systemText;

    const response = await fetchWithRetry(`${baseURL}/messages`, {
        method: "POST",
        headers: {
            "x-api-key": config.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
    }, { onRetry: retryLogger("completion") });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        throw new Error(
            `Anthropic completion error ${response.status}: ${errorBody || response.statusText}`,
        );
    }

    const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
    };

    // Extract text from the first text content block
    for (const block of data.content ?? []) {
        if (block.type === "text" && block.text) {
            return block.text;
        }
    }
    return "";
}
