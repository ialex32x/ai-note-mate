import { ContextCompressor, ConversationSummary, estimateTokens } from "./context-compression";
import type { MinimalModelConfig } from "./llm-provider";
import type {
    LLMProvider,
    MediaAttachment,
    ModalityCapability,
    CompleteToolCall,
    TokenUsage,
    ChatMessageParam,
    StreamChunk,
    ThinkingLevel,
    ToolCapability,
} from "./llm-provider";
import { retrieve, isQueryTooShort } from "./retriever";
import { recordIssue } from "./diagnostics/issue-tracer";
import { isAbortError } from "../utils/abortable-request";

import {
    SUMMARIZER_SYSTEM_PROMPT,
    STREAM_EMIT_THROTTLE_MS,
} from "./chat-stream-constants";

import {
    buildToolEmbeddingText,
    toolResultApiContent,
    backfillChatMessageBudgetHints,
    generateId,
    toMediaAttachment,
    inferKindFromMime,
    mediaKindLabel,
} from "./chat-stream-helpers";

import {
    quickAskPrompt,
    getQuickAskTurns as _getQuickAskTurns,
    restoreQuickAskTurns as _restoreQuickAskTurns,
    removeQuickAskTurn as _removeQuickAskTurn,
    type QuickAskState,
} from "./chat-stream-quickask";

import {
    assistantHasPersistablePayload,
    assistantContentForApi,
    commitInFlightAssistantToHistory,
    finalizeInFlightAssistantMessage,
    finalizeAbortedToolCallMessage,
    finalizeStuckToolCallMessages,
} from "./chat-stream-assistant-lifecycle";

import type {
    ChatMessage,
    ChatAttachment,
    QuickAskTurn,
    ChatSessionState,
    ToolCallResult,
    ToolFilterOptions,
    RegisteredTool,
    ChatStreamConfig,
    StreamResultInternal,
    IChatAgent,
    ContextBreakdown,
    SystemPromptBreakdown,
} from "./chat-stream-types";

// ─────────────────────────────────────────────
// Re-exports for backward compatibility
// ─────────────────────────────────────────────

// Constants
export {
    SUMMARIZER_SYSTEM_PROMPT,
    QUICK_ASK_SYSTEM_PROMPT,
} from "./chat-stream-constants";

// Types
export type {
    MessageId,
    ToolCallMeta,
    ToolCallStatus,
    ToolCallResultInfo,
    ChatMessage,
    ChatAttachment,
    QuickAskTurn,
    ChatSessionState,
    ToolCallArgs,
    ToolCallResult,
    ToolFilterOptions,
    RegisteredTool,
    ChatStreamConfig,
    StreamResultInternal,
    AgentTokenBreakdown,
    IChatAgent,
    ContextBreakdown,
    SystemPromptBreakdown,
} from "./chat-stream-types";

// Re-exports from context-compression for external consumers
export type { ConversationSummary, ContextCompressionOptions } from "./context-compression";

// ─────────────────────────────────────────────
// TokenUsage re-export
// ─────────────────────────────────────────────

export { TokenUsage };

