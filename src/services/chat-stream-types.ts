/**
 * Type definitions extracted from chat-stream.ts.
 *
 * Moved here to reduce chat-stream.ts line count (~24% reduction).
 * All types remain importable from chat-stream.ts via re-exports,
 * so NO other files need to change their import paths.
 */

import type {
    LLMProvider,
    ToolDefinition,
    CompleteToolCall,
    TokenUsage,
    ThinkingLevel,
    ToolCapability,
    ChatMessageRole,
    MediaAttachment,
} from "./llm-provider";
import type { GeneratedAsset } from "./generated-asset-collection";
import type { ConversationSummary, ContextCompressionOptions } from "./context-compression";
import type { MinimalModelConfig } from "./llm-provider";
import type { ArtifactStore } from "./artifact-store";
// import type is safe here — the only usage is as a parameter type in
// RegisteredTool.exec, and the ChatStream class value is imported by
// chat-stream.ts (which re-imports these types). esbuild strips `import
// type` at compile time so there is no runtime circular dependency.
import type { ChatStream } from "./chat-stream";

// ─────────────────────────────────────────────
// Core types & interfaces
// ─────────────────────────────────────────────

/** Unique identifier for a chat message */
export type MessageId = string;

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

/**
 * User-pasted image attachment stored on a ChatMessage.
 *
 * Only cache metadata is persisted — the base64 payload is resolved
 * on-demand via {@link ChatStreamConfig.resolveAttachment} when
 * building API-level messages.
 */
export interface ChatAttachment {
    /** Vault-relative path to the cached image file. */
    cachePath: string;
    /** MIME type, e.g. "image/png". */
    mimeType: string;
    /** Original file name for display / fallback text. */
    fileName: string;
}

/**
 * A single chat message in the conversation.
 * The `streaming` flag indicates whether the message content is still
 * being constructed via a streaming response.
 */
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
    /**
     * Internal: shrink-stage view of this message's tool result for LLM budget /
     * context reduction. Full text stays in {@link ToolCallResultInfo.result}
     * (UI, export, summarizer). When {@link contentBudgetHintForLength} matches
     * the reconstructed API tool_result body, reducers reuse the hint instead of
     * re-running shrink (and re-hitting the artifact store).
     */
    contentBudgetHint?: string;
    /** Length of the API tool_result `content` when {@link contentBudgetHint} was set. */
    contentBudgetHintForLength?: number;
    /**
     * True when this assistant reply was cut off by user abort or an error
     * before the stream finished. Used when rebuilding API messages so the
     * model knows the prior turn was incomplete; not shown in the UI bubble.
     */
    wasInterrupted?: boolean;
    /**
     * UI-only lifecycle hint: when true the view should remove this bubble
     * from the DOM. Set on ephemeral retire emits (e.g. pure tool-call turns
     * that streamed thinking but omit the assistant from history). Never
     * persisted.
     */
    retireBubble?: boolean;
    /**
     * Quick-ask side-turn marker. When present, this message is part of a
     * QuickAsk (追问) side conversation anchored to an existing assistant
     * message. The UI uses this to:
     *  - Render side-turn bubbles with a distinct visual style inside the
     *    QuickAsk panel.
     *  - Suppress the "QuickAsk" button on side-turn assistant replies
     *    (one-level depth enforcement).
     */
    quickAsk?: {
        /** ID of the assistant message being asked about */
        parentMessageId: string;
    };
    /**
     * Model identifier that generated this message (e.g. "gpt-4o",
     * "claude-sonnet-4-20250514"). Only meaningful for assistant messages.
     * Persisted to session JSON so the model is visible when reviewing
     * past conversations.
     */
    modelName?: string;
    /**
     * User-pasted image attachments for this message.
     * Only meaningful on user messages. Cache files are resolved to
     * base64 payloads on demand when building API messages.
     */
    attachments?: ChatAttachment[];
}

