/**
 * Sub-Agent: A lightweight wrapper around ChatStream that executes
 * a specific task with a dedicated tool set and independent context.
 *
 * Sub-agents are created and managed by the AgentOrchestrator.
 * Each sub-agent has its own ChatStream instance, system prompt,
 * and tool set. It executes a task and returns a refined result
 * to the main agent.
 */

import { ChatStream, ChatMessage, RegisteredTool, type ToolFilterOptions } from "./chat-stream";
import type { LLMProvider, TokenUsage, ThinkingLevel, ToolCapability, MinimalModelConfig } from "./llm-provider";
import { type ContextReduceOptions } from "./context-reducer";
import { safeSliceHead, stripLoneSurrogates } from "../utils/string-safe";
import { createHandoffTools, createResultTools, type HandoffStore } from "./tools/handoff-toolcall";
import { isAbortError } from "../utils/abortable-request";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Configuration for a sub-agent */
export interface SubAgentConfig {
    /** Unique identifier for this sub-agent (e.g., "vault_inspector", "web", "code") */
    name: string;
    /** Human-readable description of this agent's capabilities (used for routing) */
    description: string;
    /** Dedicated system prompt for this sub-agent */
    systemPrompt: string;
    /** Tools available to this sub-agent */
    tools: RegisteredTool[];
    /**
     * Maximum token count for the result returned to main-agent.
     * If the result exceeds this, it will be summarized via LLM.
     * Default: 10000
     */
    resultMaxTokens?: number;
    /**
     * Routing keywords for fast keyword-based routing.
     * If the user message contains any of these keywords, this agent
     * will be suggested as a candidate without needing LLM routing.
     */
    routingKeywords?: string[];
    /**
     * Per-profile context-compression overrides forwarded to the inner
     * ChatStream. Sub-agents share the user's active profile (we don't
     * expose a separate profile per sub-agent) so the orchestrator passes
     * the same numbers it gives the main agent. `undefined` falls back to
     * the reducer's built-in defaults.
     */
    compressionOptions?: Pick<ContextReduceOptions,
        'compressionThreshold' | 'slidingWindowSize' | 'maxSummariesThreshold' | 'modelContextWindow'
    >;
}

/** Result returned by a sub-agent execution */
export interface SubAgentResult {
    /** Refined result text (returned to main-agent as tool result) */
    summary: string;
    /** Full assistant reply content (before summarization) */
    fullContent: string;
    /** Summary of tool calls made during execution */
    toolCalls: ToolCallSummary[];
    /** Token usage for this sub-agent execution */
    tokenUsage: TokenUsage;
    /** Whether the execution was aborted */
    aborted: boolean;
}

/** Summary of a single tool call made by a sub-agent */
export interface ToolCallSummary {
    toolName: string;
    args: Record<string, unknown>;
    /** Brief result description */
    resultPreview: string;
    /** Whether the tool call succeeded */
    success: boolean;
    /** Elapsed time in ms */
    elapsed: number;
}

/** Execution log for UI display */
export interface SubAgentExecutionLog {
    agentName: string;
    task: string;
    messages: ChatMessage[];
    toolCalls: ToolCallSummary[];
    startTime: number;
    endTime: number;
    tokenUsage: TokenUsage;
    aborted: boolean;
}

// ─────────────────────────────────────────────
// SubAgent class
// ─────────────────────────────────────────────

export class SubAgent {
    readonly name: string;
    readonly description: string;
    private readonly _config: SubAgentConfig;
    private _chatStream: ChatStream | null = null;
    private _abortController: AbortController | null = null;
    private _executionLog: SubAgentExecutionLog | null = null;

    /** Collected tool call summaries during execution */
    private _toolCallSummaries: ToolCallSummary[] = [];

