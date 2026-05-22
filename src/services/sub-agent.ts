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
import { estimateTokens, createChatCompletion, type ContextReduceOptions } from "./context-reducer";
import { safeSliceHead, safeSliceTail, stripLoneSurrogates } from "../utils/string-safe";
import { createHandoffTools, type HandoffStore } from "./tools/handoff-toolcall";

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
        'compressionThreshold' | 'slidingWindowSize' | 'maxSummariesThreshold'
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
     * Per-dispatch handoff store (key/value scratchpad shared with the
     * orchestrator). Set at the start of `execute()` from
     * `options.handoffStore`, cleared in the cleanup block — including
     * on abort / error paths.
     *
     * The handoff tools registered on the (reused) ChatStream resolve
     * this field via a getter closure at call-time, so a single
     * registration suffices across all dispatches and there is no risk
     * of leaking one dispatch's store into the next.
     *
     * `null` means "no handoff store wired for the current call"; the
     * tools report a clear error to the model in that case (rather than
     * crashing or silently no-op'ing).
     */
    private _currentHandoffStore: HandoffStore | null = null;

    constructor(config: SubAgentConfig) {
        this.name = config.name;
        this.description = config.description;
        this._config = config;
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
             * Per-dispatch handoff store. When provided, the sub-agent's
             * built-in `write_handoff` / `read_handoff` / `list_handoff`
             * tools will read/write into this map for the duration of
             * this `execute()` call. The orchestrator owns the store:
             * it creates it before calling `execute`, snapshots it
             * after, and discards it. If omitted, the handoff tools
             * will report "no store available" to the model.
             */
            handoffStore?: HandoffStore;
            /**
             * Optional opaque tag forwarded to the sub-agent's ChatStream
             * as {@link ChatStream.contextTag} for the duration of this
             * execute() call. Used by downstream side-effect logging (e.g.
             * the AI file-changes audit log) to attribute vault mutations
             * back to the parent session.
             */
            contextTag?: string;
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

        // Snapshot the handoff store's initial keys so we can later tell
        // "keys the main agent pre-loaded as inputs" from "keys the sub-agent
        // wrote back as outputs". The auto-fill safety net below only
        // synthesizes a stand-in reply when the sub-agent ACTUALLY produced
        // something new — purely-consuming runs that emit no text reply stay
        // as genuinely empty replies.
        const initialHandoffKeys: ReadonlySet<string> = options.handoffStore
            ? new Set(options.handoffStore.keys())
            : new Set<string>();

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

        // All post-prompt work (token accounting, optional LLM
        // summarization of the result, handoff-store auto-fill) lives
        // inside the `try` below so the `finally` can guarantee per-
        // execution state is cleared on every exit path — including
        // when `_summarizeResult` propagates an AbortError or
        // `chatStream.prompt` throws a non-Abort failure. Pre-existing
        // behaviour leaked `_chatStream` / `_abortController` /
        // `_currentExec*` on the throw path, which was harmless for
        // most users (the next `execute()` overwrites them all) but
        // tripped diagnostics that asserted clean idle state between
        // dispatches.
        try {
            try {
                await chatStream.prompt(userMessage, {
                    provider: options.provider,
                    thinkingLevel: options.thinkingLevel,
                    allowedCapabilities: options.allowedCapabilities,
                    summarizer: options.summarizer,
                    embedding: options.embedding,
                    embeddingFilter: options.embeddingFilter,
                });
            } catch (err) {
                if (err instanceof Error && err.name === 'AbortError') {
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

            // Determine if result needs summarization
            const resultMaxTokens = this._config.resultMaxTokens ?? 10000;
            const estimatedTokens = estimateTokens(fullContent);
            let summary: string;

            if (aborted) {
                // console.log(`[SubAgent:${this.name}] Aborted after ${endTime - startTime}ms, partial content: ${fullContent.length} chars`);
                summary = `[Sub-agent "${this.name}" was aborted. Partial result: ${safeSliceHead(fullContent, 200)}...]`;
            } else if (estimatedTokens > resultMaxTokens) {
                // Result is too large — summarize via LLM if summarizer is available
                // console.log(`[SubAgent:${this.name}] Result exceeds threshold (${estimatedTokens} tokens > ${resultMaxTokens}), attempting LLM summarization...`);
                summary = await this._summarizeResult(
                    fullContent,
                    this._toolCallSummaries,
                    options.summarizer,
                    this._abortController?.signal,
                );
            } else {
                // console.log(`[SubAgent:${this.name}] Result within threshold (${estimatedTokens} tokens <= ${resultMaxTokens}), returning as-is`);
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
            // Some models treat `write_handoff` as the final action of the turn and
            // end without producing a text reply. That leaves `summary === ""` here
            // and `payload.text === ""` in the envelope the orchestrator builds.
            // Empirically the main agent's LLM then mis-reads the empty `text` as
            // "sub-agent failed / returned nothing" and ignores the `result` field
            // sitting right next to it, even though the prompt tells it to prefer
            // `result`. Synthesize a brief stand-in here so the channel always
            // carries a positive signal when structured data IS available.
            //
            // We intentionally:
            //  - skip the abort path (its synthetic "[aborted...]" summary already
            //    explains the empty content),
            //  - require at least one NEW key (so a run that only consumed
            //    pre-loaded inputs without writing anything back stays empty,
            //    which is the truthful signal),
            //  - leave `fullContent` and the ChatStream message history untouched,
            //    so the UI's empty-bubble hide path (bubble-renderer.ts) keeps
            //    working — only the main-agent-facing summary changes.
            if (!aborted && !summary.trim() && options.handoffStore) {
                const synthesized = this._synthesizeHandoffSummary(
                    options.handoffStore,
                    initialHandoffKeys,
                );
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
            // AbortError from `_summarizeResult`, or a non-Abort throw
            // out of `chatStream.prompt`. `_reusableChatStream` is
            // intentionally kept; only the per-execution references
            // are cleared so the next dispatch starts with a clean
            // slate. See `subAgent.abort()` for the cascading abort.
            this._chatStream = null;
            this._abortController = null;
            this._currentExecIds = null;
            this._currentExecParentToolCallId = undefined;
            this._currentExecMessageHandler = undefined;
            this._currentExecConfirmToolCall = undefined;
            this._currentExecToolCallEndHandler = undefined;
            this._currentHandoffStore = null;
        }
    }

    /** Abort the current execution */
    abort(): void {
        // Abort both the inner ChatStream (so its in-flight provider /
        // tool work unwinds) AND our own controller (so the
        // post-prompt result-summarization step below can observe the
        // same signal and bail out). Without aborting `_abortController`,
        // a sub-agent that finished its main loop just before the user
        // hit stop would still happily kick off `_summarizeResult` —
        // potentially another 15–40 s of summarizer LLM work the user
        // already implicitly cancelled.
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
     * the sub-agent handed off structured data via `write_handoff` but
     * ended the turn without producing a text reply.
     *
     * Compares the store's current keys against the snapshot taken at
     * the start of `execute()` (which records the keys the main agent
     * pre-loaded as inputs). Only keys that were ADDED during the run
     * count as sub-agent output:
     *   - if `result` was added → lead with it (it's the canonical return
     *     key per the prompt contract);
     *   - any other added keys are listed as extras;
     *   - if nothing was added (pure consume / overwrite-only) → return
     *     null so the caller leaves `summary` empty, which is the
     *     truthful "the sub-agent really produced nothing" signal.
     *
     * Wording is English on purpose — this text is read by the MAIN
     * AGENT's LLM (not the user). The bracketed form mirrors the
     * `[Sub-agent "..." was aborted...]` synthetic summary used on the
     * abort path so downstream prompts treating "[Sub-agent ...]" as a
     * machine-emitted marker keep working uniformly.
     */
    private _synthesizeHandoffSummary(
        store: HandoffStore,
        initialKeys: ReadonlySet<string>,
    ): string | null {
        const addedKeys: string[] = [];
        for (const k of store.keys()) {
            if (!initialKeys.has(k)) addedKeys.push(k);
        }
        if (addedKeys.length === 0) return null;

        const hasResult = addedKeys.includes('result');
        const extras = addedKeys.filter(k => k !== 'result');

        if (hasResult && extras.length === 0) {
            return `[Sub-agent "${this.name}" produced no text reply; structured output is available under \`result\` in the envelope.]`;
        }
        if (hasResult) {
            return `[Sub-agent "${this.name}" produced no text reply; structured output is available under \`result\` (plus extras: ${extras.join(', ')}) in the envelope.]`;
        }
        return `[Sub-agent "${this.name}" produced no text reply; structured output is available under \`extras\`: ${extras.join(', ')}.]`;
    }

    /**
     * Summarize the sub-agent's result using LLM when available,
     * falling back to structured truncation when no summarizer is configured.
     */
    private async _summarizeResult(
        fullContent: string,
        toolCalls: ToolCallSummary[],
        summarizer?: MinimalModelConfig,
        signal?: AbortSignal,
    ): Promise<string> {
        // Try LLM summarization first
        if (summarizer) {
            try {
                const toolContext = toolCalls.length > 0
                    ? `\n\nTools executed during this task:\n${toolCalls.map(tc => {
                        const status = tc.success ? '✓' : '✗';
                        return `  ${status} ${tc.toolName}(${safeSliceHead(JSON.stringify(tc.args), 120)})`;
                    }).join('\n')}\n\n`
                    : '';

                const messages = [
                    {
                        role: 'system',
                        content: `You are a result summarization assistant. Your task is to condense a sub-agent's execution result into a concise but complete summary that preserves ALL key information, data, and conclusions. Do NOT lose any important facts, numbers, file paths, or actionable details. Output ONLY the summary text.`,
                    },
                    {
                        role: 'user',
                        content: `Please summarize the following sub-agent result. Preserve all key information and conclusions.${toolContext}\n---\n${fullContent}`,
                    },
                ];

                // console.log(`[SubAgent:${this.name}] Sending ${estimateTokens(fullContent)} tokens to LLM summarizer...`);
                const llmSummary = await createChatCompletion(summarizer, messages, signal);

                if (llmSummary && llmSummary.trim().length > 0) {
                    // console.log(`[SubAgent:${this.name}] LLM summarization complete: ${estimateTokens(fullContent)} → ${estimateTokens(llmSummary)} tokens`);
                    return llmSummary.trim();
                }

                console.warn(`[SubAgent:${this.name}] LLM summarizer returned empty result, falling back to truncation`);
            } catch (err) {
                // Propagate user-initiated aborts: the surrounding
                // `execute()` flow expects AbortError to bubble up so
                // the orchestrator can unwind cleanly. Without this
                // re-throw we'd silently fall back to truncation and
                // ship a "completed" sub-agent result for a turn the
                // user already cancelled.
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                console.error(`[SubAgent:${this.name}] LLM summarization failed, falling back to truncation:`, err);
            }
        } else {
            console.warn(`[SubAgent:${this.name}] No summarizer configured, falling back to truncation`);
        }

        // Fallback: structured truncation (preserves head + tail)
        return this._truncateResult(fullContent, toolCalls);
    }

    /**
     * Fallback truncation when LLM summarization is unavailable or fails.
     * Preserves both the beginning and end of the content for better context.
     */
    private _truncateResult(fullContent: string, toolCalls: ToolCallSummary[]): string {
        const parts: string[] = [];

        // Add tool call summaries
        if (toolCalls.length > 0) {
            const toolSummary = toolCalls.map(tc => {
                const status = tc.success ? '✓' : '✗';
                return `  ${status} ${tc.toolName}: ${safeSliceHead(tc.resultPreview, 150)}`;
            }).join('\n');
            parts.push(`Tools executed:\n${toolSummary}`);
        }

        // Preserve head + tail for better context
        const maxChars = 20000;
        if (fullContent.length > maxChars) {
            const headSize = Math.floor(maxChars * 0.7);
            const tailSize = Math.floor(maxChars * 0.3);
            parts.push(
                `Result (truncated, original ${fullContent.length} chars):\n` +
                `${safeSliceHead(fullContent, headSize)}\n` +
                `\n... [${fullContent.length - headSize - tailSize} chars omitted] ...\n\n` +
                `${safeSliceTail(fullContent, tailSize)}`
            );
        } else {
            parts.push(`Result:\n${fullContent}`);
        }

        return parts.join('\n\n');
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
            onConfirmToolCall: (confirmArgs) => {
                // Forward confirmation requests to the main agent's UI.
                // If no handler is wired (e.g. single-agent tests), default to approve
                // to preserve previous behaviour.
                const handler = this._currentExecConfirmToolCall;
                if (!handler) {
                    return Promise.resolve(true);
                }
                return handler(confirmArgs);
            },
        });

        // Register all tools for this sub-agent
        for (const tool of this._config.tools) {
            chatStream.registerTool(tool);
        }

        // Register the built-in handoff tools (`write_handoff` /
        // `read_handoff` / `list_handoff`). They are registered
        // unconditionally on every sub-agent: when no handoff store is
        // wired for the current execute() call, the tools report a clear
        // "no store available" error to the model rather than crashing.
        //
        // The handlers resolve the *current* store at call-time via the
        // shared getter closure below. This way a single registration
        // pass on the reused ChatStream shell correctly tracks per-
        // dispatch stores without re-registering tools on every
        // execute() call.
        const [writeHandoffTool, readHandoffTool, listHandoffTool] =
            createHandoffTools(() => this._currentHandoffStore);
        chatStream.registerTool(writeHandoffTool);
        chatStream.registerTool(readHandoffTool);
        chatStream.registerTool(listHandoffTool);

        this._reusableChatStream = chatStream;
        return chatStream;
    }
}
