import { ContextReducer, ConversationSummary, estimateTokens, type ContextReduceOptions } from "./context-reducer";
// Re-export ConversationSummary for external consumers (e.g., SessionManager)
export type { ConversationSummary } from "./context-reducer";
// Re-export ContextReduceOptions so callers can construct the per-profile
// override structure without reaching into the reducer module directly.
export type { ContextReduceOptions } from "./context-reducer";
import type { MinimalModelConfig } from "./llm-provider";
import type {
    LLMProvider,
    MediaAttachment,
    ModalityCapability,
    ToolDefinition,
    CompleteToolCall,
    TokenUsage,
    ChatMessageParam,
    StreamChunk,
    ThinkingLevel,
    ToolCapability,
    ChatMessageRole,
} from "./llm-provider";
import { findSimilar } from "./text-embedding";
import { getGlobalEmbedder } from "./embedder";

// ─────────────────────────────────────────────
// Task 1: Core types & interfaces
// ─────────────────────────────────────────────

/** Unique identifier for a chat message */
type MessageId = string;

/**
 * System prompt used to instruct the summarizer model.
 * Defined here as a constant for easy tuning.
 */
export const SUMMARIZER_SYSTEM_PROMPT = `\
You are a conversation summarization assistant.
Your task is to distill the key points from the conversation below into a concise summary.

Requirements:
- Preserve: key facts, decisions, user preferences, important context
- Omit: redundant details, examples, elaboration, and any meta-commentary
- Output: ONLY the raw summary text, without any prefix, label, or wrapper like "Summary:", "Here is the summary:", etc.
- Language: Match the language of the conversation
- Format: Plain text, preferrably 2-4 sentences
`;



/**
 * A single chat message in the conversation.
 * The `streaming` flag indicates whether the message content is still
 * being constructed via a streaming response.
 */
/** Metadata attached to a tool_call message */
export interface ToolCallMeta {
    /** The tool call ID issued by the AI */
    toolCallId: string;
    /** Name of the tool being invoked */
    toolName: string;
    /** Already-parsed arguments object */
    toolArgs: Record<string, unknown>;
}

/** Result status of a tool call (attached to tool_call ChatMessage when done) */
export type ToolCallStatus = 'success' | 'warning' | 'error';

export interface ToolCallResultInfo {
    /** Whether the tool returned an error or warning */
    status: ToolCallStatus;
    /** The serialised result string returned by the tool */
    result: string;
}

export interface ChatMessage {
    /** Unique identifier (UUID-like) */
    id: MessageId;
    /** Who sent this message */
    role: ChatMessageRole;
    /**
     * Human-readable text content.
     * - user / assistant: the message text
     * - tool_call: a display label, e.g. "Calling search(query=...)"
     * - tool_result: the raw result string returned by the tool
     */
    content: string;
    /** True while the message is still being streamed; false when complete */
    streaming: boolean;
    /** Unix timestamp (ms) when the message was created */
    timestamp: number;
    /**
     * Present only on tool_call and tool_result messages.
     * Carries the structured metadata needed to render tool interactions in the UI.
     */
    toolCallMeta?: ToolCallMeta;
    /**
     * Present on tool_call messages after execution completes.
     * Contains the tool result and status (success/warning/error).
     */
    toolCallResult?: ToolCallResultInfo;
    /**
     * Thinking/reasoning content from the model (if the model supports it).
     * Only present on assistant messages.
     */
    thinkingContent?: string;
    /**
     * True when thinking/reasoning phase is complete and content output has begun.
     * Used to correctly display "thinking complete" status in the UI.
     */
    thinkingComplete?: boolean;
    /**
     * @deprecated File paths are now embedded in content using [[path]] syntax.
     * This field is kept for backward compatibility with old session data.
     */
    referencedFiles?: string[];
    /**
     * Confirmation state for tools requiring user approval.
     * Present when a tool has `requiresConfirmation: true` and
     * the confirmation flow was triggered.
     */
    confirmationState?: 'pending' | 'allowed' | 'rejected';
    /**
     * Conversation turn number. Only present on user messages and
     * the assistant messages that belong to that turn.
     * Increments by 1 each time the user sends a new message, starting from 1.
     */
    turn?: number;
    /**
     * Sub-agent source marker. When present, indicates that this message
     * was produced by a sub-agent and is displayed inline in the main
     * conversation flow. The UI uses this to render a colored side bar
     * and agent badge for visual distinction.
     */
    subAgent?: {
        /** Sub-agent name (e.g. "vault_inspector", "web", "code") */
        agentName: string;
        /** toolCallId of the parent delegate_task call in the main agent's messages */
        parentToolCallId: string;
    };
}

/** Session state of the ChatStream instance */
export type ChatSessionState = "idle" | "streaming" | "aborted" | "error";

/** Arguments passed to the onToolCall callback */
export interface ToolCallArgs {
    toolCallId: string;
    toolName: string;
    /** Already-parsed JSON arguments object */
    toolArgs: Record<string, unknown>;
    /** The tool_call ChatMessage that was added to history for this invocation */
    message: ChatMessage;
}

/**
 * The result returned by a registered tool's exec function.
 * - `success`: whether the tool executed successfully
 * - `type`: 'object' means `content` is a plain object/array and will be
 *   JSON-serialised by ChatStream before being sent to the AI;
 *   'text' means `content` is already a string and will be used as-is;
 *   'media' means `content` contains a multimodal payload
 *   ({ kind, mimeType, base64, path, size }) and will be injected as a
 *   user message attachment so the model can perceive it. The provider
 *   is responsible for routing each `kind` (image / audio / video / pdf)
 *   to its native part type and gracefully skipping unsupported ones.
 * - `content`: the actual result payload
 */