    /**
     * Reusable ChatStream instance.
     *
     * We keep the ChatStream (the "shell") across execute() calls so we
     * avoid reconstructing the provider client, re-registering tools, and
     * re-wiring callbacks on every invocation. However we do **not**
     * preserve its conversation state: each execute() starts with a fully
     * cleared message history and summary list (see `_getOrCreateChatStream`).
     *
     * Rationale: a sub-agent call is an isolated, single-purpose task
     * (compress / summarize / route / etc.). Carrying over prior messages
     * or summaries lets stale tool_result content bleed into a new task's
     * context, which the model may treat as "already-known" facts and
     * hallucinate against. Clearing per-execute gives us:
     *   - strict task isolation (no cross-task leakage)
     *   - reproducible behaviour (Nth call behaves like the 1st)
     *   - constant token footprint (no history growth)
     * while still avoiding the cost of rebuilding the ChatStream itself.
     */
    private _reusableChatStream: ChatStream | null = null;

    /**
     * IDs of messages produced during the current execute() call.
     * Also acts as an "inside-execute()" sentinel: the ChatStream's
     * onMessageUpdate callback early-returns when this is null, so late
     * async emissions outside an active execute() are dropped.
     */
    private _currentExecIds: Set<string> | null = null;
    /** parentToolCallId of the in-flight execute() call (for tagging sub-agent messages) */
    private _currentExecParentToolCallId: string | undefined;
    /** onMessageUpdate handler forwarded from the current execute() call */
    private _currentExecMessageHandler: ((agentName: string, msg: ChatMessage) => void) | undefined;
    /** Confirmation callback forwarded from the main agent for the current execute() */
    private _currentExecConfirmToolCall: ((args: { toolName: string; toolArgs: Record<string, unknown>; messageId: string }) => Promise<boolean>) | undefined;
    /** onToolCallEnd handler forwarded from the current execute() call */
    private _currentExecToolCallEndHandler: ((agentName: string, toolName: string, args: Record<string, unknown>, result: string, isError: boolean) => void) | undefined;

    /**
     * Per-dispatch seed store (main → sub direction). Pre-populated by
     * the orchestrator from `delegate_task`'s `handoff` argument.
     * Read-only from the sub-agent's perspective; the read_handoff /
     * list_handoff tools resolve this field via a getter closure.
     *
     * `null` means no seed store wired; the tools report a clear error.
     */
    private _currentHandoffStore: HandoffStore | null = null;

    /**
     * Per-dispatch result store (sub → main direction). Initially empty;
     * the sub-agent populates it via write_result / write_result_array /
     * write_result_object before its final text reply. The orchestrator
     * reads it after completion to build the delegate envelope.
     *
     * Completely separate from `_currentHandoffStore` — no shared
     * namespace, no key collision between seed and result.
     */
    private _currentResultStore: HandoffStore | null = null;

    /**
     * Mirrors the main agent's `toolConfirmMode === 'always'` gate: when
     * false, the inner ChatStream omits `onConfirmToolCall` so tools with
     * `requiresConfirmation` auto-run without writing `confirmationState`
     * (no misleading "Allowed" badge in the UI). Set by the orchestrator
     * from `!!config.onConfirmToolCall` at construction time.
     */
    private readonly _toolConfirmationEnabled: boolean;

    constructor(
        config: SubAgentConfig,
        options?: { toolConfirmationEnabled?: boolean },
    ) {
        this.name = config.name;
        this.description = config.description;
        this._config = config;
        this._toolConfirmationEnabled = options?.toolConfirmationEnabled ?? false;
    }

    /** Get routing keywords for this sub-agent */
    get routingKeywords(): string[] {
        return this._config.routingKeywords ?? [];
    }