/**
 * A single QuickAsk (追问) side-turn: a user's follow-up question
 * about a specific assistant message and the AI's answer.
 *
 * Side-turns are stored separately from the main conversation flow
 * (`messages[]`) and are rendered in a standalone panel rather than
 * inline in the chat. They use a simple non-streaming LLM call with
 * no tools or sub-agent capability.
 */
export interface QuickAskTurn {
    /** Unique identifier for this turn (generated on creation). */
    id: string;
    /** ID of the assistant message being asked about */
    parentMessageId: string;
    /** The user's follow-up question */
    userMessage: ChatMessage;
    /** The AI's answer */
    assistantMessage: ChatMessage;
    /** True while awaiting the AI response */
    loading?: boolean;
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
 * - `assets`: optional structured metadata about generated assets
 *   (e.g. image files saved to the vault). Copied onto
 *   {@link ChatMessage.toolCallAssets} so the
 *   {@link GeneratedAssetCollection} can aggregate them without parsing
 *   the text content.
 */
export interface ToolCallResult {
    success: boolean;
    type: "object" | "text" | "media";
    content: unknown;
    assets?: GeneratedAsset[];
}

/**
 * Tunable parameters for the on-demand tool retriever.
 *
 * Forwarded by callers (typically the SessionView) into {@link IChatAgent.prompt}.
 * Missing fields fall back to the built-in default at the use-site
 * (see {@link DEFAULT_TOOL_FILTER_TOP_K}).
 *
 * - `topK`: cap on the number of on-demand tools surfaced to the model.
 *   Always-on tools are not counted toward this cap. The retriever
 *   itself (BM25 ± embedding RRF) does the ranking; there is no
 *   user-tunable score threshold because BM25 / RRF scores have no
 *   stable cross-model scale to threshold against.
 */
export interface ToolFilterOptions {
    topK: number;
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
     * Optional description used *only* for embedding-based similarity
     * matching, in place of `schema.function.description`. The schema
     * description is always what the LLM sees; this override is for cases
     * where the description carries noise or boilerplate that hurts
     * semantic ranking (e.g. MCP tools whose descriptions are prefixed
     * with `[MCP: <serverName>]` so the model can attribute the source,
     * but where the prefix dilutes cosine similarity across tools from
     * the same server).
     *
     * Leave undefined to fall back to `schema.function.description`.
     */
    embeddingDescription?: string;
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
     * Optional per-turn call budget for this tool. Enforced by
     * {@link ChatStream.prompt}; counters reset at the start of every
     * `prompt()` call (i.e. one user turn).
     *
     * - `soft`: once exceeded, the tool still runs but its result is
     *   suffixed with a reminder line nudging the model to stop. Use
     *   this as a polite hint for "you have probably gathered enough".
     * - `hard`: once exceeded, the tool is **not** invoked at all and
     *   the model receives a synthetic error result instructing it to
     *   stop calling this tool and synthesize an answer from what it
     *   already has. Use this as a safety belt against runaway loops
     *   (e.g. the model retrying a flaky fetch tool indefinitely).
     *
     * Either field may be omitted independently. Setting only `soft`
     * yields warnings without ever hard-blocking; setting only `hard`
     * silently lets the model run up to the limit and then blocks.
     * When both are set they should normally satisfy `soft < hard`.
     */
    maxCallsPerTurn?: {
        soft?: number;
        hard?: number;
    };
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
     * Optional callback that produces memory context text, prepended
     * at the very top of the system prompt (before skills, baseline,
     * and suffix).  Runs per-turn with the current user query.
     *
     * Prefer this over {@link systemPromptPrefix} when you need
     * independent token tracking for the memory layer.
     *
     * Errors are caught and ignored so a failing prefix provider can
     * never block the actual LLM request.
     */
    memoryPrefix?: (query: string, signal?: AbortSignal) => string | Promise<string>;
    /**
     * Optional callback that produces skill-catalogue text, prepended
     * after {@link memoryPrefix} but before the static
     * {@link systemPrompt}.  Runs per-turn with the current user query.
     *
     * Prefer this over {@link systemPromptPrefix} when you need
     * independent token tracking for the skill layer.
     *
     * Errors are caught and ignored so a failing prefix provider can
     * never block the actual LLM request.
     */
    skillPrefix?: (query: string, signal?: AbortSignal) => string | Promise<string>;
    /**
     * Optional callback that produces extra system-prompt text to
     * prepend on each {@link prompt} call. Same shape as
     * {@link systemPromptSuffix} but the returned text lands *before*
     * {@link systemPrompt} (separated by a blank line).
     *
     * Used for fragments whose placement matters — e.g. the skills
     * catalogue (see `src/skills/skill-catalogue.ts`), which benefits
     * from being at the very top of the system prompt so the model's
     * attention to "STEP 0: scan skills" isn't diluted by the
     * surrounding rules/HINTS/DELEGATION blocks.
     *
     * Errors are caught and ignored so a failing prefix provider can
     * never block the actual LLM request. Aborts (DOMException with
     * `name === 'AbortError'`) propagate to the surrounding flow as
     * usual.
     *
     * Legacy compatibility: prefer {@link memoryPrefix} + {@link skillPrefix}
     * for granular token tracking.  When both new callbacks are
     * omitted but this one is set, the old behaviour is preserved.
     */
    systemPromptPrefix?: (query: string, signal?: AbortSignal) => string | Promise<string>;
    /**
     * Optional callback that produces extra system-prompt text to
     * append on each {@link prompt} call. Receives the current user
     * input so providers can adapt the appended text to the turn.
     *
     * The returned text is appended to {@link systemPrompt} separated
     * by a blank line; returning '' (or `undefined`) leaves the
     * system prompt unchanged.
     *
     * Errors are caught and ignored so a failing suffix provider can
     * never block the actual LLM request. Aborts (DOMException with
     * `name === 'AbortError'`) propagate to the surrounding flow as
     * usual.
     */
    systemPromptSuffix?: (query: string, signal?: AbortSignal) => string | Promise<string>;
    /**
     * Optional short label identifying this ChatStream instance for
     * diagnostic logs (e.g. `"main"` for the orchestrator's main agent
     * or a sub-agent's name like `"vault_inspector"`). Pure cosmetic —
     * appears as the `agent=…` field in `console.debug` lines emitted
     * around tool-set construction and LLM dispatch, so a single
     * console capture can be untangled into per-agent flows. Default
     * `"agent"` keeps single-agent callers (tests, ad-hoc usage) from
     * needing to supply a value.
     */
    agentLabel?: string;
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
     * Called when a tool execution produces generated assets
     * (e.g. images saved to the vault). Receives the structured asset
     * metadata so the session-level {@link GeneratedAssetCollection}
     * can update in real time without polling.
     */
    onAssetGenerated?: (assets: GeneratedAsset[]) => void;

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
     *
     * The optional `signal` is the current turn's AbortSignal. Implementers
     * that block on user input (e.g. an in-UI Allow / Reject dialog) MUST
     * observe this signal and reject the returned promise with an
     * `AbortError` (DOMException) when the user aborts mid-confirmation —
     * otherwise the prompt loop deadlocks waiting on a decision that the
     * user has already implicitly cancelled by hitting "stop". Implementers
     * are also responsible for cleaning up any UI / map entries they
     * registered for this message id when handling abort.
     */
    onConfirmToolCall?: (args: {
        toolName: string;
        toolArgs: Record<string, unknown>;
        messageId: string;
        signal?: AbortSignal;
    }) => Promise<boolean>;