export interface ToolCallResult {
    success: boolean;
    type: "object" | "text" | "media";
    content: unknown;
}

/**
 * A tool registered with the ChatStream instance.
 * `schema` is the provider-agnostic tool definition; `exec` is the handler.
 */
export interface RegisteredTool {
    /** Only use this tool based on the intention */
    ondemand: boolean;

    /** Provider-agnostic tool schema (type + function definition) */
    schema: ToolDefinition;
    /**
     * Capability flags declaring what actions this tool may perform.
     * Used to filter tools based on user's permission settings.
     */
    capabilities?: ToolCapability[];
    /**
     * When true, the tool requires user confirmation before execution.
     * Only enforced when the global toolConfirmMode is set to "always".
     */
    requiresConfirmation?: boolean;
    /**
     * Execute the tool and return a structured result.
     * ChatStream will serialise object results automatically.
     * The first parameter is the ChatStream instance that invoked this tool,
     * allowing tools to access chat context, state, and utility methods.
     * The optional `signal` is the current AbortSignal — tools should check
     * `signal?.aborted` or use `withAbort()` to respond to user-initiated aborts.
     */
    exec: (
        chatStream: ChatStream,
        args: Record<string, unknown>,
        signal?: AbortSignal,
        context?: {
            /** The toolCallId assigned to this invocation */
            toolCallId: string;
            /** The tool_call ChatMessage that was added to history for this invocation */
            toolCallMessage: ChatMessage;
        },
    ) => Promise<ToolCallResult>;
}

/**
 * Configuration object for ChatStream.
 * All callback fields are optional; omitting them silently disables that hook.
 */
export interface ChatStreamConfig {
    /** Optional system prompt prepended to every conversation */
    systemPrompt?: string;
    /**
     * Optional callback that returns additional tools on each prompt call.
     * Used for dynamic tool sources (e.g., MCP servers) that may change
     * between sessions without re-creating the ChatStream instance.
     */
    dynamicTools?: () => RegisteredTool[];

    // ── Callbacks ──────────────────────────────────────────────────────────

    /**
     * Called when a prompt() call begins (before the first API request).
     */
    onStart?: () => void;

    /**
     * Called on every streaming chunk update AND once more when the message
     * is finalised (streaming === false).
     */
    onMessageUpdate?: (message: ChatMessage) => void;

    /**
     * Called when the AI requests a tool call.
     * Must return a Promise that resolves to the tool result string.
     * If not provided, encountering a tool call will trigger onError.
     */
    onToolCall?: (args: ToolCallArgs) => Promise<string>;

    /**
     * Called when a tool execution finishes (after the result is ready but before
     * the next AI response begins). Use this to show a "waiting for AI" indicator
     * in the UI during the gap between tool completion and the next streaming chunk.
     */
    onToolCallEnd?: (args: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        result: string;
        isError: boolean;
    }) => void;

    /**
     * Called when the entire prompt() flow completes successfully
     * (including all tool-call rounds).
     */
    onFinish?: (finalMessage: ChatMessage) => void;

    /**
     * Called when the user aborts the current streaming response.
     * The partial message content is passed so the UI can display it.
     */
    onAbort?: (partialMessage: ChatMessage) => void;

    /**
     * Called after each API round with the cumulative session token usage.
     */
    onUsageUpdate?: (usage: TokenUsage) => void;

    /**
     * Called when any error occurs during prompt() execution.
     */
    onError?: (error: Error) => void;

    /**
     * Called when a tool with `requiresConfirmation` is about to execute.
     * Should return a Promise resolving to true (approved) or false (rejected).
     * If not provided, tools requiring confirmation are auto-approved.
     */
    onConfirmToolCall?: (args: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        messageId: string;
    }) => Promise<boolean>;

    /**
     * Called when context compression occurs during a prompt call.
     * This happens when the conversation history exceeds the token threshold
     * and older messages are summarized.
     */
    onContextCompressed?: () => void;

    /**
     * Per-profile overrides for the context reducer.
     *
     * Populated by the factory that constructs a ChatStream for a particular
     * provider profile (see `chat-factory.ts`). When omitted, the reducer
     * falls back to its built-in defaults — the same behaviour as before
     * this option existed, so nothing breaks for callers that don't supply
     * it (e.g. tests, ad-hoc usage).
     *
     * `accessoryTokens` is intentionally NOT consumed from this struct: it's
     * recomputed per `prompt()` call from the live tool-schema list because
     * that varies by turn (dynamic tools / capability filtering), whereas
     * the threshold/window/maxSummaries values are fixed for the lifetime
     * of the ChatStream.
     */
    compressionOptions?: Pick<ContextReduceOptions,
        'compressionThreshold' | 'slidingWindowSize' | 'maxSummariesThreshold'
    >;
}

// ─────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────

/** Generate a simple unique ID */
function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Convert a tool's `media` result payload into a `MediaAttachment`.
 * Tools may either include an explicit `kind` or rely on `mimeType` for inference;
 * unknown MIME types default to `image` to preserve backward behaviour.
 */
function toMediaAttachment(content: unknown): MediaAttachment | null {
    if (typeof content !== "object" || content === null) return null;
    const c = content as {
        path?: string;
        kind?: ModalityCapability;
        mimeType?: string;
        base64?: string;
    };
    if (typeof c.mimeType !== "string" || typeof c.base64 !== "string") return null;
    const kind: ModalityCapability = c.kind ?? inferKindFromMime(c.mimeType);
    return {
        kind,
        mimeType: c.mimeType,
        base64: c.base64,
        sourcePath: typeof c.path === "string" ? c.path : undefined,
    };
}