    /**
     * Execute a task with this sub-agent.
     *
     * Creates a fresh ChatStream, registers the agent's tools,
     * sends the task as a user message, and collects the result.
     *
     * @param task - The task description to execute
     * @param options - Provider and other options
     * @returns The execution result with refined summary
     */
    async execute(
        task: string,
        options: {
            provider: LLMProvider;
            thinkingLevel?: ThinkingLevel;
            allowedCapabilities?: ToolCapability[];
            /** Forwarded to ChatStream for context compression (unrelated to the removed result summarization). */
            summarizer?: MinimalModelConfig;
            embedding?: MinimalModelConfig;
            embeddingFilter?: ToolFilterOptions;
            /** Optional context from the main conversation */
            context?: string;
            /**
             * toolCallId of the parent delegate_task invocation in the main agent.
             * Used to tag all sub-agent messages with a back-reference so the UI
             * can group and render them inline with the main conversation flow.
             */
            parentToolCallId?: string;
            /** Callback for real-time message updates (only delta of THIS execute call) */
            onMessageUpdate?: (agentName: string, msg: ChatMessage) => void;
            /** Callback for tool call events */
            onToolCall?: (agentName: string, toolName: string, args: Record<string, unknown>) => void;
            /** Callback for tool call completion */
            onToolCallEnd?: (agentName: string, toolName: string, args: Record<string, unknown>, result: string, isError: boolean) => void;
            /**
             * Optional confirmation callback forwarded from the main agent.
             * When provided and a sub-agent tool has `requiresConfirmation: true`,
             * the user will be prompted via the main agent's UI before execution.
             *
             * Receives the sub-agent's per-execution AbortSignal as `args.signal`
             * so the handler can reject the confirmation promise when the user
             * cancels the turn mid-dialog — see `ChatStreamConfig.onConfirmToolCall`
             * for the same contract on the main agent's side.
             */
            onConfirmToolCall?: (args: {
                toolName: string;
                toolArgs: Record<string, unknown>;
                messageId: string;
                signal?: AbortSignal;
            }) => Promise<boolean>;
            /**
             * Per-dispatch seed store (main → sub direction). Pre-populated
             * by the orchestrator with data from `delegate_task`'s `handoff`
             * argument. The sub-agent's `read_handoff` / `list_handoff` tools
             * read from this map. If omitted, those tools report "no store
             * available" to the model.
             */
            handoffStore?: HandoffStore;
            /**
             * Per-dispatch result store (sub → main direction). Fresh empty
             * map for the sub-agent to populate via `write_result` /
             * `write_result_array` / `write_result_object`. The orchestrator
             * reads this store after completion to build the delegate envelope.
             * If omitted, the write tools report "no store available".
             */
            resultStore?: HandoffStore;
            /**
             * Optional opaque tag forwarded to the sub-agent's ChatStream
             * as {@link ChatStream.contextTag} for the duration of this
             * execute() call. Used by downstream side-effect logging (e.g.
             * the AI file-changes audit log) to attribute vault mutations
             * back to the parent session.
             */
            contextTag?: string;
            /** Model identifier for this dispatch, stored on assistant messages. */
            modelName?: string;
        },
    ): Promise<SubAgentResult> {
        const startTime = Date.now();
        this._toolCallSummaries = [];
        this._abortController = new AbortController();

        // Track message IDs that belong to THIS execute() call.
        // When `_reusableChatStream` is reused across multiple delegate_task
        // invocations, its internal message list accumulates history; we must
        // only forward the delta of the current execution to the UI.
        this._currentExecIds = new Set<string>();
        this._currentExecParentToolCallId = options.parentToolCallId;
        this._currentExecMessageHandler = options.onMessageUpdate;
        this._currentExecConfirmToolCall = options.onConfirmToolCall;
        this._currentExecToolCallEndHandler = options.onToolCallEnd;
        this._currentHandoffStore = options.handoffStore ?? null;
        this._currentResultStore = options.resultStore ?? null;

        // Build the user message: task + optional context
        const userMessage = options.context
            ? `## Task\n${task}\n\n## Context from conversation\n${options.context}`
            : task;

        // Reuse or create a ChatStream for this execution
        const chatStream = this._getOrCreateChatStream();
        this._chatStream = chatStream;
        // Propagate the caller's context tag (typically the session id the
        // orchestrator is running inside) so tool side-effects triggered
        // from this sub-agent can be attributed back to that session.
        chatStream.contextTag = options.contextTag;

        let aborted = false;

        // Snapshot token usage before execution so we can compute the delta
        // (ChatStream.sessionTokenUsage is cumulative across reuses)
        const tokenBefore: TokenUsage = { ...chatStream.sessionTokenUsage };

        // All post-prompt work (token accounting, handoff-store auto-fill)
        // lives inside the `try` below so the `finally` can guarantee per-
        // execution state is cleared on every exit path — including
        // when `chatStream.prompt` throws. Pre-existing behaviour leaked
        // `_chatStream` / `_abortController` / `_currentExec*` on the
        // throw path, which was harmless for most users (the next
        // `execute()` overwrites them all) but tripped diagnostics that
        // asserted clean idle state between dispatches.
        try {
            try {
                await chatStream.prompt(userMessage, {
                    provider: options.provider,
                    thinkingLevel: options.thinkingLevel,
                    allowedCapabilities: options.allowedCapabilities,
                    summarizer: options.summarizer,
                    embedding: options.embedding,
                    embeddingFilter: options.embeddingFilter,
                    modelName: options.modelName,
                });
            } catch (err) {
                if (isAbortError(err)) {
                    aborted = true;
                } else {
                    throw err;
                }
            }

            const endTime = Date.now();
            const messages = [...chatStream.messages];
            // Compute delta token usage for THIS execution only
            // (sessionTokenUsage is cumulative; subtracting the snapshot gives the delta)
            const tokenAfter = chatStream.sessionTokenUsage;
            const tokenUsage: TokenUsage = {
                promptTokens: tokenAfter.promptTokens - tokenBefore.promptTokens,
                completionTokens: tokenAfter.completionTokens - tokenBefore.completionTokens,
                totalTokens: tokenAfter.totalTokens - tokenBefore.totalTokens,
            };

            // Extract the final assistant message content
            const assistantMessages = messages.filter(m => m.role === 'assistant');
            const fullContent = assistantMessages.length > 0
                ? assistantMessages[assistantMessages.length - 1]!.content
                : '';

            // Build execution log
            this._executionLog = {
                agentName: this.name,
                task,
                messages,
                toolCalls: [...this._toolCallSummaries],
                startTime,
                endTime,
                tokenUsage,
                aborted,
            };

            // Sub-agents no longer summarise/compress their results.
            // Oversized text output is handled downstream by
            // buildDelegatePayload, which promotes large text to the
            // artifact store (same three-bucket model as structured values).
            let summary: string;

            if (aborted) {
                summary = `[Sub-agent "${this.name}" was aborted. Partial result: ${safeSliceHead(fullContent, 200)}...]`;
            } else {
                summary = fullContent;
            }

            // Defensive sanitization: the summary will be embedded as a tool_result
            // content string in the main agent's request body. Some OpenAI-compatible
            // gateways reject lone UTF-16 surrogates with errors like
            // "unexpected end of hex escape". Strip any here as a final guard,
            // regardless of where they came from (streaming chunk splits, upstream
            // truncation, etc.).
            summary = stripLoneSurrogates(summary);

            // Auto-fill safety net for the "silent write" case.
            //
            // Some models treat `write_result` as the final action of the turn and
            // end without producing a text reply. Synthesize a stand-in so the
            // envelope always carries a positive signal when structured data IS
            // available. The result store is always initially empty (unlike the
            // seed store), so any entries mean the sub-agent wrote output.
            if (!aborted && !summary.trim() && this._currentResultStore) {
                const synthesized = this._synthesizeHandoffSummary(this._currentResultStore);
                if (synthesized) summary = synthesized;
            }

            return {
                summary,
                fullContent,
                toolCalls: [...this._toolCallSummaries],
                tokenUsage,
                aborted,
            };
        } finally {
            // Per-dispatch cleanup runs on every exit — normal return,
            // AbortError, or a non-Abort throw out of `chatStream.prompt`.
            // `_reusableChatStream` is intentionally kept; only the
            // per-execution references are cleared so the next dispatch
            // starts with a clean slate. See `subAgent.abort()` for the
            // cascading abort.
            this._chatStream = null;
            this._abortController = null;
            this._currentExecIds = null;
            this._currentExecParentToolCallId = undefined;
            this._currentExecMessageHandler = undefined;
            this._currentExecConfirmToolCall = undefined;
            this._currentExecToolCallEndHandler = undefined;
            this._currentHandoffStore = null;
            this._currentResultStore = null;
        }
    }