    /**
     * Called when the context compressor is about to invoke the summarizer
     * LLM — i.e. all threshold checks have passed and compression will
     * actually run (zero false-positive risk). Fires right before the
     * (potentially slow, 15–40 s) LLM call so the UI can surface a
     * transient status update.
     */
    onSummarizing?: () => void;

    /**
     * Called when context compression occurs during a prompt call.
     * This happens when the conversation history exceeds the token threshold
     * and older messages are summarized.
     */
    onContextCompressed?: () => void;

    /**
     * Called when the context compressor's emergency shrink ran on this
     * turn — i.e. the assembled prompt was still above 1.5× threshold
     * after primary compression, and one or more freshly-returned
     * tool_results had to be truncated to fit the budget.
     *
     * Separate from {@link onContextCompressed} because the user-facing
     * implications are different: regular compression is invisible
     * (older messages already had their gist captured in summaries),
     * while emergency shrink drops detail the model hasn't read yet,
     * which can affect this turn's reply quality. The runtime/view
     * layer uses this to surface a one-shot Notice so the user can
     * raise their threshold or pick a larger-context model.
     */
    onEmergencyShrink?: () => void;

    /**
     * Per-profile overrides for the context compressor.
     *
     * Populated by the factory that constructs a ChatStream for a particular
     * provider profile (see `chat-factory.ts`). When omitted, the compressor
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
    compressionOptions?: Pick<ContextCompressionOptions,
        'compressionThreshold' | 'slidingWindowSize' | 'maxSummariesThreshold' | 'modelContextWindow'
    >;

    /**
     * Returns the per-session artifact store this ChatStream should use
     * when the context compressor's shrink stage spills inline envelope
     * fields (B-1, plan §1.5) into out-of-prompt storage. The store
     * is owned by the {@link SessionRuntime}; passing a getter (vs. a
     * direct field) mirrors the dynamic-tools / artifact-promotion
     * wiring on `AgentOrchestratorConfig` and lets the runtime swap the
     * store on rebuild without leaking stale references through this
     * config object.
     *
     * Returning `null` (or omitting the callback) disables envelope
     * spilling: the compressor falls back to the legacy generic JSON
     * truncation path. Single-agent mode (no `delegate_task`) sees no
     * envelopes and so this is a no-op for it; the field is hoisted
     * here from `AgentOrchestratorConfig` purely so the compressor call
     * inside `ChatStream.prompt()` can read it without a downcast or
     * a separate field on the orchestrator.
     */
    getArtifactStore?: () => ArtifactStore | null;