function inferKindFromMime(mime: string): ModalityCapability {
    const m = mime.toLowerCase();
    if (m.startsWith("audio/")) return "audio";
    if (m.startsWith("video/")) return "video";
    if (m === "application/pdf") return "pdf";
    return "image";
}

function mediaKindLabel(kind: ModalityCapability): string {
    switch (kind) {
        case "image": return "Image";
        case "audio": return "Audio";
        case "video": return "Video";
        case "pdf":   return "PDF";
    }
}

/** Internal result type returned by _processStream */
interface StreamResultInternal {
    content: string;
    reasoningContent: string;
    toolCalls: CompleteToolCall[] | null;
    finishReason: string | null;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
    /** Thought signatures from the provider (e.g., Gemini thinking models) */
    thoughtSignatures?: string[];
}

export { TokenUsage };

/**
 * Per-agent token usage breakdown.
 *
 * - `main` is the main-agent's own usage (excluding sub-agents).
 * - `subAgents` is a cumulative total per sub-agent name.
 *
 * Only produced by multi-agent orchestrators; single-agent ChatStream
 * does not populate this (its `sessionTokenUsage` is already "main").
 */
export interface AgentTokenBreakdown {
    main: TokenUsage;
    subAgents: Record<string, TokenUsage>;
}

// ─────────────────────────────────────────────
// IChatAgent interface
// ─────────────────────────────────────────────

/**
 * Common interface shared by ChatStream and AgentOrchestrator.
 * SessionView programs against this interface so it can transparently
 * switch between single-agent and multi-agent modes.
 */
export interface IChatAgent {
    /** Read-only snapshot of the current message history */
    readonly messages: ReadonlyArray<ChatMessage>;
    /** Current session state */
    readonly state: ChatSessionState;
    /** Cumulative token usage across all API calls in this session */
    readonly sessionTokenUsage: TokenUsage;
    /** Current conversation turn number */
    readonly currentTurn: number;
    /** Get all conversation summaries (for persistence) */
    readonly summaries: ConversationSummary[];

    /** Clear all message history and reset state */
    clearHistory(): void;
    /** Restore messages and token usage from a previous session */
    restoreState(messages: ReadonlyArray<ChatMessage>, tokenUsage: TokenUsage, summaries?: ConversationSummary[]): void;
    /** Restore summaries from a previous session */
    restoreSummaries(summaries: ConversationSummary[]): void;
    /** Abort the current streaming response */
    abort(): void;
    /** Register a tool */
    registerTool(tool: RegisteredTool): void;
    /** Send a user message and trigger the AI response flow */
    prompt(
        userInput: string,
        options: {
            provider: LLMProvider;
            thinkingLevel?: ThinkingLevel;
            allowedCapabilities?: ToolCapability[];
            summarizer?: MinimalModelConfig;
            embedding?: MinimalModelConfig;
        },
    ): Promise<void>;

    // ── Sub-agent inline display (optional, implemented by AgentOrchestrator) ──

    /**
     * Get sub-agent messages produced for a specific delegate_task invocation.
     * Only implemented by AgentOrchestrator; returns empty array for plain ChatStream.
     */
    getSubAgentMessages?(parentToolCallId: string): ReadonlyArray<ChatMessage>;

    /**
     * Get all sub-agent messages keyed by parentToolCallId.
     * Used for session persistence.
     */
    getAllSubAgentMessages?(): ReadonlyMap<string, ChatMessage[]>;

    /**
     * Restore sub-agent messages from persisted data.
     * Called when loading a session from disk.
     */
    restoreSubAgentMessages?(map: Record<string, ChatMessage[]>): void;

    // ── Per-agent token usage breakdown (optional, multi-agent only) ──

    /**
     * Per-agent cumulative token usage split.
     * Undefined for single-agent ChatStream; populated by AgentOrchestrator.
     */
    readonly agentTokenBreakdown?: AgentTokenBreakdown;

    /**
     * Restore per-agent token usage breakdown from persisted data.
     * Called when loading a session from disk.
     */
    restoreAgentTokenBreakdown?(breakdown: AgentTokenBreakdown): void;
}

// ─────────────────────────────────────────────
// Task 2-7: ChatStream class
// ─────────────────────────────────────────────

/**
 * ChatStream manages a stateful AI conversation session.
 *
 * Usage:
 * ```ts
 * const chat = new ChatStream({ provider, systemPrompt, onMessageUpdate, onFinish, onError });
 * chat.registerTool(myTool);
 * await chat.prompt("Hello!");
 * ```
 */
export class ChatStream implements IChatAgent {
    // ── Private fields ──────────────────────────────────────────────────────

    private readonly _config: ChatStreamConfig;
    private _messages: ChatMessage[] = [];
    private _state: ChatSessionState = "idle";
    private _tools: RegisteredTool[] = [];
    private _abortController: AbortController | null = null;
    private _sessionTokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    private _currentTurn: number = 0;
    /** Separate storage for conversation summaries (kept out of original messages for clean UI) */
    private _summaries: ConversationSummary[] = [];

    // ── Constructor ─────────────────────────────────────────────────────────

    constructor(config: ChatStreamConfig) {
        this._config = config;
    }

    // ── Static helpers ────────────────────────────────────────────────────