    /** Abort the current execution */
    abort(): void {
        // Abort both the inner ChatStream (so its in-flight provider /
        // tool work unwinds) AND our own controller (so any post-prompt
        // async work observes the same signal and bails out).
        this._chatStream?.abort();
        this._abortController?.abort();
    }

    /**
     * Reset the reusable context.
     *
     * Drops the cached ChatStream entirely, forcing the next execute()
     * to rebuild it (including re-registering tools and re-wiring
     * callbacks). Use this when tool/provider configuration changes
     * materially and the existing shell can no longer be trusted.
     *
     * Note: you normally do NOT need to call this just to "forget"
     * prior conversation — execute() already clears the ChatStream's
     * message history and summaries on every invocation.
     */
    resetContext(): void {
        this._reusableChatStream = null;
    }

    /** Get the execution log from the last execution */
    getExecutionLog(): SubAgentExecutionLog | null {
        return this._executionLog;
    }

    /**
     * Build a brief stand-in `summary` for the "silent write" case —
     * the sub-agent handed off structured data via write_result but
     * ended the turn without producing a text reply.
     *
     * The result store is always empty at the start of execute(), so
     * any entries mean the sub-agent produced output. Returns null
     * when the store is empty (sub-agent produced nothing).
     *
     * Wording is English on purpose — this text is read by the MAIN
     * AGENT's LLM (not the user).
     */
    private _synthesizeHandoffSummary(store: HandoffStore): string | null {
        if (store.size === 0) return null;
        const keys = Array.from(store.keys());
        return `[Sub-agent "${this.name}" produced no text reply; structured output is available under \`result\` in the envelope (keys: ${keys.join(', ')}).]`;
    }

