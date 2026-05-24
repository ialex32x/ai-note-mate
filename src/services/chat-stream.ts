import { ContextReducer, ConversationSummary, estimateTokens, type ContextReduceOptions } from "./context-reducer";
// Re-export ConversationSummary for external consumers (e.g., SessionManager)
export type { ConversationSummary } from "./context-reducer";
// Re-export ContextReduceOptions so callers can construct the per-profile
// override structure without reaching into the reducer module directly.
export type { ContextReduceOptions } from "./context-reducer";
import type { MinimalModelConfig } from "./llm-provider";
import type { ArtifactStore } from "./artifact-store";
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
import { retrieve, isQueryTooShort } from "./retriever";
import { recordIssue } from "./diagnostics/issue-tracer";
import { getLocale, tIn } from "../i18n";

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
 * Build the text used to embed a tool for similarity ranking.
 *
 * Composition (newline-separated):
 *   1. `function.name` — usually a strong, language-neutral signal
 *      (e.g. `vault_grep_file`, `web_search`).
 *   2. {@link RegisteredTool.embeddingDescription} when present, otherwise
 *      `function.description` — the bulk of the semantic payload.
 *   3. Top-level parameter names, when discoverable from
 *      `function.parameters.properties` — surfaces hints the description
 *      may not spell out (e.g. `tags`, `query`, `path`).
 *   4. Multilingual trigger keywords from the locale bundle (see
 *      {@link buildToolTriggerLine}) — gives BM25 lexical traction on
 *      queries in the user's UI language even when the (English)
 *      description shares zero tokens with them.
 *
 * Step 4 is ranker-only: the model still sees the original English
 * `function.description` in the schema. Keeping the schema language-
 * stable avoids any risk of locale-dependent tool-calling regressions
 * in providers that were trained predominantly on English function
 * specs.
 *
 * Changes to this composition invalidate the embedder's per-text cache
 * (entries are keyed by sha256(text)). That's acceptable: a one-shot
 * re-embed of all on-demand tools on first use after the change.
 */
function buildToolEmbeddingText(tool: RegisteredTool): string {
    const fn = tool.schema.function;
    const description = tool.embeddingDescription ?? fn.description ?? '';
    const properties = fn.parameters['properties'];
    const paramNames = (properties && typeof properties === 'object' && !Array.isArray(properties))
        ? Object.keys(properties as Record<string, unknown>)
        : [];
    const paramLine = paramNames.length > 0 ? `Parameters: ${paramNames.join(', ')}` : '';
    const triggerLine = buildToolTriggerLine(fn.name);
    return [fn.name, description, paramLine, triggerLine].filter(Boolean).join('\n');
}

/**
 * Build a comma-separated trigger line for `schemaName` by looking up
 * `tool.triggers.<schemaName>` in the active locale bundle AND in the
 * English bundle.
 *
 * Why concatenate both:
 *   - The active locale's keywords cover queries written entirely in
 *     the user's UI language (typical CJK chat-style prompts).
 *   - The English keywords cover the very common mixed-language case
 *     ("帮我 search markdown 文件", "RSSフィード を fetch して") that
 *     non-English users naturally produce around tech terms.
 *
 * Tools without an entry (most MCP-supplied tools, long-tail built-in
 * tools we haven't authored yet) yield an empty string and degrade
 * silently — they still benefit from the description-based ranking
 * just as before.
 *
 * The BM25 tokenizer treats commas as separators, so the exact
 * delimiter doesn't carry semantic weight; the comma+space form is
 * picked purely for readability when the composed text shows up in
 * debug logs.
 */
function buildToolTriggerLine(schemaName: string): string {
    const key = `tool.triggers.${schemaName}`;
    const currentLocale = getLocale();
    const cur = tIn(currentLocale, key);
    const en = tIn('en', key);
    // `tIn` returns the key verbatim when the entry is missing — that's the
    // sentinel for "no triggers here, skip silently". The empty-string check
    // is defensive against a future locale entry that's authored as `''`
    // (which would otherwise yield `Triggers: , <en>` with a stray comma).
    const parts: string[] = [];
    if (cur && cur !== key) parts.push(cur);
    // Skip the English bundle when the active locale entry is already the
    // English string (active locale IS 'en', or a translator happened to
    // copy the English value verbatim) — avoids duplicating the same tokens.
    if (en && en !== key && en !== cur) parts.push(en);
    return parts.length > 0 ? `Triggers: ${parts.join(', ')}` : '';
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
     * Called when the context reducer is about to invoke the summarizer
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
     * Called when the context reducer's emergency shrink ran on this
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
        'compressionThreshold' | 'slidingWindowSize' | 'maxSummariesThreshold' | 'modelContextWindow'
    >;

    /**
     * Returns the per-session artifact store this ChatStream should use
     * when the context reducer's shrink stage spills inline envelope
     * fields (B-1, plan §1.5) into out-of-prompt storage. The store
     * is owned by the {@link SessionRuntime}; passing a getter (vs. a
     * direct field) mirrors the dynamic-tools / artifact-promotion
     * wiring on `AgentOrchestratorConfig` and lets the runtime swap the
     * store on rebuild without leaking stale references through this
     * config object.
     *
     * Returning `null` (or omitting the callback) disables envelope
     * spilling: the reducer falls back to the legacy generic JSON
     * truncation path. Single-agent mode (no `delegate_task`) sees no
     * envelopes and so this is a no-op for it; the field is hoisted
     * here from `AgentOrchestratorConfig` purely so the reducer call
     * inside `ChatStream.prompt()` can read it without a downcast or
     * a separate field on the orchestrator.
     */
    getArtifactStore?: () => ArtifactStore | null;
}

// ─────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────