    /** Serialise a ToolCallResult into a string for the API tool message */
    static serialiseToolResult(result: ToolCallResult): string {
        if (!result.success) {
            return `Error: ${result.type === "object" ? JSON.stringify(result.content) : String(result.content)}`;
        }
        if (result.type === "media") {
            const m = result.content as {
                path?: string;
                kind?: ModalityCapability;
                mimeType: string;
                base64: string;
                size?: number;
            };
            const kind = m.kind ?? inferKindFromMime(m.mimeType);
            const label = mediaKindLabel(kind);
            const where = m.path ?? "(in-memory)";
            return `${label} loaded successfully: ${where} (${m.mimeType}, ${m.size ?? "?"} bytes). The content has been provided as a multimodal attachment.`;
        }
        if (result.type === "object") {
            return JSON.stringify(result.content);
        }
        return String(result.content);
    }

    // ── Public getters ──────────────────────────────────────────────────────

    /** Read-only snapshot of the current message history */
    get messages(): ReadonlyArray<ChatMessage> {
        return [...this._messages];
    }

    /** Current session state */
    get state(): ChatSessionState {
        return this._state;
    }

    /** Cumulative token usage across all API calls in this session */
    get sessionTokenUsage(): TokenUsage {
        return { ...this._sessionTokenUsage };
    }

    /**
     * Replace the session token usage directly.
     *
     * This is a narrow-purpose escape hatch used by `AgentOrchestrator`
     * when restoring a per-agent breakdown from persisted data: the
     * orchestrator needs to overwrite the main-agent's own usage with the
     * historical `main` value (instead of the combined total that
     * `restoreState` would otherwise stuff in).
     *
     * Regular callers should use `restoreState` or accumulate via prompts.
     */
    setSessionTokenUsage(usage: TokenUsage): void {
        this._sessionTokenUsage = { ...usage };
    }

    /** Current conversation turn number (starts from 1) */
    get currentTurn(): number {
        return this._currentTurn;
    }

    /** Get all conversation summaries (for persistence) */
    get summaries(): ConversationSummary[] {
        return [...this._summaries];
    }

    // ── Public methods ──────────────────────────────────────────────────────

    /**
     * Clear all message history and reset state to idle.
     * Also clears accumulated conversation summaries, so the instance
     * behaves as if freshly constructed (modulo registered tools,
     * config, and callbacks, which are preserved by design).
     * Safe to call at any time (even during streaming, though not recommended).
     */
    clearHistory(): void {
        this._messages = [];
        this._summaries = [];
        this._state = "idle";
        this._abortController = null;
        this._sessionTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        this._currentTurn = 0;
    }

    /**
     * Restore messages and token usage from a previous session snapshot.
     * The messages are deep-cloned and marked as non-streaming.
     * Only user/assistant/tool_call/tool_result messages are restored.
     */
    restoreState(messages: ReadonlyArray<ChatMessage>, tokenUsage: TokenUsage, summaries?: ConversationSummary[]): void {
        this._messages = messages.map(m => ({
            ...m,
            streaming: false,
            // Deep clone nested objects
            toolCallMeta: m.toolCallMeta ? { ...m.toolCallMeta } : undefined,
            toolCallResult: m.toolCallResult ? { ...m.toolCallResult } : undefined,
        }));
        // Restore turn counter to the maximum turn value found in messages
        this._currentTurn = messages.reduce((max, m) => Math.max(max, m.turn ?? 0), 0);
        this._sessionTokenUsage = { ...tokenUsage };
        this._state = "idle";
        // Restore summaries if provided
        if (summaries && summaries.length > 0) {
            this._summaries = summaries.map(s => ({ ...s }));
        }
    }

    /**
     * Restore summaries from a previous session.
     * @param summaries Array of conversation summaries to restore
     */
    restoreSummaries(summaries: ConversationSummary[]): void {
        this._summaries = summaries.map(s => ({ ...s }));
    }

    /**
     * Abort the current streaming response.
     * Safe to call even if not currently streaming (no-op).
     */
    abort(): void {
        if (this._abortController) {
            this._abortController.abort();
            // Don't set to null immediately - keep the signal available for checks
            // It will be cleaned up when the prompt() method completes
        }
    }

    /**
     * Register a tool that the AI can call during a conversation.
     * Tools must be registered before calling prompt().
     */
    registerTool(tool: RegisteredTool): void {
        this._tools.push(tool);
    }