    /**
     * Resolve a cached attachment file to a base64-carrying
     * {@link MediaAttachment} ready for the LLM provider.
     *
     * Called during {@link _rebuildApiMessages} for user messages
     * that carry {@link ChatMessage.attachments}. The callback
     * performs vault-adapter I/O internally; ChatStream itself
     * remains filesystem-free.
     *
     * Returning `null` silently skips the attachment (e.g. the
     * cache file was deleted). Providers that don't support the
     * attachment's MIME type also skip it downstream.
     */
    resolveAttachment?: (
        cachePath: string,
        mimeType: string,
        fileName: string,
    ) => Promise<MediaAttachment | null>;
}

// ─────────────────────────────────────────────
// Context breakdown for fine-grained statistics
// ─────────────────────────────────────────────

/**
 * Estimated token counts for each layer of the system prompt,
 * computed during {@link ChatStream._buildEffectiveSystemPrompt}.
 * All values are through {@link estimateTokens} — deliberately not
 * exact tokenizer output so the cost is zero on the hot path.
 */
export interface SystemPromptBreakdown {
    /** Memory layer (from {@link ChatStreamConfig.memoryPrefix}) */
    memory: number;
    /** Skill catalogue layer (from {@link ChatStreamConfig.skillPrefix}) */
    skills: number;
    /** Static system prompt (from {@link ChatStreamConfig.systemPrompt}) */
    baseline: number;
    /** Per-turn suffix (from {@link ChatStreamConfig.systemPromptSuffix}) */
    suffix: number;
}

/**
 * Per-turn context composition breakdown.
 *
 * Populated during {@link ChatStream.prompt} and exposed via
 * {@link IChatAgent.contextBreakdown}.  Values are heuristic
 * estimates — use them for relative-proportion analysis, not
 * for byte-precise budget calculation.
 */
export interface ContextBreakdown {
    /** System prompt segmented by layer */
    systemPrompt: SystemPromptBreakdown;
    /** Raw conversation history (user / assistant / tool messages) */
    conversation: {
        user: number;
        assistant: number;
        tool: number;
    };
    /** Compressed summaries injected into the context */
    summaries: number;
    /** Tool schema JSON sent with the request */
    toolSchemas: number;
}

// ─────────────────────────────────────────────

/** Internal result type returned by _processStream */
export interface StreamResultInternal {
    content: string;
    reasoningContent: string;
    toolCalls: CompleteToolCall[] | null;
    finishReason: string | null;
    usage: TokenUsage | null;
    /** Thought signatures from the provider (e.g., Gemini thinking models) */
    thoughtSignatures?: string[];
}

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

