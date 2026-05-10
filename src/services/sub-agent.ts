/**
 * Sub-Agent: A lightweight wrapper around ChatStream that executes
 * a specific task with a dedicated tool set and independent context.
 *
 * Sub-agents are created and managed by the AgentOrchestrator.
 * Each sub-agent has its own ChatStream instance, system prompt,
 * and tool set. It executes a task and returns a refined result
 * to the main agent.
 */

import { ChatStream, ChatMessage, RegisteredTool } from "./chat-stream";
import type { LLMProvider, TokenUsage, ThinkingLevel, ToolCapability, MinimalModelConfig } from "./llm-provider";
import { estimateTokens, createChatCompletion, type ContextReduceOptions } from "./context-reducer";
import { safeSliceHead, safeSliceTail, stripLoneSurrogates } from "../utils/string-safe";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Configuration for a sub-agent */
export interface SubAgentConfig {
    /** Unique identifier for this sub-agent (e.g., "vault", "web", "code") */
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
     * Reusable ChatStream instance for session-level context reuse.
     * When enabled, the same ChatStream is reused across multiple
     * execute() calls within the same session, preserving summaries
     * and reducing redundant context.
     */
    private _reusableChatStream: ChatStream | null = null;
    private _executionCount = 0;

    /** Maximum number of executions before resetting the reusable context */
    private static readonly MAX_REUSE_COUNT = 10;

    /**
     * IDs of messages produced during the current execute() call.
     * Used to filter out stale messages from `_reusableChatStream` when
     * the same ChatStream instance is reused across multiple invocations.
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
             */
            onConfirmToolCall?: (args: {
                toolName: string;
                toolArgs: Record<string, unknown>;
                messageId: string;
            }) => Promise<boolean>;
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

        // Build the user message: task + optional context
        const userMessage = options.context
            ? `## Task\n${task}\n\n## Context from conversation\n${options.context}`
            : task;

        // Reuse or create a ChatStream for this execution
        const chatStream = this._getOrCreateChatStream();
        this._chatStream = chatStream;

        let aborted = false;

        // Snapshot token usage before execution so we can compute the delta
        // (ChatStream.sessionTokenUsage is cumulative across reuses)
        const tokenBefore: TokenUsage = { ...chatStream.sessionTokenUsage };

        try {
            await chatStream.prompt(userMessage, {
                provider: options.provider,
                thinkingLevel: options.thinkingLevel,
                allowedCapabilities: options.allowedCapabilities,
                summarizer: options.summarizer,
                embedding: options.embedding,
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
            summary = await this._summarizeResult(fullContent, this._toolCallSummaries, options.summarizer);
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

        // Clean up active references (but keep _reusableChatStream for reuse)
        this._chatStream = null;
        this._abortController = null;
        this._currentExecIds = null;
        this._currentExecParentToolCallId = undefined;
        this._currentExecMessageHandler = undefined;
        this._currentExecConfirmToolCall = undefined;
        this._currentExecToolCallEndHandler = undefined;
        this._executionCount++;

        return {
            summary,
            fullContent,
            toolCalls: [...this._toolCallSummaries],
            tokenUsage,
            aborted,
        };
    }

    /** Abort the current execution */
    abort(): void {
        this._chatStream?.abort();
    }

    /**
     * Reset the reusable context.
     * Call this when the conversation topic changes significantly
     * or when you want to start fresh.
     */
    resetContext(): void {
        this._reusableChatStream = null;
        this._executionCount = 0;
    }

    /** Get the execution log from the last execution */
    getExecutionLog(): SubAgentExecutionLog | null {
        return this._executionLog;
    }

    /**
     * Summarize the sub-agent's result using LLM when available,
     * falling back to structured truncation when no summarizer is configured.
     */
    private async _summarizeResult(
        fullContent: string,
        toolCalls: ToolCallSummary[],
        summarizer?: MinimalModelConfig,
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
                const llmSummary = await createChatCompletion(summarizer, messages);

                if (llmSummary && llmSummary.trim().length > 0) {
                    const summaryTokens = estimateTokens(llmSummary);
                    // console.log(`[SubAgent:${this.name}] LLM summarization complete: ${estimateTokens(fullContent)} → ${summaryTokens} tokens (${((1 - summaryTokens / estimateTokens(fullContent)) * 100).toFixed(1)}% reduction)`);
                    return llmSummary.trim();
                }

                console.warn(`[SubAgent:${this.name}] LLM summarizer returned empty result, falling back to truncation`);
            } catch (err) {
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
     * Implements session-level context reuse: the same ChatStream is reused
     * across multiple execute() calls, preserving summaries and reducing
     * redundant context. Resets after MAX_REUSE_COUNT executions.
     *
     * All callbacks wired on the ChatStream read from `this._currentExec*`
     * fields, which are refreshed at the start of each execute() call.
     * This ensures that when the ChatStream is reused, the latest callbacks
     * take effect without needing to rewire.
     */
    private _getOrCreateChatStream(): ChatStream {
        // Reset if we've exceeded the reuse limit
        if (this._executionCount >= SubAgent.MAX_REUSE_COUNT) {
            this.resetContext();
        }

        if (this._reusableChatStream) {
            // Reuse existing ChatStream — callbacks are bound to `this` (SubAgent)
            // via closures, so they automatically pick up the latest state
            // (e.g., _toolCallSummaries is re-assigned each execute() call).
            // The ChatStream retains its summaries but we start a fresh prompt cycle.
            return this._reusableChatStream;
        }

        // Create a new ChatStream.
        // Note: all callbacks are bound to `this` (SubAgent) via closures so they
        // automatically pick up the latest execution context via the
        // `_currentExec*` fields refreshed at the start of each execute() call.
        const chatStream = new ChatStream({
            systemPrompt: this._config.systemPrompt,
            // Inherit the same context-compression tuning as the main agent
            // (set by the orchestrator from the active profile). Without this
            // a long-running sub-agent would compress on the built-in
            // defaults regardless of how the user has configured their
            // profile, leading to inconsistent behaviour between main agent
            // and sub-agents during a single session.
            compressionOptions: this._config.compressionOptions,
            onMessageUpdate: (msg) => {
                // Track and tag messages belonging to the current execute() call.
                // When the same ChatStream is reused, older messages from previous
                // invocations must NOT be forwarded to the UI again.
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
            onConfirmToolCall: async (confirmArgs) => {
                // Forward confirmation requests to the main agent's UI.
                // If no handler is wired (e.g. single-agent tests), default to approve
                // to preserve previous behaviour.
                const handler = this._currentExecConfirmToolCall;
                if (!handler) {
                    return true;
                }
                return handler(confirmArgs);
            },
        });

        // Register all tools for this sub-agent
        for (const tool of this._config.tools) {
            chatStream.registerTool(tool);
        }

        this._reusableChatStream = chatStream;
        return chatStream;
    }
}