    /**
     * Send a user message and trigger the AI response flow.
     *
     * - Appends the user message to history
     * - Streams the AI response, firing onMessageUpdate on each chunk
     * - Handles tool calls by invoking registered tool handlers
     * - Fires onFinish when the full response is complete
     * - Fires onError and sets state to "error" on any failure
     *
     * @throws {Error} If called while another prompt() is already in progress
     */
    async prompt(
        userInput: string,
        options: {
            /** Override the provider for this prompt call (e.g. when switching profiles) */
            provider: LLMProvider;

            thinkingLevel?: ThinkingLevel;
            /** Capabilities the user has allowed; tools with disallowed capabilities will be filtered out */
            allowedCapabilities?: ToolCapability[];
            summarizer?: MinimalModelConfig,
            embedding?: MinimalModelConfig,
        }
    ): Promise<void> {
        // Guard: prevent concurrent calls
        if (this._state === "streaming") {
            throw new Error("ChatStream is already streaming. Wait for the current prompt to finish.");
        }

        // Transition to streaming state and notify start
        this._state = "streaming";
        this._abortController = new AbortController();
        this._config.onStart?.();

        // Append user message to UI-facing history (store original text with [[path]] syntax)
        // Increment turn counter for each user message
        const currentTurn = ++this._currentTurn;
        const userMessage: ChatMessage = {
            id: generateId(),
            role: "user",
            content: userInput,
            streaming: false,
            timestamp: Date.now(),
            turn: currentTurn,
        };
        this._messages.push(userMessage);

        // Build the raw messages array for UI display and context reduction.
        // The system prompt (if configured) is prepended as the first message so
        // that both the LLM request path and ContextReducer (which treats
        // role:"system" specially) can see it consistently.
        //
        // Tool interaction history is reconstructed as follows (see
        // docs/context-compression-fix-plan.md \u00a75.1):
        //   * UI-side `assistant` messages don't themselves carry a toolCalls
        //     array \u2014 they are followed by one or more `tool_call` messages
        //     whose `toolCallMeta` describes the call and whose
        //     `toolCallResult.result` is the raw result string.
        //   * We collect the trailing `tool_call` messages immediately after
        //     each `assistant` and (a) attach the corresponding toolCalls to
        //     the assistant ChatMessageParam, and (b) emit one
        //     `tool_result` ChatMessageParam per tool call.
        //   * Orphan `tool_call` messages (no preceding assistant, or no
        //     completed result yet) are skipped \u2014 they would produce orphan
        //     tool_results that the validator would drop anyway.
        const rawMessages: ChatMessageParam[] = [];
        if (this._config.systemPrompt) {
            rawMessages.push({ role: "system", content: this._config.systemPrompt });
        }
        for (let i = 0; i < this._messages.length; i++) {
            const msg = this._messages[i]!;
            if (msg.role === "user") {
                rawMessages.push({ role: "user", content: msg.content, id: msg.id });
                continue;
            }
            if (msg.role === "assistant") {
                // Collect the trailing tool_call siblings (if any) that belong
                // to this assistant turn.
                const toolCalls: NonNullable<ChatMessageParam["toolCalls"]> = [];
                const toolResultParams: ChatMessageParam[] = [];
                let j = i + 1;
                while (j < this._messages.length && this._messages[j]!.role === "tool_call") {
                    const tcMsg = this._messages[j]!;
                    const meta = tcMsg.toolCallMeta;
                    const res = tcMsg.toolCallResult;
                    if (meta && res) {
                        toolCalls.push({
                            id: meta.toolCallId,
                            type: "function",
                            function: {
                                name: meta.toolName,
                                arguments: JSON.stringify(meta.toolArgs ?? {}),
                            },
                        });
                        // Re-materialize the tool_result. Errors are stored
                        // in `res.result` without the "Error:" prefix; restore
                        // it so downstream consumers keep the same semantics
                        // they had during the original turn.
                        const content = res.status === "error" && !res.result.startsWith("Error:")
                            ? `Error: ${res.result}`
                            : res.result;
                        toolResultParams.push({
                            role: "tool_result",
                            toolCallId: meta.toolCallId,
                            content,
                        });
                    }
                    j++;
                }
                rawMessages.push({
                    role: "assistant",
                    content: msg.content,
                    id: msg.id,
                    thinkingContent: msg.thinkingContent,
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                });
                for (const tr of toolResultParams) rawMessages.push(tr);
                // Skip the consumed tool_call messages on the outer loop.
                i = j - 1;
                continue;
            }
            // tool_call without a preceding assistant, or other roles: skip.
        }

        // Filter tools based on allowed capabilities
        const allowedCapabilities = options?.allowedCapabilities;

        // Collect static (registered) tools and dynamic tools
        const dynamicTools = this._config.dynamicTools?.() ?? [];
        const allTools = [...this._tools, ...dynamicTools];

        const filteredTools = await this._getBestMatchedTools(
            options.embedding,
            userInput,
            allowedCapabilities
                ? allTools.filter(tool => {
                    // If tool has no capabilities declared, allow it (backward compatibility)
                    if (!tool.capabilities || tool.capabilities.length === 0) {
                        return true;
                    }
                    // Tool is allowed if ALL its capabilities are in the allowed list
                    return tool.capabilities.every(cap => allowedCapabilities.includes(cap));
                })
                : allTools // If no filter specified, allow all tools
        );

        try {
            let finalMessage: ChatMessage | null = null;

            // Tool-call loop: keep requesting until no more tool calls
            while (true) {
                const toolSchemas = filteredTools.map((t) => t.schema);
                const activeProvider = options?.provider;

                // Apply context compression if summarizer is configured
                // Note: summaries are stored separately from original messages to keep UI clean
                let messagesToSend = rawMessages;
                if (options.summarizer) {
                    // Estimate the byte cost of the tool schemas — they get
                    // serialised to JSON and shipped on every request, but
                    // never enter `rawMessages`, so without this term the
                    // reducer's threshold check would systematically
                    // under-count the real prompt size by 1–3k+ tokens on
                    // sessions with many tools attached. Use the same
                    // heuristic estimator as the reducer itself for a
                    // consistent budget unit.
                    const accessoryTokens = toolSchemas.length > 0
                        ? estimateTokens(JSON.stringify(toolSchemas))
                        : 0;
                    const reduceResult = await ContextReducer.reduce(
                        options.summarizer,
                        { content: SUMMARIZER_SYSTEM_PROMPT },
                        rawMessages,
                        this._summaries,
                        {
                            ...this._config.compressionOptions,
                            accessoryTokens,
                        },
                    );
                    messagesToSend = reduceResult.messagesToSend;
                    // console.log("Context reduced", reduceResult.compressed);
                    // Persist new summary if compression occurred
                    if (reduceResult.newSummary) {
                        this._summaries.push(reduceResult.newSummary);
                    }
                    // Notify that context compression occurred
                    if (reduceResult.compressed) {
                        this._config.onContextCompressed?.();
                    }
                } else {
                    // console.log("no summarizer configured, skipping context reduction");
                }

                const stream = activeProvider.createStream(
                    messagesToSend,
                    toolSchemas.length > 0 ? toolSchemas : undefined,
                    this._abortController.signal,
                    options?.thinkingLevel,
                );

                const result = await this._processStream(stream);

                // Accumulate token usage
                if (result.usage) {
                    this._sessionTokenUsage.promptTokens += result.usage.promptTokens;
                    this._sessionTokenUsage.completionTokens += result.usage.completionTokens;
                    this._sessionTokenUsage.totalTokens += result.usage.totalTokens;
                }
                this._config.onUsageUpdate?.(this.sessionTokenUsage);

                // Build and store the assistant ChatMessage
                // Skip if content is empty and there are tool calls (pure tool-call turn)
                const assistantMessage: ChatMessage = {
                    id: generateId(),
                    role: "assistant",
                    content: result.content,
                    streaming: false,
                    timestamp: Date.now(),
                    thinkingContent: result.reasoningContent || undefined,
                    turn: currentTurn,
                };
                const isPureToolCallTurn = !result.content && result.toolCalls && result.toolCalls.length > 0;
                if (!isPureToolCallTurn) {
                    this._messages.push(assistantMessage);
                    finalMessage = assistantMessage;
                }

                // Append assistant turn to the raw messages buffer (used for next LLM call)
                const assistantApiMsg: ChatMessageParam = {
                    role: "assistant",
                    content: result.content,
                    toolCalls: result.toolCalls ?? undefined,
                    thoughtSignatures: result.thoughtSignatures,
                    thinkingContent: result.reasoningContent || undefined,
                    // Carry the same id as the UI-side assistant message so
                    // ContextReducer can stably anchor summary cutoffs.
                    id: assistantMessage.id,
                };
                rawMessages.push(assistantApiMsg);

                // ── Handle tool calls ────────────────────────────────────────
                if (result.toolCalls && result.toolCalls.length > 0) {
                    for (const toolCall of result.toolCalls) {
                        if (toolCall.type !== "function") continue;

                        // Check if aborted before executing each tool
                        if (!this._abortController || this._abortController.signal.aborted) {
                            throw new DOMException("Aborted", "AbortError");
                        }

                        const toolName = toolCall.function.name;
                        const toolCallId = toolCall.id;
                        let toolArgs: Record<string, unknown>;
                        let argParseError: string | null = null;

                        try {
                            toolArgs = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
                        } catch {
                            // Surface the parse failure as a tool_result error rather than
                            // throwing — otherwise a single malformed tool_call (often caused
                            // by an over-long / truncated arguments string from the model)
                            // would abort the entire conversation. Returning an error result
                            // lets the LLM observe the failure and self-correct (retry with
                            // smaller / properly escaped arguments).
                            toolArgs = {};
                            argParseError = `Failed to parse arguments for tool "${toolName}": ${toolCall.function.arguments}`;
                        }

                        // Add a tool_call message to UI-facing history
                        const toolCallStartTime = Date.now();
                        const toolCallMessage: ChatMessage = {
                            id: generateId(),
                            role: "tool_call",
                            content: toolName,
                            streaming: true,   // mark as in-progress until result arrives
                            timestamp: toolCallStartTime,
                            toolCallMeta: { toolCallId, toolName, toolArgs },
                        };
                        this._messages.push(toolCallMessage);
                        this._config.onMessageUpdate?.({ ...toolCallMessage });

                        // Find the registered handler
                        const registered = filteredTools.find((t) => {
                            return t.schema.function.name === toolName;
                        });

                        let toolResult: string;
                        let mediaAttachment: MediaAttachment | null = null;

                        if (argParseError) {
                            // Skip handler dispatch entirely when arguments are unparseable —
                            // there is nothing meaningful to execute. Report the error back
                            // to the model so it can retry with corrected arguments.
                            toolResult = `Error: ${argParseError}`;
                        } else if (!registered) {
                            // No handler registered → delegate to onToolCall callback
                            if (this._config.onToolCall) {
                                toolResult = await this._config.onToolCall({
                                    toolCallId,
                                    toolName,
                                    toolArgs,
                                    message: toolCallMessage,
                                });
                            } else {
                                throw new Error(
                                    `Tool "${toolName}" was called but no handler is registered and no onToolCall callback is provided.`
                                );
                            }
                        } else {
                            // Execute the registered tool and serialise the result
                            try {
                                // Ask for user confirmation if required
                                if (registered.requiresConfirmation && this._config.onConfirmToolCall) {
                                    toolCallMessage.confirmationState = 'pending';
                                    this._config.onMessageUpdate?.({ ...toolCallMessage });

                                    const approved = await this._config.onConfirmToolCall({
                                        toolName,
                                        toolArgs,
                                        messageId: toolCallMessage.id,
                                    });
                                    toolCallMessage.confirmationState = approved ? 'allowed' : 'rejected';
                                    // Notify the UI so it can transition from the
                                    // pending (Allow button) state to the allowed
                                    // badge + in-progress cursor immediately —
                                    // otherwise long-running tools (e.g. image
                                    // generation) would keep showing the Allow
                                    // button until exec() finishes.
                                    this._config.onMessageUpdate?.({ ...toolCallMessage });

                                    if (!approved) {
                                        toolResult = 'Error: User rejected this tool call. The user does not want to perform this operation.';
                                    } else {
                                        const execResult = await registered.exec(
                                            this,
                                            toolArgs,
                                            this._abortController?.signal,
                                            { toolCallId, toolCallMessage },
                                        );
                                        toolResult = ChatStream.serialiseToolResult(execResult);
                                        if (execResult.type === "media") {
                                            mediaAttachment = toMediaAttachment(execResult.content);
                                        }
                                    }
                                } else {
                                    const execResult = await registered.exec(
                                        this,
                                        toolArgs,
                                        this._abortController?.signal,
                                        { toolCallId, toolCallMessage },
                                    );
                                    toolResult = ChatStream.serialiseToolResult(execResult);
                                    if (execResult.type === "media") {
                                        mediaAttachment = toMediaAttachment(execResult.content);
                                    }
                                }
                            } catch (err) {
                                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                                const error = err instanceof Error ? err : new Error(String(err));
                                toolResult = `Error: ${error.message}`;
                            }
                        }

                        // Check if aborted after tool execution
                        if (!this._abortController || this._abortController.signal.aborted) {
                            throw new DOMException("Aborted", "AbortError");
                        }

                        // Determine result status
                        const isError = toolResult.startsWith('Error:');
                        const resultStatus: 'success' | 'warning' | 'error' = isError ? 'error' : 'success';

                        // Mark the tool_call message as complete, update content with elapsed time
                        const toolCallElapsed = Date.now() - toolCallStartTime;
                        toolCallMessage.streaming = false;
                        toolCallMessage.content = `${toolName}  (${toolCallElapsed}ms)`;
                        toolCallMessage.toolCallResult = {
                            status: resultStatus,
                            result: isError ? toolResult.slice('Error:'.length).trim() : toolResult,
                        };
                        this._config.onMessageUpdate?.({ ...toolCallMessage });

                        // Notify UI that tool execution has finished - this is the gap before
                        // the AI starts its next response (which may include thinking)
                        this._config.onToolCallEnd?.({
                            toolName,
                            toolArgs,
                            result: toolResult,
                            isError,
                        });

                        // Append tool result to the raw messages buffer (used for next LLM call)
                        rawMessages.push({
                            role: "tool_result",
                            toolCallId,
                            content: toolResult,
                        });

                        // If the tool returned media content (image/audio/video/pdf),
                        // inject a user message so the LLM can actually perceive it.
                        // (Tool role messages are text-only in OpenAI/Gemini APIs.)
                        if (mediaAttachment) {
                            const label = mediaKindLabel(mediaAttachment.kind);
                            const src = mediaAttachment.sourcePath ?? "tool result";
                            rawMessages.push({
                                role: "user",
                                content: `[${label} content from ${src}]`,
                                media: [mediaAttachment],
                            });
                        }
                    }

                    // Continue the loop to let the AI process tool results
                    continue;
                }

                // No tool calls → conversation turn is complete
                break;
            }

            // Check if the stream ended due to an abort (some providers silently
            // end the iterator instead of throwing AbortError).
            const wasAborted = this._abortController?.signal.aborted ?? false;

            if (wasAborted) {
                this._state = "aborted";
                this._abortController = null;

                // Record the abort as a system message in history (display-only, not sent to API)
                this._messages.push({
                    id: generateId(),
                    role: "system",
                    content: "aborted",
                    streaming: false,
                    timestamp: Date.now(),
                });

                // Build a partial message from whatever was streamed so far
                const lastAssistantMsg = this._messages.filter(m => m.role === "assistant").pop();
                const partialMessage: ChatMessage = lastAssistantMsg
                    ? { ...lastAssistantMsg, streaming: false }
                    : {
                        id: generateId(),
                        role: "assistant",
                        content: "",
                        streaming: false,
                        timestamp: Date.now(),
                    };
                this._config.onAbort?.(partialMessage);
                return;
            }

            // Success: transition back to idle and fire onFinish
            this._state = "idle";
            this._abortController = null;
            if (finalMessage) {
                this._config.onFinish?.(finalMessage);
            }
        } catch (err) {
            this._abortController = null;

            // Check if this was a user-initiated abort
            if (err instanceof Error && err.name === 'AbortError') {
                this._state = "aborted";

                // Record the abort as a system message in history (display-only, not sent to API)
                this._messages.push({
                    id: generateId(),
                    role: "system",
                    content: "aborted",
                    streaming: false,
                    timestamp: Date.now(),
                });

                // Build a partial message from whatever was streamed so far
                const lastAssistantMsg = this._messages.filter(m => m.role === "assistant").pop();
                const partialMessage: ChatMessage = lastAssistantMsg
                    ? { ...lastAssistantMsg, streaming: false }
                    : {
                        id: generateId(),
                        role: "assistant",
                        content: "",
                        streaming: false,
                        timestamp: Date.now(),
                    };
                this._config.onAbort?.(partialMessage);
                return;
            }

            // Catch-all error handler
            this._state = "error";
            const error = err instanceof Error ? err : new Error(String(err));
            this._config.onError?.(error);
        }
    }