    /**
     * Optional opaque tag used for logging / audit attribution.
     * Not part of the chat semantics. See {@link ChatStream.contextTag}.
     */
    contextTag?: string;

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
            /**
             * Tunable parameters for embedding-based on-demand tool filtering.
             * Only consulted when `embedding` is also supplied. Missing fields
             * fall back to plugin defaults at use-site.
             */
            embeddingFilter?: ToolFilterOptions;
            /**
             * Called synchronously after the user message has been created
             * and appended to the agent's message history, but before any
             * provider work begins. Used by the view to render the user
             * bubble using the agent's own message id (which it needs in
             * order to support future operations like branching). Receives
             * a shallow copy so callers can hold the reference without
             * worrying about mutation from inside the agent.
             */
            onUserMessage?: (userMessage: ChatMessage) => void;
            /**
             * Model identifier for this turn (e.g. "gpt-4o"). Stored on
             * the resulting assistant message so the model is visible in
             * the UI and persisted to session JSON.
             */
            modelName?: string;
            /**
             * User-pasted image attachments for this turn.
             * Stored as cache-path references on the ChatMessage;
             * resolved to base64 on demand when building API messages.
             */
            attachments?: ChatAttachment[];
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

    /**
     * Per-turn context composition breakdown — shows how the last
     * assembled prompt was split across system layers (memory,
     * skills, baseline, suffix), conversation history, summaries,
     * and tool schemas.
     *
     * Updated at the start of every `prompt()` call (before the
     * first provider stream).  `undefined` when no turn has run yet.
     */
    readonly contextBreakdown?: ContextBreakdown;

    /**
     * Restore a context breakdown from persisted cache data
     * (e.g. when re-opening a session where debug-mode persistence
     * was enabled).  Only meaningful for the UI status panel; does
     * not affect the chat flow.
     */
    restoreContextBreakdown?(breakdown: ContextBreakdown): void;

    // ── QuickAsk side-turns (追问) ──

    /**
     * Execute a QuickAsk side-turn: a simple, non-streaming, tool-free
     * LLM call anchored to a specific assistant message. Returns the
     * assistant's reply ChatMessage.
     */
    promptQuickAsk?(
        parentMessageId: string,
        userInput: string,
        modelConfig: MinimalModelConfig,
    ): Promise<ChatMessage>;

    /** Get all QuickAsk side-turns for this session. */
    getQuickAskTurns?(): QuickAskTurn[];

    /** Restore QuickAsk side-turns from persisted data. */
    restoreQuickAskTurns?(turns: QuickAskTurn[]): void;

    /** Remove a QuickAsk turn by its unique turn ID. */
    removeQuickAskTurn?(turnId: string): void;
}

// Re-export ContextCompressionOptions for convenience
export type { ContextCompressionOptions } from "./context-compression";