// ─────────────────────────────────────────────
// ChatStream class
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
    /** QuickAsk side-turns anchored to specific assistant messages */
    private _quickAskTurns: QuickAskTurn[] = [];
    /**
     * The assistant message currently being streamed by `_processStream`.
     * Lets abort/error paths commit partial text into `_messages` so the
     * next prompt() rebuild sees what the user already saw in the UI.
     */
    private _inFlightAssistantMessage: ChatMessage | null = null;
    /** Model identifier for the current turn, set from prompt() options. */
    private _currentModelName = '';
    /** Per-turn context composition breakdown, updated at the start of each prompt(). */
    private _contextBreakdown: ContextBreakdown | undefined;

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

    /** Per-turn context composition breakdown (undefined when no turn has run). */
    get contextBreakdown(): ContextBreakdown | undefined {
        return this._contextBreakdown;
    }

    // ── QuickAsk side-turns ─────────────────────────────────────────────────
    // Implementation extracted to chat-stream-quickask.ts.

    async promptQuickAsk(
        parentMessageId: string,
        userInput: string,
        modelConfig: MinimalModelConfig,
    ): Promise<ChatMessage> {
        return quickAskPrompt(this as unknown as QuickAskState, parentMessageId, userInput, modelConfig);
    }

    getQuickAskTurns(): QuickAskTurn[] {
        return _getQuickAskTurns(this as unknown as QuickAskState);
    }

    restoreQuickAskTurns(turns: QuickAskTurn[]): void {
        _restoreQuickAskTurns(this as unknown as QuickAskState, turns);
    }

    removeQuickAskTurn(parentMessageId: string): void {
        _removeQuickAskTurn(this as unknown as QuickAskState, parentMessageId);
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
        this._quickAskTurns = [];
        this._state = "idle";
        this._abortController = null;
        this._sessionTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        this._currentTurn = 0;
        this._contextBreakdown = undefined;
        this._inFlightAssistantMessage = null;
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
        this._contextBreakdown = undefined; // stale from previous session
        // Restore summaries if provided
        if (summaries && summaries.length > 0) {
            this._summaries = summaries.map(s => ({ ...s }));
        }
    }

    /** Restore a context breakdown from persisted cache (debug mode). */
    restoreContextBreakdown(breakdown: ContextBreakdown): void {
        this._contextBreakdown = breakdown;
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
            /** Model identifier for this turn, stored on the assistant message. */
            modelName?: string,
            /**
             * User-pasted image attachments for this turn.
             * Stored as cache-path references on the ChatMessage;
             * resolved to base64 on demand when building API messages.
             */
            attachments?: ChatAttachment[],
        }
    ): Promise<void> {
        // Guard: prevent concurrent calls
        if (this._state === "streaming") {
            throw new Error("ChatStream is already streaming. Wait for the current prompt to finish.");
        }

        // Transition to streaming state and notify start
        this._state = "streaming";
        this._abortController = new AbortController();
        this._currentModelName = options?.modelName ?? '';
        this._contextBreakdown = undefined; // reset per-turn
        this._config.onStart?.();

        // Append user message to UI-facing history (store original text with [[path]] syntax)
        // Increment turn counter for each user message
        const currentTurn = ++this._currentTurn;
        const attachments = options?.attachments;
        const userMessage: ChatMessage = {
            id: generateId(),
            role: "user",
            content: userInput,
            streaming: false,
            timestamp: Date.now(),
            turn: currentTurn,
            attachments,
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
        // that both the LLM request path and ContextCompressor (which treats
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
        const { text: effectiveSystemPrompt, breakdown: spBreakdown } =
            await this._buildEffectiveSystemPrompt(userInput);

        const rawMessages = await this._rebuildApiMessages(effectiveSystemPrompt);

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
                    stickyOndemandToolNames,
                );

                // Re-add any sticky on-demand tools the embedding filter
                // dropped this round. (Short queries are already handled
                // inside _getBestMatchedTools — this is a no-op for them.)
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
                    // compressor's threshold check would systematically
                    // under-count the real prompt size by 1–3k+ tokens on
                    // sessions with many tools attached. Use the same
                    // heuristic estimator as the compressor itself for a
                    // consistent budget unit.
                    const accessoryTokens = toolSchemas.length > 0
                        ? estimateTokens(JSON.stringify(toolSchemas))
                        : 0;
                    const reduceResult = await ContextCompressor.compress(
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
                    // Cache shrink results on live buffers (full bodies stay in UI storage).
                    ContextCompressor.backfillBudgetHints(messagesToSend, rawMessages);
                    backfillChatMessageBudgetHints(this._messages, messagesToSend);
                    // console.log("Context reduced", reduceResult.compressed);
                    // Persist summaries if compression occurred.
                    //   - Level-2+ merge returns a full replacement set: the
                    //     old summaries are consolidated into one higher-level
                    //     summary and must be replaced wholesale, otherwise
                    //     they accumulate forever in the prompt and on disk
                    //     (docs/context-compression-bug-report.md §2, Bug 1).
                    //   - Level-1 returns a single summary to append.
                    // The session-level persistence reads `this.summaries`
                    // (getter) at save time, so mutating `_summaries` here is
                    // sufficient for durability.
                    if (reduceResult.summariesReplacement) {
                        this._summaries = reduceResult.summariesReplacement.map(s => ({ ...s }));
                    } else if (reduceResult.newSummary) {
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

                // Compute context breakdown once per turn — the first
                // tool-loop iteration stores it; `prompt()` resets the
                // field to undefined at the top of each turn.
                // Uses `messagesToSend` (post-compression) so the totals
                // reflect what the LLM actually receives.
                if (!this._contextBreakdown) {
                    let convUser = 0;
                    let convAssistant = 0;
                    let convTool = 0;
                    for (const msg of messagesToSend) {
                        if (msg.role === 'system') continue;
                        const tok = estimateTokens(
                            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                        );
                        if (msg.role === 'user') convUser += tok;
                        else if (msg.role === 'assistant') convAssistant += tok;
                        else if (msg.role === 'tool_result') convTool += tok;
                    }

                    const toolSchemaTokens = toolSchemas.length > 0
                        ? estimateTokens(JSON.stringify(toolSchemas))
                        : 0;
                    let summaryTokens = 0;
                    for (const s of this._summaries) {
                        summaryTokens += estimateTokens(s.content);
                    }
                    this._contextBreakdown = {
                        systemPrompt: spBreakdown,
                        conversation: {
                            user: convUser,
                            assistant: convAssistant,
                            tool: convTool,
                        },
                        summaries: summaryTokens,
                        toolSchemas: toolSchemaTokens,
                    };
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

                this._logFinalContext(messagesToSend, agentLabel, options.summarizer != null);

                const stream = activeProvider.createStream(
                    messagesToSend,
                    toolSchemas.length > 0 ? toolSchemas : undefined,
                    this._abortController.signal,
                    options?.thinkingLevel,
                );

                const result = await this._processStream(stream, currentTurn, this._currentModelName);

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

                const isPureToolCallTurn = (!result.content || result.content.trim() === '')
                    && !!result.toolCalls
                    && result.toolCalls.length > 0;
                // Finalize the in-flight assistant that `_processStream` was
                // building. Pure tool-call turns omit the empty assistant
                // bubble from `_messages` (same as before).
                const assistantMessage = this._finalizeInFlightAssistantMessage({
                    turn: currentTurn,
                    removeFromHistory: isPureToolCallTurn,
                });
                if (assistantMessage) {
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
                    // ContextCompressor can stably anchor summary cutoffs.
                    id: assistantMessage?.id ?? generateId(),
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

                        await this._handleSingleToolCall(
                            toolCall, filteredTools, capabilityFilteredTools,
                            stickyOndemandToolNames, toolCallCounts, rawMessages,
                        );
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

                const interruptedAssistant = this._finalizeInFlightAssistantMessage({
                    interrupted: true,
                    turn: currentTurn,
                });

                // Record the abort as a system message in history (display-only, not sent to API)
                this._messages.push({
                    id: generateId(),
                    role: "system",
                    content: "aborted",
                    streaming: false,
                    timestamp: Date.now(),
                });

                const partialMessage: ChatMessage = interruptedAssistant ?? {
                    id: generateId(),
                    role: "assistant",
                    content: "",
                    streaming: false,
                    timestamp: Date.now(),
                    modelName: this._currentModelName || undefined,
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
            const interruptedAssistant = this._finalizeInFlightAssistantMessage({
                interrupted: true,
                turn: currentTurn,
            });

            // Check if this was a user-initiated abort
            if (isAbortError(err)) {
                this._state = "aborted";

                // Record the abort as a system message in history (display-only, not sent to API)
                this._messages.push({
                    id: generateId(),
                    role: "system",
                    content: "aborted",
                    streaming: false,
                    timestamp: Date.now(),
                });

                const partialMessage: ChatMessage = interruptedAssistant ?? {
                    id: generateId(),
                    role: "assistant",
                    content: "",
                    streaming: false,
                    timestamp: Date.now(),
                    modelName: this._currentModelName || undefined,
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
     * Resolve the effective system prompt for this turn.
     *
     * Assembly order (top → bottom, i.e. what the model sees first):
     *   1. `memoryPrefix`    — long-term memory context
     *   2. `skillPrefix`     — per-turn skill catalogue
     *   3. `systemPrompt`    — static builtin rules + custom instructions
     *   4. `systemPromptSuffix` — TODO reminders / delegation block
     *
     * When the new segregated callbacks ({@link memoryPrefix},
     * {@link skillPrefix}) are not supplied but the legacy
     * {@link systemPromptPrefix} is, the old single-prefix path is
     * used and the entire prefix is attributed to 'skills' in the
     * breakdown (the most common use-case for the legacy callback).
     *
     * Each segment is token-estimated individually via
     * {@link estimateTokens} so the breakdown has zero runtime
     * overhead on the chained LLM call itself.
     */
    private async _buildEffectiveSystemPrompt(userInput: string): Promise<{
        text: string;
        breakdown: SystemPromptBreakdown;
    }> {
        const signal = this._abortController?.signal;
        const baseline = this._config.systemPrompt ?? '';
        const segments: string[] = [];
        let memoryTokens = 0;
        let skillsTokens = 0;

        // 1. Memory prefix (new callback, takes priority over legacy prefix)
        const hasSegregated = !!(this._config.memoryPrefix || this._config.skillPrefix);

        if (this._config.memoryPrefix) {
            try {
                const memory = await this._config.memoryPrefix(userInput, signal);
                if (memory) {
                    memoryTokens = estimateTokens(memory);
                    segments.push(memory);
                }
            } catch (err) {
                if (isAbortError(err)) throw err;
                console.warn('ChatStream: memoryPrefix threw, ignoring', err);
            }
        }

        if (this._config.skillPrefix) {
            try {
                const skills = await this._config.skillPrefix(userInput, signal);
                if (skills) {
                    skillsTokens = estimateTokens(skills);
                    segments.push(skills);
                }
            } catch (err) {
                if (isAbortError(err)) throw err;
                console.warn('ChatStream: skillPrefix threw, ignoring', err);
            }
        }

        // Legacy fallback: when neither new callback is set but
        // systemPromptPrefix is, fold its entire output into 'skills'.
        if (!hasSegregated && this._config.systemPromptPrefix) {
            try {
                const prefix = await this._config.systemPromptPrefix(userInput, signal);
                if (prefix) {
                    skillsTokens = estimateTokens(prefix);
                    segments.push(prefix);
                }
            } catch (err) {
                if (isAbortError(err)) throw err;
                console.warn('ChatStream: systemPromptPrefix threw, falling back to base prompt', err);
            }
        }

        // 2. Baseline (static system prompt)
        const baselineTokens = baseline ? estimateTokens(baseline) : 0;
        if (baseline) segments.push(baseline);

        // 3. Suffix (TODO reminders / delegation block)
        let suffixTokens = 0;
        if (this._config.systemPromptSuffix) {
            try {
                const suffix = await this._config.systemPromptSuffix(userInput, signal);
                if (suffix) {
                    suffixTokens = estimateTokens(suffix);
                    segments.push(suffix);
                }
            } catch (err) {
                if (isAbortError(err)) throw err;
                console.warn('ChatStream: systemPromptSuffix threw, falling back to base prompt', err);
            }
        }

        return {
            text: segments.join('\n\n'),
            breakdown: {
                memory: memoryTokens,
                skills: skillsTokens,
                baseline: baselineTokens,
                suffix: suffixTokens,
            },
        };
    }

    /**
     * Rebuild the flat API message list from `_messages` for a new LLM call.
     *
     * Walks the stored conversation history and reconstructs a valid
     * `ChatMessageParam[]` sequence: user → assistant(toolCalls) →
     * tool_result(s).  Orphan tool_call messages (no completed result)
     * are skipped.  Pure tool-call turns (assistant with no text/thinking)
     * get a synthesised empty-content assistant so the protocol invariant
     * ("every tool_result has an assistant owner") holds.
     *
     * For the most recent user message, {@link ChatMessage.attachments}
     * are resolved via {@link ChatStreamConfig.resolveAttachment} and
     * attached as {@link ChatMessageParam.media}.  Historical user
     * messages always ship without media (the LLM already processed
     * those images in previous turns).
     */
    private async _rebuildApiMessages(effectiveSystemPrompt: string): Promise<ChatMessageParam[]> {
        // Find the index of the last user message — only its attachments
        // (if any) should be resolved to media.  Historical images don't
        // need to be re-sent: the LLM already processed them and their
        // content is captured in the assistant replies from those turns.
        let lastUserIndex = -1;
        for (let i = this._messages.length - 1; i >= 0; i--) {
            if (this._messages[i]!.role === "user") {
                lastUserIndex = i;
                break;
            }
        }

        const rawMessages: ChatMessageParam[] = [];
        if (effectiveSystemPrompt) {
            rawMessages.push({ role: "system", content: effectiveSystemPrompt });
        }
        for (let i = 0; i < this._messages.length; i++) {
            const msg = this._messages[i]!;
            if (msg.role === "user") {
                const media: MediaAttachment[] = [];
                if (i === lastUserIndex && msg.attachments && msg.attachments.length > 0 && this._config.resolveAttachment) {
                    for (const att of msg.attachments) {
                        try {
                            const resolved = await this._config.resolveAttachment(
                                att.cachePath,
                                att.mimeType,
                                att.fileName,
                            );
                            if (resolved) {
                                media.push(resolved);
                            }
                        } catch (err) {
                            console.warn(
                                `[ChatStream] Failed to resolve attachment "${att.fileName}"` +
                                ` at ${att.cachePath}:`, err,
                            );
                            // Continue with other attachments — a single
                            // broken file should not block the entire turn.
                        }
                    }
                }
                rawMessages.push({
                    role: "user",
                    content: msg.content,
                    id: msg.id,
                    media: media.length > 0 ? media : undefined,
                });
                continue;
            }
            if (msg.role === "assistant" || msg.role === "tool_call") {
                const isAssistantNode = msg.role === "assistant";
                const assistantContent = isAssistantNode
                    ? this._assistantContentForApi(msg)
                    : "";
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
                        const content = toolResultApiContent(res);
                        const tr: ChatMessageParam = {
                            role: "tool_result",
                            toolCallId: meta.toolCallId,
                            content,
                        };
                        if (
                            tcMsg.contentBudgetHint != null
                            && tcMsg.contentBudgetHintForLength === content.length
                        ) {
                            tr.contentBudgetHint = tcMsg.contentBudgetHint;
                            tr.contentBudgetHintForLength = tcMsg.contentBudgetHintForLength;
                        }
                        toolResultParams.push(tr);
                    }
                    j++;
                }

                // Skip degenerate orphans.
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
                i = j - 1;
                continue;
            }
            // Other roles (system, etc.): skip.
        }
        return rawMessages;
    }

    /**
     * Handle a single tool call from the model during the prompt loop.
     *
     * Extracted from {@link prompt} so the ~360-line tool-handling path
     * lives in a focused method rather than inflating the main method to
     * nearly 1000 lines.
     *
     * @param toolCall - The parsed tool call from the assistant's response.
     * @param filteredTools - Tools that passed embedding filtering this iteration.
     * @param capabilityFilteredTools - All capability-allowed tools (fallback for filter misses).
     * @param stickyOndemandToolNames - Mutable set; on-demand tools the model has called are added.
     * @param toolCallCounts - Mutable per-tool call counter for budget enforcement.
     * @param rawMessages - Mutable API message buffer; tool results are appended here.
     */
    private async _handleSingleToolCall(
        toolCall: CompleteToolCall,
        filteredTools: RegisteredTool[],
        capabilityFilteredTools: RegisteredTool[],
        stickyOndemandToolNames: Set<string>,
        toolCallCounts: Map<string, number>,
        rawMessages: ChatMessageParam[],
    ): Promise<void> {
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
        //   1) `filteredTools.find(...)` — the tool was offered
        //      to the model this iteration (passed both capability
        //      and embedding filters). This is the normal case.
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
        //      forever, never gets a ✓/✕" bug.
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
        if (registered?.ondemand) {
            stickyOndemandToolNames.add(toolName);
        }

        // ── Filter-miss telemetry ──────────────────────────
        if (recoveredFromFilterMiss) {
            console.debug(
                `[embedding tool filter] miss recovered: model called "${toolName}" `
                + `but it was filtered out (capability-allowed, dispatching directly; `
                + `consider lowering threshold or revising its description)`,
            );
        }

        // ── Per-turn call-budget enforcement ────────────────
        const callCountAfter = (toolCallCounts.get(toolName) ?? 0) + 1;
        toolCallCounts.set(toolName, callCountAfter);
        const budget = registered?.maxCallsPerTurn;
        const hardLimit = budget?.hard;
        const softLimit = budget?.soft;
        const hardBlocked = typeof hardLimit === 'number' && callCountAfter > hardLimit;
        const softTripped = !hardBlocked
            && typeof softLimit === 'number'
            && callCountAfter > softLimit;
        const softReminder = softTripped
            ? `\n\n[Note: tool "${toolName}" has been called ${callCountAfter} times in this turn` +
              (typeof hardLimit === 'number' ? ` (hard limit ${hardLimit})` : '') +
              `. You very likely have enough material now — synthesize an answer from what you already have instead of calling this tool again.]`
            : null;

        let toolResult: string;
        let mediaAttachment: MediaAttachment | null = null;

        if (hardBlocked) {
            toolResult = `Error: Tool "${toolName}" reached its per-turn call limit (${hardLimit}). ` +
                `Do NOT call this tool again in this turn. Synthesize an answer from the results you already have, ` +
                `try a different approach, or ask the user to clarify.`;
        } else if (argParseError) {
            toolResult = `Error: ${argParseError}`;
        } else if (!registered) {
            if (this._config.onToolCall) {
                toolResult = await this._config.onToolCall({
                    toolCallId,
                    toolName,
                    toolArgs,
                    message: toolCallMessage,
                });
            } else {
                recordIssue({
                    severity: 'error',
                    source: 'chat-stream',
                    code: 'unhandled-tool',
                    message:
                        `Tool "${toolName}" was called but no handler is registered and ` +
                        `no onToolCall callback is provided. The dispatch loop will throw, ` +
                        `which may leave the tool_call bubble stuck pending a safety-net finalize.`,
                    context: { toolName, toolCallId, messageId: toolCallMessage.id },
                });
                throw new Error(
                    `Tool "${toolName}" was called but no handler is registered and no onToolCall callback is provided.`
                );
            }
        } else {
            let lastExecResult: ToolCallResult | undefined;
            try {
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
                        lastExecResult = execResult;
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
                    lastExecResult = execResult;
                    toolResult = ChatStream.serialiseToolResult(execResult);
                    if (execResult.type === "media") {
                        mediaAttachment = toMediaAttachment(execResult.content);
                    }
                }

                if (lastExecResult?.assets && lastExecResult.assets.length > 0) {
                    this._config.onAssetGenerated?.(lastExecResult.assets);
                }
            } catch (err) {
                if (isAbortError(err)) {
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

        if (softReminder && !isError) {
            toolResult = toolResult + softReminder;
        }

        // Mark the tool_call message as complete
        const toolCallElapsed = Date.now() - toolCallStartTime;
        toolCallMessage.streaming = false;
        toolCallMessage.content = `${toolName}  (${toolCallElapsed}ms)`;
        toolCallMessage.toolCallResult = {
            status: resultStatus,
            result: isError ? toolResult.slice('Error:'.length).trim() : toolResult,
        };
        this._config.onMessageUpdate?.({ ...toolCallMessage });

        this._config.onToolCallEnd?.({ toolName, toolArgs, result: toolResult, isError });

        rawMessages.push({ role: "tool_result", toolCallId, content: toolResult });

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

    // ── Assistant message lifecycle ──────────────────────────────────
    // Implementations extracted to chat-stream-assistant-lifecycle.ts.

    /** Whether an assistant message carries text/thinking worth persisting. */
    private _assistantHasPersistablePayload(msg: ChatMessage): boolean {
        return assistantHasPersistablePayload(msg);
    }

    /**
     * Map stored assistant text to the API payload. Interrupted replies keep
     * the user-visible `content` intact and append a short meta note.
     */
    private _assistantContentForApi(msg: ChatMessage): string {
        return assistantContentForApi(msg);
    }

    /**
     * Push the in-flight assistant into `_messages` on first stream output.
     * Subsequent chunks mutate the same object in place.
     */
    private _commitInFlightAssistantToHistory(turn: number): void {
        commitInFlightAssistantToHistory(this._messages, this._inFlightAssistantMessage, turn);
    }

    /**
     * End the current `_processStream` assistant: mark non-streaming, optionally
     * flag interruption, and ensure `_messages` holds the latest partial text.
     */
    private _finalizeInFlightAssistantMessage(opts?: {
        interrupted?: boolean;
        turn?: number;
        /** Drop from `_messages` after finalize (pure tool-call turns). */
        removeFromHistory?: boolean;
    }): ChatMessage | null {
        const msg = this._inFlightAssistantMessage;
        this._inFlightAssistantMessage = null;
        return finalizeInFlightAssistantMessage(this._messages, msg, this._config.onMessageUpdate, opts);
    }

    /**
     * Finalize a tool_call message that is being torn down by an abort.
     */
    private _finalizeAbortedToolCallMessage(
        toolCallMessage: ChatMessage,
        elapsedMs: number,
        note: string,
    ): void {
        finalizeAbortedToolCallMessage(toolCallMessage, elapsedMs, note, this._config.onMessageUpdate);
    }

    /**
     * End-of-turn safety net: walk `_messages` and finalize any
     * `tool_call` message that's still flagged `streaming: true`.
     */
    private _finalizeStuckToolCallMessages(): void {
        finalizeStuckToolCallMessages(this._messages, this._config.onMessageUpdate);
    }

    private async _getBestMatchedTools(
        config: MinimalModelConfig | undefined,
        query: string,
        tools: RegisteredTool[],
        filterOpts?: ToolFilterOptions,
        signal?: AbortSignal,
        stickyOndemandToolNames?: ReadonlySet<string>,
    ): Promise<RegisteredTool[]> {
        // Short / signal-poor queries can't drive meaningful retrieval.
        // Collapse to always-on tools + previously-used on-demand tools
        // only — saves ~37 tool schemas (~13 000 tokens) on "Hi" / "yes".
        if (isQueryTooShort(query)) {
            if (!stickyOndemandToolNames || stickyOndemandToolNames.size === 0) {
                return tools.filter(t => !t.ondemand);
            }
            return tools.filter(t =>
                !t.ondemand ||
                stickyOndemandToolNames.has(t.schema.function.name),
            );
        }

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
            if (isAbortError(err)) throw err;
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
        currentTurn: number,
        modelName: string,
    ): Promise<StreamResultInternal> {
        // Create the in-progress assistant message
        const streamingMessage: ChatMessage = {
            id: generateId(),
            role: "assistant",
            content: "",
            streaming: true,
            timestamp: Date.now(),
            modelName: modelName || undefined,
        };
        this._inFlightAssistantMessage = streamingMessage;

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
                if (isFirstContent) {
                    this._commitInFlightAssistantToHistory(currentTurn);
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
                const isFirstThinking = !streamingMessage.thinkingContent;
                streamingMessage.thinkingContent = (streamingMessage.thinkingContent ?? "") + chunk.reasoningContent;
                if (isFirstThinking) {
                    this._commitInFlightAssistantToHistory(currentTurn);
                }
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

        // Flush any throttled tail content to the UI. `streaming` stays true
        // until `_finalizeInFlightAssistantMessage` runs on the success /
        // abort / error epilogue so partial text is already in `_messages`
        // if the turn unwinds mid-stream.
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

    /**
     * Dump the final assembled context being sent to the LLM so the
     * per-call token usage shown in the UI can be correlated with the
     * exact message layout produced by the compressor + sanitizer +
     * emergency-shrink pipeline.
     *
     * To disable this noisy per-turn log, return early at the top of
     * this method body.  Keeping it as a separate method makes it easy
     * to spot in a diff and toggle on/off globally.
     */
    private _logFinalContext(
        messagesToSend: ChatMessageParam[],
        agentLabel: string,
        hasSummarizer: boolean,
    ): void {
        try {
            const estTokens = estimateTokens(JSON.stringify(messagesToSend));
            const roleCounts = new Map<string, number>();
            for (const m of messagesToSend) { roleCounts.set(m.role, (roleCounts.get(m.role) ?? 0) + 1); }
            const breakdown = Array.from(roleCounts.entries())
                .map(([r, c]) => `${r}:${c}`).join(' ');
            const compressTag = hasSummarizer
                ? (this._summaries.length > 0 ? 'compressed' : 'no-compress')
                : 'no-summarizer';

            const seq = messagesToSend.map((m, idx) => {
                const tc = m.toolCalls;
                const tcIds = tc && tc.length > 0 ? tc.map(c => c.id).join(',') : '';
                const tcId = m.toolCallId;
                const len = typeof m.content === 'string' ? m.content.length : 0;
                return `[${idx}] ${m.role}${tcIds ? ` toolCalls=${tcIds}` : ''}${tcId ? ` toolCallId=${tcId}` : ''} len=${len}`;
            }).join('\n');
            console.debug(
                `[agent="${agentLabel}"] final context: ${messagesToSend.length} msgs ` +
                `(${breakdown}), ~${estTokens} est-tokens, status=${compressTag}\n${seq}`,
            );
        } catch { /* noop */ }
    }
}