    /**
     * Get or create a ChatStream for this execution.
     *
     * We reuse the ChatStream **shell** (provider client, registered tools,
     * callbacks wired to `_currentExec*` fields) across execute() calls,
     * but always start with a fully cleared conversation state:
     *
     *   - message history is emptied via `clearHistory()` so no prior
     *     user / assistant / tool messages leak into this task's context.
     *   - accumulated summaries are dropped for the same reason.
     *   - token usage is reset so `sessionTokenUsage` deltas measured by
     *     `execute()` correspond exactly to this single invocation.
     *
     * Rationale: a sub-agent call is semantically an isolated task, not
     * a continuation of a chat. Carrying prior tool_result content into a
     * new task encourages the model to treat stale data as authoritative
     * (e.g. "file X still contains Y") and hallucinate from it.
     *
     * Callbacks are bound to `this` (SubAgent) via closures, so the latest
     * `_currentExec*` fields — refreshed at the start of each execute() —
     * take effect automatically on the next turn without any rewiring.
     */
    private _getOrCreateChatStream(): ChatStream {
        if (this._reusableChatStream) {
            // Reuse the existing shell but wipe its conversation state so
            // this execute() starts from a clean slate.
            this._reusableChatStream.clearHistory();
            return this._reusableChatStream;
        }

        // Create a new ChatStream.
        // Note: all callbacks are bound to `this` (SubAgent) via closures so they
        // automatically pick up the latest execution context via the
        // `_currentExec*` fields refreshed at the start of each execute() call.
        const chatStream = new ChatStream({
            systemPrompt: this._config.systemPrompt,
            // Tag every LLM-call debug log with this sub-agent's name so
            // a mixed orchestration trace (main + multiple sub-agents
            // interleaving over many tool-call rounds) can be untangled
            // per agent at a glance. See `ChatStreamConfig.agentLabel`.
            agentLabel: this._config.name,
            // Inherit the same context-compression tuning as the main agent
            // (set by the orchestrator from the active profile). Without this
            // a long-running sub-agent would compress on the built-in
            // defaults regardless of how the user has configured their
            // profile, leading to inconsistent behaviour between main agent
            // and sub-agents during a single session.
            compressionOptions: this._config.compressionOptions,
            onMessageUpdate: (msg) => {
                // Track messages belonging to the current execute() call.
                // `_currentExecIds` also acts as an "inside-execute()" sentinel:
                // if execute() is not currently active (e.g. a late async
                // emission after cleanup), drop the update.
                const execIds = this._currentExecIds;
                if (!execIds) {
                    return;
                }
                execIds.add(msg.id);

                // Tag the message with its sub-agent origin so the main conversation
                // UI can render it inline with a colored side bar / badge.
                const parentToolCallId = this._currentExecParentToolCallId;
                if (parentToolCallId && !msg.subAgent) {
                    msg.subAgent = {
                        agentName: this.name,
                        parentToolCallId,
                    };
                }

                this._currentExecMessageHandler?.(this.name, msg);
            },
            onToolCallEnd: (args) => {
                // Record tool call summary
                this._toolCallSummaries.push({
                    toolName: args.toolName,
                    args: args.toolArgs,
                    resultPreview: args.result.length > 200
                        ? safeSliceHead(args.result, 200) + '...'
                        : args.result,
                    success: !args.isError,
                    elapsed: 0,
                });
                this._currentExecToolCallEndHandler?.(this.name, args.toolName, args.toolArgs, args.result, args.isError);
            },
            // Only wire confirmation when the main session is in "always"
            // mode (see chat-factory.ts). Omitting the callback matches the
            // main ChatStream and prevents auto-approved sub-agent tools from
            // setting confirmationState → "Allowed" badges.
            ...(this._toolConfirmationEnabled ? {
                onConfirmToolCall: (confirmArgs: {
                    toolName: string;
                    toolArgs: Record<string, unknown>;
                    messageId: string;
                    signal?: AbortSignal;
                }) => {
                    const handler = this._currentExecConfirmToolCall;
                    if (!handler) {
                        return Promise.resolve(true);
                    }
                    return handler(confirmArgs);
                },
            } : {}),
        });

        // Register all tools for this sub-agent
        for (const tool of this._config.tools) {
            chatStream.registerTool(tool);
        }

        // Register the built-in seed-handoff tools (`read_handoff` /
        // `list_handoff`). They read from the seed store (main → sub
        // direction). Registered unconditionally on every sub-agent;
        // when no store is wired, the tools report a clear error.
        const [readHandoffTool, listHandoffTool] =
            createHandoffTools(() => this._currentHandoffStore);
        chatStream.registerTool(readHandoffTool);
        chatStream.registerTool(listHandoffTool);

        // Register the built-in result tools (`write_result` /
        // `write_result_array` / `write_result_object`). They write to
        // the result store (sub → main direction). Same unconditional
        // registration as above.
        const [writeScalarTool, writeArrayTool, writeObjectTool] =
            createResultTools(() => this._currentResultStore);
        chatStream.registerTool(writeScalarTool);
        chatStream.registerTool(writeArrayTool);
        chatStream.registerTool(writeObjectTool);

        this._reusableChatStream = chatStream;
        return chatStream;
    }
}