    // ── Private methods ─────────────────────────────────────────────────────
    private async _getBestMatchedTools(config: MinimalModelConfig | undefined, userInput: string, tools: RegisteredTool[]): Promise<RegisteredTool[]> {
        if (!config) return tools;

        /** Minimum cosine similarity for an on-demand tool to be included */
        const SIMILARITY_THRESHOLD = 0.3;

        try {
            const always = tools.filter(t => !t.ondemand);
            const ondemand = tools.filter(t => t.ondemand);

            if (ondemand.length === 0) return always;

            const embedder = getGlobalEmbedder();
            if (!embedder) {
                // Embedder singleton hasn't been initialized yet (should not happen
                // in normal plugin lifecycle, but be defensive).
                console.warn("ChatStream: global embedder not initialized, skipping tool filtering");
                return tools;
            }

            // Keep the shared embedder aligned with the caller's current embedding
            // config. updateConfig() is a no-op when the fingerprint is unchanged.
            await embedder.updateConfig(config);

            // Embed user input + all on-demand tool descriptions in one batched call.
            // The embedder handles per-text caching internally (hit rate will be high
            // for tool descriptions, near-zero for user inputs).
            const texts = [userInput, ...ondemand.map(t => t.schema.function.description)];
            const vectors = await embedder.embed(texts);
            const userEmbedding = vectors[0]!;
            const ondemandEmbeddings = vectors.slice(1);

            // ── Rank ALL ondemand tools (no threshold) so we can log every score ──
            const allRanked = findSimilar(userEmbedding, ondemandEmbeddings, ondemand.length, 0);
            // Then apply the threshold + topK cap used for actual selection.
            const similarities = allRanked
                .filter(s => s.similarity >= SIMILARITY_THRESHOLD)
                .slice(0, 9);
            const results = similarities.map(s => ondemand[s.index]!);

            // Detailed per-tool similarity log to help diagnose unexpected drops.
            // Each row: { name, similarity, passed }
            const scoreTable = allRanked.map(s => ({
                name: ondemand[s.index]!.schema.function.name,
                similarity: Number(s.similarity.toFixed(4)),
                passed: s.similarity >= SIMILARITY_THRESHOLD,
            }));
            // console.log(
            //     '[embedding tool filter]',
            //     `userInput="${userInput.length > 120 ? userInput.slice(0, 120) + '...' : userInput}"`,
            //     `threshold=${SIMILARITY_THRESHOLD}`,
            //     `always=[${always.map(t => t.schema.function.name).join(', ')}]`,
            //     `passed=${similarities.length}/${ondemand.length}`,
            // );
            console.debug(scoreTable);
            return [...always, ...results];
        } catch (err) {
            // The embedder tracks its own status (see Embedder.status); we just
            // fall back to the full tool set here.
            console.error("failed to call embedding, fallback to full tool set", err);
            return tools;
        }
    }

