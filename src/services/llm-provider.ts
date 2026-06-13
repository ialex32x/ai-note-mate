// ─────────────────────────────────────────────
// LLM Provider abstraction layer
// ─────────────────────────────────────────────

import { type EmbeddingProviderType } from "./providers";

/**
 * Thinking / reasoning effort level for models that support it.
 *
 * The five values are a provider-agnostic abstraction; each provider
 * translates them into its native API surface:
 *
 * - `"auto"`  — let the provider decide (parameter is omitted). This is
 *   the default for newly-created profiles and the implicit behavior
 *   when the field is missing from older saved profiles.
 * - `"off"`   — explicitly disable thinking where the provider can do so
 *   (e.g. Gemini Flash `thinkingBudget: 0`). For providers that cannot
 *   truly disable reasoning (OpenAI o-series), this is treated the same
 *   as `"auto"` — there is no API switch to honor.
 * - `"low" / "medium" / "high"` — tiered effort. Mapped to the native
 *   enum on OpenAI-compatible providers (`reasoning_effort`) and to
 *   integer token budgets on providers that expose a budget knob
 *   (Gemini: 1024 / 8192 / 32768).
 */
export type ThinkingLevel = "auto" | "off" | "low" | "medium" | "high";

/** Ordered list of every {@link ThinkingLevel} value (for UI dropdowns). */
export const ALL_THINKING_LEVELS: ThinkingLevel[] = [
    "auto",
    "off",
    "low",
    "medium",
    "high",
];

export interface MinimalModelConfig {
    type: EmbeddingProviderType;

    baseURL: string;
    apiKey: string;
    model: string;
}

/**
 * Tool capability flags.
 * Used to declare what kind of actions a tool may perform.
 */
export type ToolCapability =
    | "read_file"    // Read file contents
    | "write_file"   // Modify existing file
    | "delete_file"  // Delete file
    | "create_file"  // Create new file
    | "network"      // Access network/internet
    | "multimodal_generate"  // Multimodal generation (images, etc.)
    | "execute"      // Execute code in a sandboxed environment
;

/** All available tool capabilities */
export const ALL_TOOL_CAPABILITIES: ToolCapability[] = [
    "read_file",
    "write_file",
    "delete_file",
    "create_file",
    "network",
    "multimodal_generate",
    "execute",
];

/**
 * Universal tool definition (JSON Schema based).
 * This is the common format that all providers translate from.
 */
export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}

/**
 * Multimodal input modalities a provider/model accepts.
 * Persisted as an array on each profile so users can independently toggle
 * which kinds of attachments are forwarded to the model.
 */
export type ModalityCapability =
    | "image"   // Image input (PNG / JPEG / WebP / ...)
    | "audio"   // Audio input (MP3 / WAV / FLAC / ...)
    | "video"   // Video input (MP4 / WebM / MOV / ...)
    | "pdf";    // PDF document input

/** All available modality capabilities */
export const ALL_MODALITY_CAPABILITIES: ModalityCapability[] = [
    "image",
    "audio",
    "video",
    "pdf",
];

/** Configuration for creating an LLM provider */
export interface LLMProviderConfig {
    apiKey: string;
    baseURL?: string;
    model: string;
    /**
     * Modalities the provider/model accepts as input.
     * Empty array / undefined = text-only.
     * Note: not every provider can deliver every modality even when listed
     * here; e.g. OpenAI Chat Completions cannot accept video input regardless
     * of this flag, while Gemini supports all four via inlineData.
     */
    modalities?: ModalityCapability[];
}

/** A single streaming chunk from any LLM provider */
export interface StreamChunk {
    content: string | null;
    /** Thinking/reasoning text produced by the model (e.g., DeepSeek reasoning_content, Gemini thought parts) */
    reasoningContent: string | null;
    toolCallDeltas: ToolCallDelta[] | null;
    finishReason: string | null;
    usage: TokenUsage | null;
    /**
     * Provider-specific thought signatures (e.g., for Gemini thinking models).
     * These must be echoed back when replaying assistant messages with tool calls.
     */
    thoughtSignatures?: string[];
}

/** Delta for a streaming tool call */
export interface ToolCallDelta {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
}

/** A completed tool call (assembled from deltas) */
export interface CompleteToolCall {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
}

/** Token usage information */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /**
     * Per-call totalTokens from the most recent LLM API response
     * (NOT cumulative). Used by the UI to compute context-window
     * usage percentage. `undefined` before the first API call.
     */
    lastCallTotalTokens?: number;
}

/** The final result of processing a full stream */
export interface StreamResult {
    content: string;
    /** Accumulated thinking/reasoning text from the model */
    reasoningContent: string;
    toolCalls: CompleteToolCall[] | null;
    finishReason: string | null;
    usage: TokenUsage | null;
}

/**
 * Multimodal attachment carried on a `ChatMessageParam`.
 * Replaces the legacy `ImageContent` type which only modeled images.
 */
export interface MediaAttachment {
    /** Modality kind — drives provider routing (image_url vs input_audio vs ...) */
    kind: ModalityCapability;
    /** MIME type, e.g. "image/png", "audio/mpeg", "video/mp4", "application/pdf" */
    mimeType: string;
    /** Raw base64-encoded payload (no data: prefix) */
    base64: string;
    /** Optional source path/label, used in fallback text prompts */
    sourcePath?: string;
}

/** Role of a chat message */
export type ChatMessageRole = "user" | "assistant" | "tool_call" | "tool_result" | "system";


export interface ChatMessageParam {
    role: ChatMessageRole;
    content: string;
    /** Optional message ID for tracking purposes (e.g., debugging summaries) */
    id?: string;
    /**
     * Optional multimodal attachments (image / audio / video / pdf).
     * Providers route each item to the appropriate native part based on its
     * `kind`, filtered by the profile's `modalities` capability set.
     * Only meaningful on "user" role messages.
     */
    media?: MediaAttachment[];
    /** For assistant messages with tool calls */
    toolCalls?: CompleteToolCall[];
    /** For tool result messages */
    toolCallId?: string;
    /**
     * Provider-specific thought signatures (e.g., for Gemini thinking models).
     * When an assistant message contains tool calls, these signatures must be
     * echoed back to the provider when replaying the conversation.
     */
    thoughtSignatures?: string[];
    /**
     * Thinking/reasoning text produced by the model on a previous turn.
     * Only meaningful on assistant-role messages when replaying history.
     * Providers decide how (or whether) to forward this back to their API:
     * e.g. OpenAI-compatible providers may map it to `reasoning_content`
     * for models that require it (some DeepSeek / Qwen thinking variants);
     * Gemini uses its own `thoughtSignatures` mechanism instead and ignores
     * this field.
     */
    thinkingContent?: string;
    /**
     * Shrink-stage budget view of tool_result {@link content}; see
     * {@link import("./context-compression").HistoryMessage.contentBudgetHint}.
     */
    contentBudgetHint?: string;
    contentBudgetHintForLength?: number;
}

/**
 * Abstract interface for LLM providers.
 * Implementations wrap specific SDKs (OpenAI, Gemini, etc.)
 * and translate their native formats to/from the common types above.
 */
export interface LLMProvider {
    /** Create a streaming chat completion */
    createStream(
        messages: ChatMessageParam[],
        tools?: ToolDefinition[],
        signal?: AbortSignal,
        thinkingLevel?: ThinkingLevel,
    ): AsyncIterable<StreamChunk>;

    /** List available models from the provider */
    listModels(): Promise<string[]>;
}