/**
 * Per-chunk throttle interval (ms) for streaming UI updates inside
 * {@link ChatStream._processStream}. When a provider emits stream
 * chunks faster than this (e.g. Gemini Flash, Groq, local llama.cpp
 * on a fast model can do hundreds per second), chunks arriving within
 * the same window have their `onMessageUpdate` emit coalesced — only
 * the most-recent state is forwarded downstream, the rest are dropped.
 *
 * Safe to drop intermediate emits because every emit carries the
 * *latest full snapshot* of `streamingMessage` (not a delta), and the
 * post-loop final emit unconditionally fires with the terminal state
 * — so no content is ever lost, and the on-screen "latest text" never
 * lags by more than one window.
 *
 * 30 ms sits well below the rendering controller's own 100 ms (or
 * 400 ms for large content) throttle, so this does NOT change the
 * on-screen update cadence. Its purpose is to cut the per-chunk
 * synchronous callback chain (runtime.emit → view.handleMessageUpdate
 * → bubble re-render dispatch → streaming-controller.update), which
 * fires for every chunk even when the next render is already pending.
 * On hot streams that chain was costing several milliseconds per
 * chunk × hundreds of chunks per second, fully saturating the main
 * thread before the renderer even got a turn.
 */
const STREAM_EMIT_THROTTLE_MS = 30;

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
    // ── Public fields ───────────────────────────────────────────────────────

    /**
     * Optional opaque tag attached to this ChatStream for logging /
     * auditing purposes. Not used by the chat flow itself.
     *
     * Today it is populated by `createSessionRuntime` with the sessionId
     * so that side-effects triggered from within a tool (e.g. vault file
     * mutations recorded into the AI file-changes log) can be attributed
     * back to the session the user is chatting in. Sub-agents inherit
     * the value from the orchestrator before their `execute()` runs.
     */
    contextTag?: string;

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
     * Find a registered tool (static or dynamic) by its schema name.
     *
     * Returns `undefined` if no tool with that name is currently registered.
     * Dynamic tools are recomputed on every call via `config.dynamicTools()`
     * so callers always see the latest set (matches what `prompt()` itself
     * resolves against).
     *
     * Intended for external coordinators — notably
     * `AgentOrchestrator.onToolCall` — that need to dispatch a tool the
     * embedding-based on-demand filter happened to hide from the model
     * this iteration: without this lookup the coordinator would have to
     * refuse the call (returning "Unknown tool"), even though we have a
     * perfectly good handler sitting one layer down.
     */
    findRegisteredTool(name: string): RegisteredTool | undefined {
        const staticHit = this._tools.find(t => t.schema.function.name === name);
        if (staticHit) return staticHit;
        const dynamics = this._config.dynamicTools?.() ?? [];
        return dynamics.find(t => t.schema.function.name === name);
    }

    /**
     * Dispatch a registered tool by name using this ChatStream's current
     * abort controller, returning the raw {@link ToolCallResult} (callers
     * are responsible for serialisation via
     * {@link ChatStream.serialiseToolResult}).
     *
     * Throws if no tool with that name is registered (see
     * {@link findRegisteredTool} for the lookup contract).
     *
     * This deliberately bypasses the per-turn call-budget enforcement and
     * confirmation flow that the main `prompt()` loop runs around
     * `registered.exec`: those policies live in the loop because they're
     * scoped to a single user-message turn that the loop owns. A
     * fallback dispatch from outside the loop (e.g.
     * `AgentOrchestrator.onToolCall`) has no clean way to participate in
     * that bookkeeping, and an MCP / web-search tool slipping past the
     * budget is strictly better UX than refusing the call with a stale
     * "Unknown tool" error. If you need budgeted dispatch, route through
     * `prompt()` instead.
     */
    async invokeRegisteredTool(
        name: string,
        args: Record<string, unknown>,
        context: { toolCallId: string; toolCallMessage: ChatMessage },
    ): Promise<ToolCallResult> {
        const tool = this.findRegisteredTool(name);
        if (!tool) {
            throw new Error(`No registered tool named "${name}".`);
        }
        return tool.exec(this, args, this._abortController?.signal, context);
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
            /**
             * Tunable parameters for embedding-based on-demand tool filtering.
             * Only consulted when `embedding` is also supplied.
             */
            embeddingFilter?: ToolFilterOptions,
            /**
             * Synchronous notification fired after the user message is
             * created and appended to history, before any provider work
             * starts. See {@link IChatAgent.prompt} for rationale.
             */
            onUserMessage?: (userMessage: ChatMessage) => void,
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

        // Notify the caller that the user message now exists with a stable
        // id. The view uses this to render the user bubble keyed by the
        // agent's id (rather than a separately-minted "optimistic" id),
        // which keeps follow-on operations like branching working. Pass a
        // shallow copy so the caller can store the reference without risk
        // of cross-mutation. Defer any handler exception so it cannot
        // corrupt this prompt() call — the user message is already in
        // history and the provider request must still go out.
        if (options.onUserMessage) {
            try {
                options.onUserMessage({ ...userMessage });
            } catch (err) {
                console.error('[ChatStream] onUserMessage handler threw:', err);
            }
        }

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
        // Resolve the effective system prompt for this turn. Static
        // `systemPrompt` is the baseline; `systemPromptPrefix` /
        // `systemPromptSuffix` can wrap a per-turn, query-aware fragment
        // around it (e.g. an embedding-shortlisted skill catalogue at
        // the very top — see `src/skills/skill-catalogue.ts`). Prefix /
        // suffix failures degrade silently to the baseline so a broken
        // provider can never block the LLM call. The final order is:
        //   [prefix] · "\n\n" · [baseline] · "\n\n" · [suffix]
        // with empty segments simply dropped from the join.
        const baseline = this._config.systemPrompt ?? '';
        const segments: string[] = [];

        if (this._config.systemPromptPrefix) {
            try {
                const prefix = await this._config.systemPromptPrefix(
                    userInput,
                    this._abortController?.signal,
                );
                if (prefix) segments.push(prefix);
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    throw err;
                }
                console.warn('ChatStream: systemPromptPrefix threw, falling back to base prompt', err);
            }
        }

        if (baseline) segments.push(baseline);

        if (this._config.systemPromptSuffix) {
            try {
                const suffix = await this._config.systemPromptSuffix(
                    userInput,
                    this._abortController?.signal,
                );
                if (suffix) segments.push(suffix);
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') {
                    throw err;
                }
                console.warn('ChatStream: systemPromptSuffix threw, falling back to base prompt', err);
            }
        }

        const effectiveSystemPrompt = segments.join('\n\n');

        const rawMessages: ChatMessageParam[] = [];
        if (effectiveSystemPrompt) {
            rawMessages.push({ role: "system", content: effectiveSystemPrompt });
        }
        for (let i = 0; i < this._messages.length; i++) {
            const msg = this._messages[i]!;
            if (msg.role === "user") {
                rawMessages.push({ role: "user", content: msg.content, id: msg.id });
                continue;
            }
            if (msg.role === "assistant" || msg.role === "tool_call") {
                // The assistant turn that emitted these tool calls. May
                // be the current message (text-or-thinking + toolCalls
                // turn — assistant pushed to `_messages`), or absent
                // (pure tool-call turn — `isPureToolCallTurn` skipped
                // pushing the assistant to avoid an empty UI bubble).
                //
                // For the "absent" case we synthesise a stand-in
                // assistant with empty content, so the reconstructed
                // sequence still satisfies the protocol invariant the
                // pre-sanitiser checks ("every tool_result has an
                // assistant(toolCalls) owner with a matching id").
                //
                // Without this synthesis, every pure tool-call turn's
                // tool_calls fall through the original `else` branch,
                // get silently dropped, and on the NEXT prompt() call
                // the model sees no record of having invoked any
                // tool — i.e. it "forgets" the search/read it just
                // performed and re-fires the same tools on the next
                // user turn. Combined with a sub-agent's already-
                // narrow loop budget this surfaces as the agent
                // "走两步就忘": after a couple of pure-tool-call
                // iterations the conversation is reduced to a stub
                // and the model falls back to its initial reflex.
                const isAssistantNode = msg.role === "assistant";
                const assistantContent = isAssistantNode ? msg.content : "";
                const assistantId = isAssistantNode ? msg.id : undefined;
                const assistantThinking = isAssistantNode ? msg.thinkingContent : undefined;

                const toolCalls: NonNullable<ChatMessageParam["toolCalls"]> = [];
                const toolResultParams: ChatMessageParam[] = [];
                let j = isAssistantNode ? i + 1 : i;
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

                // Skip degenerate orphans: a `tool_call` node with no
                // valid meta+result pair wouldn't add anything useful
                // to the prompt and would synthesise an empty
                // assistant — which pre-sanitize would then drop. Bail
                // before mutating rawMessages so the outer loop just
                // moves on.
                if (!isAssistantNode && toolCalls.length === 0) {
                    i = j - 1;
                    continue;
                }

                rawMessages.push({
                    role: "assistant",
                    content: assistantContent,
                    id: assistantId,
                    thinkingContent: assistantThinking,
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                });
                for (const tr of toolResultParams) rawMessages.push(tr);
                // Skip the consumed tool_call messages on the outer loop.
                i = j - 1;
                continue;
            }
            // Other roles (system, etc.): skip.
        }

        // Filter tools based on allowed capabilities
        const allowedCapabilities = options?.allowedCapabilities;

        // Collect static (registered) tools and dynamic tools
        const dynamicTools = this._config.dynamicTools?.() ?? [];
        const allTools = [...this._tools, ...dynamicTools];

        // Capability filtering is independent of embedding-based filtering
        // and doesn't change within a single prompt() call, so we compute it
        // once up-front. Embedding-based filtering runs separately at the
        // top of every tool-call loop iteration (see below).
        const capabilityFilteredTools: RegisteredTool[] = allowedCapabilities
            ? allTools.filter(tool => {
                // If tool has no capabilities declared, allow it (backward compatibility)
                if (!tool.capabilities || tool.capabilities.length === 0) {
                    return true;
                }
                // Tool is allowed if ALL its capabilities are in the allowed list
                return tool.capabilities.every(cap => allowedCapabilities.includes(cap));
            })
            : allTools;

        try {
            let finalMessage: ChatMessage | null = null;

            // Per-turn tool-call counter, used to enforce each tool's
            // `maxCallsPerTurn` budget (see RegisteredTool). Scoped to this
            // single prompt() invocation so the counter resets cleanly when
            // the user sends the next message. Sub-agents have their own
            // ChatStream → their own counter, so their budgets don't share
            // with the main agent's.
            const toolCallCounts = new Map<string, number>();

            // Most recent assistant content from the previous loop iteration,
            // used to enrich the embedding-filter query so subsequent tool-call
            // rounds can surface tools matching the model's *current* next-step
            // intent (e.g. user asks "summarize my notes" → after reading,
            // assistant says "Now I'll write the summary" → write_file is
            // re-included by the next round's filter). Empty on the first
            // iteration so the first filter pass uses the raw user input.
            let lastAssistantText = '';
            // Holds the currently-applicable filtered tool set across the loop.
            // Recomputed at the top of every iteration. Declared outside the
            // loop so error reporting (filteredTools.find for handler lookup,
            // etc.) can reference the latest value.
            let filteredTools: RegisteredTool[] = capabilityFilteredTools;
            // Sticky on-demand tools: schema names of on-demand tools the
            // model has actually invoked at least once during this turn.
            // Once a tool is used, it gets re-added to `filteredTools` on
            // every subsequent iteration regardless of embedding-filter
            // score. Rationale: the model's deliberate choice to call a
            // tool is a far stronger signal than any future iteration's
            // similarity query (which mixes user input with assistant
            // narration that has likely drifted toward "discuss the
            // result" rather than "describe the tool"). Without this,
            // a tool that was relevant on round 1 can silently disappear
            // on round 2, leaving the model with the tool name still in
            // its conversation history and no handler to dispatch to —
            // exactly the "Unknown tool" loop we want to avoid.
            //
            // Only on-demand tools are tracked; always-on tools are never
            // filtered to begin with, so stickiness would be a no-op.
            const stickyOndemandToolNames = new Set<string>();

            // Tool-call loop: keep requesting until no more tool calls
            while (true) {
                // Per-iteration abort guard. The downstream work in this
                // iteration — embedding filter, context reduction, provider
                // stream creation — each propagates the abort signal on
                // their own, but `await`-ing through them between user
                // input and the actual provider call still costs a few
                // hundred ms even on the happy path. Bailing out here lets
                // a user-initiated abort that lands between iterations
                // unwind immediately instead of paying for those steps
                // (and lets the abort visibly take effect before the next
                // provider call's response window). The deeper checks
                // remain so a mid-iteration abort during the in-flight
                // embed / reduce / stream still unwinds promptly.
                if (!this._abortController || this._abortController.signal.aborted) {
                    throw new DOMException("Aborted", "AbortError");
                }

                // Re-run embedding-based filtering on every iteration so the
                // on-demand tool set reflects the model's current direction.
                // Tool descriptions are cached inside the shared Embedder, so
                // this adds at most one embedding call per iteration whose
                // query string differs from the previous one (cap the
                // assistant text portion to keep the query compact).
                const filterQuery = lastAssistantText
                    ? `${userInput}\n${lastAssistantText.slice(0, 300)}`
                    : userInput;
                const matchedTools = await this._getBestMatchedTools(
                    options.embedding,
                    filterQuery,
                    capabilityFilteredTools,
                    options.embeddingFilter,
                    this._abortController?.signal,
                );

                // Re-add any sticky on-demand tools the embedding filter
                // dropped this round. See `stickyOndemandToolNames` doc
                // above for rationale; this is the enforcement step.
                if (stickyOndemandToolNames.size > 0) {
                    const matchedNames = new Set(matchedTools.map(t => t.schema.function.name));
                    for (const tool of capabilityFilteredTools) {
                        const name = tool.schema.function.name;
                        if (stickyOndemandToolNames.has(name) && !matchedNames.has(name)) {
                            matchedTools.push(tool);
                        }
                    }
                }
                filteredTools = matchedTools;

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
                            // B-1: pass the per-session artifact store so the
                            // shrink stage can spill historical delegate
                            // envelopes' inline `result` / `extras` into
                            // out-of-prompt storage. `?? undefined` keeps
                            // legacy semantics when the runtime / single-agent
                            // mode doesn't supply a store.
                            artifactStore: this._config.getArtifactStore?.() ?? undefined,
                        },
                        // Forward the per-turn AbortSignal so the
                        // (potentially slow, 15–40 s) summarizer LLM
                        // call can be interrupted by the global stop
                        // button. Without this, the abort response is
                        // delayed by the full summarization round-trip
                        // before the next provider call observes the
                        // already-aborted signal and unwinds.
                        this._abortController?.signal,
                        // Notify that summarization is about to begin
                        this._config.onSummarizing,
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
                    if (reduceResult.emergencyShrunk) {
                        this._config.onEmergencyShrink?.();
                    }
                } else {
                    // console.log("no summarizer configured, skipping context reduction");
                }

                // Per-LLM-call tool-count log. Emitted on every iteration
                // of the tool-call loop (one line per outgoing provider
                // request) so a multi-round turn produces one line per
                // round. The label distinguishes main agent vs. each
                // sub-agent in a mixed orchestration trace; the comma-
                // separated names let us spot embedding/capability filter
                // surprises at a glance without diffing against the
                // detailed score table above.
                const agentLabel = this._config.agentLabel ?? 'agent';
                console.debug(
                    `[agent="${agentLabel}"] sending ${toolSchemas.length} tool(s) to LLM` +
                    (toolSchemas.length > 0
                        ? `: ${toolSchemas.map(s => s.function.name).join(', ')}`
                        : ''),
                );

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
                    // Capture per-call total (NOT cumulative) for context-window
                    // usage percentage calculation in the UI.
                    this._sessionTokenUsage.lastCallTotalTokens = result.usage.totalTokens;
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

                        // Find the registered handler.
                        //
                        // Two-stage lookup:
                        //
                        //   1) `filteredTools.find(...)` — the tool was offered
                        //      to the model this iteration (passed both capability
                        //      and embedding filters). This is the normal case.
                        //
                        //   2) Fallback: the model called a tool that did NOT
                        //      pass the embedding filter this iteration, but is
                        //      otherwise capability-allowed. This happens when
                        //      the model recalls a tool from system-prompt or
                        //      conversation memory whose description didn't
                        //      score well against the current query. We MUST
                        //      dispatch it anyway: refusing to (the previous
                        //      behaviour) left the tool_call message stuck in
                        //      `streaming: true` forever because the throw at
                        //      the bottom of this branch bypassed finalization,
                        //      producing the "handoff bubble shows `…`
                        //      forever, never gets a ✓/✕" bug — see
                        //      `_finalizeStuckToolCallMessages` for the
                        //      defensive safety net that catches the symptom.
                        //
                        // Capability-rejected tools are deliberately NOT
                        // recovered: a profile that disabled e.g. `write_file`
                        // wants the call refused, not silently honoured.
                        const filterHit = filteredTools.find((t) => {
                            return t.schema.function.name === toolName;
                        });
                        const registered: RegisteredTool | undefined = filterHit
                            ?? capabilityFilteredTools.find(
                                t => t.schema.function.name === toolName,
                            );
                        const recoveredFromFilterMiss = !filterHit && !!registered;

                        // ── Sticky on-demand bookkeeping ───────────────────
                        // The model has now invoked this tool — mark it
                        // sticky so the next iteration's embedding filter
                        // cannot drop it out from under us. We mark on the
                        // *registered hit* (not after successful exec) so
                        // budget-blocked / arg-parse-error attempts still
                        // count: the model demonstrated interest, and
                        // keeping the tool visible lets it retry with
                        // corrected args instead of hallucinating around
                        // a now-invisible schema. Always-on tools never
                        // need stickiness (they're never filtered) so
                        // gate on `ondemand`. This also applies to the
                        // recovered path: if we just rescued a filtered-out
                        // tool, pin it for the rest of the turn so the
                        // model gets a stable schema on follow-up calls.
                        if (registered?.ondemand) {
                            stickyOndemandToolNames.add(toolName);
                        }

                        // ── Filter-miss telemetry ──────────────────────────
                        // When the model calls a tool that is *registered* on
                        // this agent (passes capability filtering) but didn't
                        // make it through embedding-based filtering, log a
                        // debug line. We now dispatch it instead of throwing
                        // (see the two-stage lookup above), but the breadcrumb
                        // is still the single most useful signal for
                        // diagnosing "AI suddenly can't do X" reports — it
                        // pinpoints whether the threshold / topK / tool
                        // description quality should be tuned. Capability-
                        // rejected tools and genuinely-unregistered names are
                        // excluded; they are not embedding-filter misses.
                        if (recoveredFromFilterMiss) {
                            console.debug(
                                `[embedding tool filter] miss recovered: model called "${toolName}" `
                                + `but it was filtered out (capability-allowed, dispatching directly; `
                                + `consider lowering threshold or revising its description)`,
                            );
                        }

                        // ── Per-turn call-budget enforcement ────────────────
                        // Bump the counter *before* dispatch so that hard
                        // blocks see consistent numbers across the parse-error
                        // and dispatch paths. Counting parse-error attempts is
                        // intentional: it prevents a tool that keeps emitting
                        // malformed args from spinning forever.
                        const callCountAfter = (toolCallCounts.get(toolName) ?? 0) + 1;
                        toolCallCounts.set(toolName, callCountAfter);
                        const budget = registered?.maxCallsPerTurn;
                        const hardLimit = budget?.hard;
                        const softLimit = budget?.soft;
                        const hardBlocked = typeof hardLimit === 'number' && callCountAfter > hardLimit;
                        const softTripped = !hardBlocked
                            && typeof softLimit === 'number'
                            && callCountAfter > softLimit;
                        // Pre-compose the reminder once so we can append it
                        // uniformly on whichever success path executes below.
                        const softReminder = softTripped
                            ? `\n\n[Note: tool "${toolName}" has been called ${callCountAfter} times in this turn` +
                              (typeof hardLimit === 'number' ? ` (hard limit ${hardLimit})` : '') +
                              `. You very likely have enough material now — synthesize an answer from what you already have instead of calling this tool again.]`
                            : null;

                        let toolResult: string;
                        let mediaAttachment: MediaAttachment | null = null;

                        if (hardBlocked) {
                            // Refuse to invoke the tool at all. The synthetic
                            // error gives the model a concrete instruction so
                            // it stops re-trying (instead of inferring "the
                            // tool just failed, let me call it once more").
                            toolResult = `Error: Tool "${toolName}" reached its per-turn call limit (${hardLimit}). ` +
                                `Do NOT call this tool again in this turn. Synthesize an answer from the results you already have, ` +
                                `try a different approach, or ask the user to clarify.`;
                        } else if (argParseError) {
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
                                // Known-bug surface: this is the "unhandled
                                // tool" mid-turn throw that historically left
                                // handoff / sub-agent bubbles stuck at `…`.
                                // The throw is preserved (the bubble safety
                                // net needs it), but we add a tracer record
                                // so mobile users see something more concrete
                                // than the generic "no result captured" text.
                                recordIssue({
                                    severity: 'error',
                                    source: 'chat-stream',
                                    code: 'unhandled-tool',
                                    message:
                                        `Tool "${toolName}" was called but no handler is registered and ` +
                                        `no onToolCall callback is provided. The dispatch loop will throw, ` +
                                        `which may leave the tool_call bubble stuck pending a safety-net finalize.`,
                                    context: {
                                        toolName,
                                        toolCallId,
                                        messageId: toolCallMessage.id,
                                    },
                                });
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
                                        signal: this._abortController?.signal,
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
                                if (err instanceof DOMException && err.name === 'AbortError') {
                                    // Finalize the in-flight tool_call message before
                                    // unwinding. Without this the bubble stays stuck
                                    // in `streaming: true` with `toolCallResult ===
                                    // undefined` — i.e. only the ARGUMENTS section
                                    // renders, the RESULT section is silently
                                    // omitted, and the user reasonably reads that
                                    // as "the tool returned nothing" even though
                                    // the model never actually saw a result either.
                                    // See `renderToolCallContent` for the
                                    // `if (msg.toolCallResult)` gate this restores.
                                    //
                                    // Distinguish two abort sub-cases by looking at
                                    // confirmationState: when it's still 'pending',
                                    // the user aborted while the Allow / Reject
                                    // dialog was up — the tool never actually ran,
                                    // so the bubble should say so instead of
                                    // claiming an "interrupted execution" that
                                    // never started. We also clear the pending
                                    // state itself so the UI doesn't try to
                                    // re-render the dialog when this message is
                                    // restored from history later (streaming=false
                                    // already suppresses it on the live render,
                                    // but persisted snapshots round-trip the field).
                                    const wasAwaitingConfirm = toolCallMessage.confirmationState === 'pending';
                                    if (wasAwaitingConfirm) {
                                        toolCallMessage.confirmationState = 'rejected';
                                    }
                                    this._finalizeAbortedToolCallMessage(
                                        toolCallMessage,
                                        Date.now() - toolCallStartTime,
                                        wasAwaitingConfirm
                                            ? '[Aborted before confirmation: the tool was waiting for user approval and did not run.]'
                                            : '[Aborted during tool execution: the tool was interrupted before it could return a result.]',
                                    );
                                    throw err;
                                }
                                const error = err instanceof Error ? err : new Error(String(err));
                                toolResult = `Error: ${error.message}`;
                            }
                        }

                        // Check if aborted after tool execution
                        if (!this._abortController || this._abortController.signal.aborted) {
                            // Symmetric finalization for the "tool finished but the
                            // turn was aborted before we got to record the result"
                            // path. The exec itself ran to completion (we just
                            // can't surface its result to the model because the
                            // turn is being torn down), so the bubble would
                            // otherwise stay in the same "streaming forever"
                            // limbo as the catch path above. We mark this branch
                            // distinctly so the user can tell "the tool actually
                            // ran but its output was discarded" apart from "the
                            // tool itself was interrupted mid-flight".
                            this._finalizeAbortedToolCallMessage(
                                toolCallMessage,
                                Date.now() - toolCallStartTime,
                                '[Aborted after tool returned: the tool finished but the turn was interrupted before its result reached the model.]',
                            );
                            throw new DOMException("Aborted", "AbortError");
                        }

                        // Determine result status
                        const isError = toolResult.startsWith('Error:');
                        const resultStatus: 'success' | 'warning' | 'error' = isError ? 'error' : 'success';

                        // Soft-budget reminder: only attach on success so we
                        // don't dilute error messages, and so the model sees
                        // the nudge in the same payload as the data it just
                        // collected.
                        if (softReminder && !isError) {
                            toolResult = toolResult + softReminder;
                        }

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

                    // Capture the assistant's prose for the next iteration's
                    // re-filter query. Most tool-call turns include a brief
                    // narration (e.g. "Let me search for…", "现在我来创建文件") —
                    // a strong signal of what tools the next round will need.
                    // Falls back to '' when the turn was pure-tool-call;
                    // _getBestMatchedTools handles the empty/short case.
                    lastAssistantText = result.content ?? '';

                    // Continue the loop to let the AI process tool results
                    continue;
                }

                // No tool calls → conversation turn is complete
                break;
            }

            // Check if the stream ended due to an abort (some providers silently
            // end the iterator instead of throwing AbortError).
            const wasAborted = this._abortController?.signal.aborted ?? false;

            // Safety net: regardless of which epilogue runs below, the
            // turn is over and no further per-tool-call updates will
            // fire. Force-finalize any tool_call message that's still
            // visually stuck. See `_finalizeStuckToolCallMessages` for
            // why this exists (it's a defence against silent gaps in
            // the chat-pipeline message-update forwarding).
            this._finalizeStuckToolCallMessages();

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

            // Mirror the safety net from the normal-exit path: if the
            // turn unwound via a thrown error (including AbortError
            // that came through the throw channel rather than the
            // wasAborted flag), any tool_call message still flagged
            // streaming MUST be patched up here too. Skipping this
            // would leave the abort-via-throw path showing the same
            // "stuck …" bubbles the wasAborted path now avoids.
            this._finalizeStuckToolCallMessages();

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
    /**
     * Select which of `tools` should be exposed to the model for the current
     * request, based on cosine similarity between an embedding of `query` and
     * each on-demand tool's description.
     *
     * Behaviour:
     *   - Always-on tools (`ondemand: false`) are never filtered.
     *   - When `config` is undefined → no filtering; full `tools` returned.
     *   - When `query` is too short / signal-poor (see {@link isQueryTooShort})
     *     → no filtering; full `tools` returned. Prevents short follow-ups
     *     like "yes" / "继续" from collapsing the on-demand tool set.
     *   - When the global embedder isn't initialized or the embedding call
     *     throws → no filtering; full `tools` returned (the Embedder tracks
     *     the failure on its own status).
     *
     * The `query` parameter is intentionally generic: callers may pass the
     * raw user input on the first round, then enrich it with the most recent
     * assistant text on subsequent rounds (so the filter tracks the model's
     * current next-step intent, not just the original question).
     */
    /**
     * Finalize a tool_call message that is being torn down by an abort, so
     * its bubble doesn't stay stuck in `streaming: true` with no
     * `toolCallResult`. Used by both abort branches around tool dispatch:
     * one for `AbortError` thrown from inside `registered.exec`, the
     * other for the post-exec check that catches an abort signalled
     * while exec ran to completion. Without this finalization the UI
     * renders the bubble with only the ARGUMENTS section and silently
     * drops the RESULT section (see `renderToolCallContent`'s
     * `if (msg.toolCallResult)` gate) — which reads as "the tool
     * returned nothing", even though from the model's perspective the
     * call was simply never observed.
     *
     * Marks the call as a warning rather than an error: nothing
     * malfunctioned, the user just interrupted the flow.
     */
    private _finalizeAbortedToolCallMessage(
        toolCallMessage: ChatMessage,
        elapsedMs: number,
        note: string,
    ): void {
        toolCallMessage.streaming = false;
        const baseName = toolCallMessage.toolCallMeta?.toolName ?? toolCallMessage.content;
        toolCallMessage.content = `${baseName}  (${elapsedMs}ms, aborted)`;
        toolCallMessage.toolCallResult = {
            status: 'warning',
            result: note,
        };
        this._config.onMessageUpdate?.({ ...toolCallMessage });
    }

    /**
     * End-of-turn safety net: walk `_messages` and finalize any
     * `tool_call` message that's still flagged `streaming: true`.
     *
     * Background: under normal operation every tool_call reaches the
     * `toolCallMessage.streaming = false; toolCallMessage.toolCallResult = ...;
     * onMessageUpdate(...)` block in the dispatch loop before the
     * next iteration starts, and the bubble visibly transitions from
     * `name  …` to `name  (Xms)` with a ✓ / ✕ icon. But the chat
     * pipeline (chat-stream → SubAgent forwarder → orchestrator
     * bucket → runtime emit → session-view re-render) has many
     * hand-offs and an unrelated bug along it could silently swallow
     * the second emit — leaving a bubble visually stuck at `…` even
     * though the LLM-facing tool_result was delivered correctly.
     * That class of bug is exactly what the user reported for the
     * (legacy) `exchange` tool — the same hazard now applies to the
     * `write_handoff` / `read_handoff` / `list_handoff` tools.
     *
     * Re-emitting one final time at the end of the turn turns "stuck
     * forever" into "stuck for at most the turn's duration", which
     * is good enough to never confuse the user, and gives them a
     * console.warn breadcrumb to forward back so the real upstream
     * gap can be found and fixed.
     *
     * Idempotent: a no-op when the dispatch loop already finalized
     * everything (the common case).
     */
    private _finalizeStuckToolCallMessages(): void {
        for (const msg of this._messages) {
            if (msg.role !== 'tool_call') continue;
            if (!msg.streaming) continue;
            // The tool_call message escaped the dispatch loop with
            // its in-progress flag still set. Log loudly so the
            // missing-update path can be diagnosed, then patch the
            // UI state so the bubble shows *something* rather than
            // spinning forever.
            const stuckToolName = msg.toolCallMeta?.toolName ?? msg.content;
            console.warn(
                `[ChatStream] Tool_call message "${stuckToolName}" ` +
                `(id=${msg.id}) left turn with streaming=true and no toolCallResult — ` +
                `forcing finalization. This indicates an upstream bug in tool-call message lifecycle.`,
            );
            // Mirror the warn into the in-memory IssueTracer so mobile
            // users (who can't open DevTools) still get a breadcrumb
            // surfaced via the toolbar bug button.
            recordIssue({
                severity: 'warning',
                source: 'chat-stream',
                code: 'stuck-tool-call',
                message:
                    `Tool_call "${stuckToolName}" left the turn with streaming=true and no result; ` +
                    `forced finalization. Likely an upstream gap in the tool-call message lifecycle.`,
                context: {
                    toolName: msg.toolCallMeta?.toolName ?? null,
                    messageId: msg.id,
                    confirmationState: msg.confirmationState ?? null,
                },
            });
            msg.streaming = false;
            if (!msg.toolCallResult) {
                const baseName = msg.toolCallMeta?.toolName ?? msg.content;
                msg.content = `${baseName}  (no result captured)`;
                msg.toolCallResult = {
                    status: 'warning',
                    result: '[Tool finished but no result was captured by the chat pipeline. ' +
                        'This is a UI-side artifact; the model itself may still have received the actual result. ' +
                        'Please report this to the plugin author with the console log above.]',
                };
            }
            this._config.onMessageUpdate?.({ ...msg });
        }
    }

    private async _getBestMatchedTools(
        config: MinimalModelConfig | undefined,
        query: string,
        tools: RegisteredTool[],
        filterOpts?: ToolFilterOptions,
        signal?: AbortSignal,
    ): Promise<RegisteredTool[]> {
        // Short / signal-poor queries (typically follow-ups like "yes" /
        // "继续") should never collapse the on-demand surface — the user
        // is implicitly referring to the previous turn's intent.
        if (isQueryTooShort(query)) return tools;

        const topK = Math.max(1, Math.floor(filterOpts?.topK ?? 9));

        try {
            const always = tools.filter(t => !t.ondemand);
            const ondemand = tools.filter(t => t.ondemand);
            if (ondemand.length === 0) return always;

            const candidateTexts = ondemand.map(buildToolEmbeddingText);
            const ranked = await retrieve(query, candidateTexts, {
                embeddingConfig: config ?? null,
                signal,
            });

            // ── Zero-pass fallback ─────────────────────────────────────
            // If NO ranker produced any signal (BM25 no matches and
            // embedding unconfigured / failed), preserve the full set —
            // dropping tools we can't even rank would be reckless. When
            // we have a ranking but it happens to be very short, top up
            // to `min(3, topK)` so the model always has a workable
            // surface area to act on (matches the historical embedding-
            // only behaviour).
            let keptOndemandIndices: number[];
            if (ranked.length === 0) {
                keptOndemandIndices = ondemand.map((_, i) => i);
            } else {
                const fallbackCount = Math.min(3, topK, ondemand.length);
                const take = Math.max(topK, fallbackCount);
                keptOndemandIndices = ranked.slice(0, take).map(r => r.index);
            }
            const keptIndexSet = new Set(keptOndemandIndices);
            const selectedOndemand = keptOndemandIndices.map(i => ondemand[i]!);

            // ── Diagnostics ─────────────────────────────────────────────
            // Per-tool table showing every score the ranker computed,
            // plus a top-line summary. Mirrors the previous embedding-
            // only log shape so existing reading habits / scripts still
            // work, with the new sub-score columns (bm25 / cosine /
            // ranks) when available. Tools that produced NO signal
            // (e.g. BM25-only mode + zero term overlap) get a null-row
            // appended at the bottom so the table is still complete.
            const scoredIndices = new Set(ranked.map(r => r.index));
            const scoreTable: Array<{
                name: string;
                score: number;
                bm25: number | null;
                cosine: number | null;
                passed: boolean;
            }> = ranked.map(r => ({
                name: ondemand[r.index]!.schema.function.name,
                score: Number(r.score.toFixed(4)),
                bm25: r.bm25Score !== undefined ? Number(r.bm25Score.toFixed(4)) : null,
                cosine: r.cosineSimilarity !== undefined ? Number(r.cosineSimilarity.toFixed(4)) : null,
                passed: keptIndexSet.has(r.index),
            }));
            for (let i = 0; i < ondemand.length; i++) {
                if (scoredIndices.has(i)) continue;
                scoreTable.push({
                    name: ondemand[i]!.schema.function.name,
                    score: 0,
                    bm25: null,
                    cosine: null,
                    passed: keptIndexSet.has(i),
                });
            }
            console.debug(scoreTable);

            const droppedOndemand = ondemand.length - selectedOndemand.length;
            const filterRate = ondemand.length > 0
                ? droppedOndemand / ondemand.length
                : 0;
            const mode = config ? (ranked.some(r => r.cosineSimilarity !== undefined) ? 'hybrid' : 'bm25') : 'bm25';
            console.debug(
                `Tool retriever: total=${tools.length} (always=${always.length}, ondemand=${ondemand.length}) → kept ${always.length + selectedOndemand.length} (always=${always.length}, ondemand=${selectedOndemand.length}); dropped ${droppedOndemand} ondemand (filterRate=${(filterRate * 100).toFixed(1)}%, topK=${topK}, mode=${mode})`,
            );
            return [...always, ...selectedOndemand];
        } catch (err) {
            // User-initiated aborts must propagate — without this re-throw
            // the catch would silently fall back to "full tool set" and the
            // prompt loop would happily move on to the next provider call
            // (which then has to detect the abort itself, costing a full
            // tool-schema serialisation + a provider round-trip's worth of
            // latency before the user finally sees the abort take effect).
            if (err instanceof DOMException && err.name === 'AbortError') throw err;
            // The retriever already logged the underlying cause; fall
            // back to the full tool set so the model never gets stuck
            // with an empty surface.
            console.error("Tool retriever failed, falling back to full tool set", err);
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

        // ── Per-chunk emit throttle (see STREAM_EMIT_THROTTLE_MS) ──
        // Tracks the wall-clock timestamp of the most recent emit so
        // sub-30ms-apart chunks coalesce into a single emit. Both the
        // content branch and the thinking branch share this clock —
        // a content emit also "covers" the thinking state because the
        // emitted message carries the *latest* snapshot of both fields.
        const streamStart = performance.now();
        let lastEmitAt = 0;
        let chunkCount = 0;
        let contentEmits = 0;
        let contentSkips = 0;
        let thinkingEmits = 0;
        let thinkingSkips = 0;

        for await (const chunk of stream) {
            // Per-chunk abort guard. The provider SDK is responsible
            // for surfacing the abort (OpenAI throws AbortError from
            // the iterator; Gemini's adapter ends silently), but the
            // exact moment when that happens is provider-dependent —
            // some emit a few queued chunks after the signal fires
            // before the iterator notices. Bailing here lets a mid-
            // stream abort drop those tail chunks immediately rather
            // than appending them to a message the user already
            // cancelled. The outer prompt() catch treats AbortError as
            // the normal abort path.
            if (this._abortController?.signal.aborted) {
                throw new DOMException("Aborted", "AbortError");
            }

            chunkCount++;
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
                // First content always emits — the bubble must appear
                // immediately, otherwise the user sees nothing until
                // the throttle window opens (typical TTFB perception
                // problem). Subsequent emits are throttled.
                //
                // First-content emit passes the live `streamingMessage`
                // reference (not a copy) on purpose: see the comment
                // at the original emit site for the rationale.
                const now = performance.now();
                if (isFirstContent || now - lastEmitAt >= STREAM_EMIT_THROTTLE_MS) {
                    this._config.onMessageUpdate?.(
                        isFirstContent ? streamingMessage : { ...streamingMessage },
                    );
                    lastEmitAt = now;
                    contentEmits++;
                } else {
                    contentSkips++;
                }
            }

            // Accumulate reasoning/thinking content
            if (chunk.reasoningContent) {
                streamingMessage.thinkingContent = (streamingMessage.thinkingContent ?? "") + chunk.reasoningContent;
                // Shares the same throttle clock as content emits —
                // see the streamStart/lastEmitAt comment above for why
                // a content emit also "covers" thinking. The terminal
                // emit after the loop will catch any pending state.
                const now = performance.now();
                if (now - lastEmitAt >= STREAM_EMIT_THROTTLE_MS) {
                    this._config.onMessageUpdate?.({ ...streamingMessage });
                    lastEmitAt = now;
                    thinkingEmits++;
                } else {
                    thinkingSkips++;
                }
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

        // Per-stream telemetry — useful for diagnosing "AI is streaming
        // but the UI froze" reports. Logged at debug level so the
        // console isn't polluted during normal use; users with devtools
        // open can spot the offending stream at a glance.
        //
        // Only logs on "interesting" streams so short replies stay
        // silent: many chunks, long duration, or substantial coalescing
        // — any of which indicates the throttle is actually doing work
        // (or wishes it could). Pure-tool-call streams (no chunks
        // emitted to UI) also stay quiet.
        const streamMs = performance.now() - streamStart;
        const totalSkips = contentSkips + thinkingSkips;
        if (chunkCount > 50 || streamMs > 500 || totalSkips > 10) {
            console.debug(
                `[ChatStream._processStream] ${chunkCount} chunk(s) in ${streamMs.toFixed(0)}ms; ` +
                `emitted content=${contentEmits}/${contentEmits + contentSkips} ` +
                `thinking=${thinkingEmits}/${thinkingEmits + thinkingSkips} ` +
                `(saved ${totalSkips} downstream renders)`,
            );
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