    /**
     * Process a streaming response from any LLM provider.
     *
     * - Creates a ChatMessage with streaming=true at the start
     * - Fires onMessageUpdate on every content chunk
     * - Accumulates tool_call deltas
     * - Finalises the message (streaming=false) and fires onMessageUpdate once more
     */
    private async _processStream(
        stream: AsyncIterable<StreamChunk>,
    ): Promise<StreamResultInternal> {
        // Create the in-progress assistant message
        const streamingMessage: ChatMessage = {
            id: generateId(),
            role: "assistant",
            content: "",
            streaming: true,
            timestamp: Date.now(),
        };

        // Don't notify UI yet — wait until there is actual content to show

        const toolCallsChunks: Map<
            number,
            { id: string; type: "function"; function: { name: string; arguments: string } }
        > = new Map();
        let finishReason: string | null = null;
        let usageData: { promptTokens: number; completionTokens: number; totalTokens: number } | null = null;
        const thoughtSignatures: string[] = [];

        for await (const chunk of stream) {
            finishReason = chunk.finishReason ?? null;

            // Extract usage from the final chunk
            if (chunk.usage) {
                usageData = chunk.usage;
            }

            // Accumulate content and fire update callback
            if (chunk.content) {
                const isFirstContent = streamingMessage.content === "";
                streamingMessage.content += chunk.content;
                // Mark thinking as complete when content output begins
                if (isFirstContent && streamingMessage.thinkingContent) {
                    streamingMessage.thinkingComplete = true;
                }
                // On the very first content chunk, emit the initial streaming bubble;
                // subsequent chunks emit a shallow copy as usual.
                this._config.onMessageUpdate?.(isFirstContent ? streamingMessage : { ...streamingMessage });
            }

            // Accumulate reasoning/thinking content
            if (chunk.reasoningContent) {
                streamingMessage.thinkingContent = (streamingMessage.thinkingContent ?? "") + chunk.reasoningContent;
                // Emit update so the UI can show the thinking indicator
                this._config.onMessageUpdate?.({ ...streamingMessage });
            }

            // Accumulate tool_call deltas (streamed in fragments)
            if (chunk.toolCallDeltas) {
                for (const tcDelta of chunk.toolCallDeltas) {
                    const idx = tcDelta.index;

                    if (!toolCallsChunks.has(idx)) {
                        toolCallsChunks.set(idx, {
                            id: "",
                            type: "function",
                            function: { name: "", arguments: "" },
                        });
                    }

                    const tcData = toolCallsChunks.get(idx)!;

                    if (tcDelta.id) tcData.id = tcDelta.id;
                    if (tcDelta.function?.name) tcData.function.name = tcDelta.function.name;
                    if (tcDelta.function?.arguments) tcData.function.arguments += tcDelta.function.arguments;
                }
            }

            // Accumulate thought signatures (required by some providers like Gemini thinking models)
            if (chunk.thoughtSignatures) {
                thoughtSignatures.push(...chunk.thoughtSignatures);
            }
        }

        // Mark message as complete; fire final update if there was any content
        streamingMessage.streaming = false;
        if (streamingMessage.content || streamingMessage.thinkingContent) {
            this._config.onMessageUpdate?.({ ...streamingMessage });
        }

        // Build the final tool_calls list
        let toolCallsList: CompleteToolCall[] | null = null;
        if (toolCallsChunks.size > 0) {
            const sortedIndices = Array.from(toolCallsChunks.keys()).sort((a, b) => a - b);
            toolCallsList = sortedIndices.map((idx) => {
                const tc = toolCallsChunks.get(idx)!;
                return {
                    id: tc.id,
                    type: tc.type,
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                } satisfies CompleteToolCall;
            });
        }

        return {
            content: streamingMessage.content,
            reasoningContent: streamingMessage.thinkingContent ?? "",
            toolCalls: toolCallsList,
            finishReason,
            usage: usageData,
            thoughtSignatures: thoughtSignatures.length > 0 ? thoughtSignatures : undefined,
        };
    }
}
