/**
 * AgentOrchestrator: Manages a main-agent + sub-agent architecture.
 *
 * The main-agent maintains a clean conversation context and delegates
 * specific tasks to specialized sub-agents via the `delegate_task` tool.
 * Each sub-agent has its own ChatStream, tools, and independent context.
 *
 * Design principles:
 * - The orchestrator exposes the same public interface as ChatStream
 *   so SessionView can switch to it with minimal changes.
 * - Sub-agent execution logs are stored for UI display but NOT persisted
 *   (only the refined result is kept in main-agent's context).
 * - Abort cascades from main-agent to all active sub-agents.
 */

import {
    ChatStream,
    ChatMessage,
    ChatStreamConfig,
    ChatSessionState,
    RegisteredTool,
    ToolCallResult,
    IChatAgent,
    AgentTokenBreakdown,
    SUMMARIZER_SYSTEM_PROMPT,
} from "./chat-stream";
import type { ConversationSummary } from "./context-reducer";
import type {
    LLMProvider,
    TokenUsage,
    ThinkingLevel,
    ToolCapability,
    MinimalModelConfig,
    ToolDefinition,
} from "./llm-provider";
import { SubAgent, SubAgentConfig, SubAgentResult, SubAgentExecutionLog } from "./sub-agent";

// Re-export sub-agent types for external consumers
export type { SubAgentConfig, SubAgentResult, SubAgentExecutionLog };

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/**
 * Configuration for the AgentOrchestrator.
 * Extends ChatStreamConfig with sub-agent specific options.
 */
export interface AgentOrchestratorConfig extends ChatStreamConfig {
    /** Sub-agent configurations */
    subAgents: SubAgentConfig[];

    /** Called when a sub-agent starts executing a task */
    onSubAgentStart?: (agentName: string, task: string) => void;
    /** Called when a sub-agent finishes executing a task */
    onSubAgentEnd?: (agentName: string, result: SubAgentResult) => void;
    /** Called when a sub-agent sends a message update (for real-time UI) */
    onSubAgentMessageUpdate?: (agentName: string, msg: ChatMessage) => void;
    /** Called when a sub-agent completes a tool call (for real-time progress display) */
    onSubAgentToolCallEnd?: (agentName: string, toolName: string, args: Record<string, unknown>, result: string, isError: boolean) => void;
}

// ─────────────────────────────────────────────
// AgentOrchestrator
// ─────────────────────────────────────────────

export class AgentOrchestrator implements IChatAgent {
    private readonly _config: AgentOrchestratorConfig;
    private readonly _mainAgent: ChatStream;
    private readonly _subAgents: Map<string, SubAgent> = new Map();

    /** Currently active sub-agent (if any) */
    private _activeSubAgent: SubAgent | null = null;

    /**
     * Messages produced by sub-agents during `delegate_task` invocations,
     * keyed by the main-agent's toolCallId of the corresponding delegate_task.
     * Stored separately from the main agent's message list so they don't
     * pollute the LLM context, but persisted alongside for UI restoration.
     */
    private _subAgentMessages: Map<string, ChatMessage[]> = new Map();

    /** Execution logs from sub-agents (for UI display, not persisted) */
    private _subAgentLogs: SubAgentExecutionLog[] = [];

    /** Aggregated token usage across all sub-agents combined (kept for backward-compat) */
    private _totalSubAgentTokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    /**
     * Per-sub-agent cumulative token usage, keyed by sub-agent name.
     * Used to render a detailed breakdown in the status panel and for persistence.
     */
    private _subAgentTokenUsagePerAgent: Map<string, TokenUsage> = new Map();

    constructor(config: AgentOrchestratorConfig) {
        this._config = config;

        // Create sub-agents from config FIRST so the onToolCall fallback below
        // can inspect `this._subAgents` when the main ChatStream invokes it.
        for (const subConfig of config.subAgents) {
            this._subAgents.set(subConfig.name, new SubAgent(subConfig));
        }

        // Create the main agent with the delegate_task tool injected
        // We intercept the original config callbacks to add orchestration logic
        this._mainAgent = new ChatStream({
            ...config,
            // Dynamic tools: include delegate_task + any user-provided dynamic tools
            dynamicTools: () => {
                const userDynamic = config.dynamicTools?.() ?? [];
                return [...userDynamic, this._createDelegateTaskTool()];
            },
            // Defensive fallback for unregistered tool calls.
            // Some weaker / OpenAI-compat models occasionally hallucinate tool
            // names by picking values from the `delegate_task.agent` enum (e.g.
            // they call a tool literally named "vault" / "web" / "code" instead
            // of calling `delegate_task({ agent: "vault", ... })`). Rather than
            // aborting the whole turn, transparently route such calls through
            // the real delegate_task dispatcher and return a friendly tool_result
            // for anything we still cannot resolve, so the LLM can self-correct.
            onToolCall: async (args): Promise<string> => {
                // Honour a user-supplied onToolCall first if any.
                if (config.onToolCall) {
                    return config.onToolCall(args);
                }

                const { toolName, toolArgs, toolCallId } = args;

                // Case 1: tool name matches a known sub-agent → treat it as a
                // delegate_task call with the corresponding agent.
                if (this._subAgents.has(toolName)) {
                    const task = typeof toolArgs["task"] === "string"
                        ? toolArgs["task"] as string
                        : typeof toolArgs["input"] === "string"
                            ? toolArgs["input"] as string
                            : JSON.stringify(toolArgs);
                    const taskContext = typeof toolArgs["context"] === "string"
                        ? toolArgs["context"] as string
                        : undefined;

                    console.warn(
                        `[AgentOrchestrator] Model called tool "${toolName}" directly; ` +
                        `routing to delegate_task(agent="${toolName}"). ` +
                        `Prompt / model-side fix recommended.`
                    );

                    const result = await this._dispatchSubAgent({
                        agentName: toolName,
                        task,
                        taskContext,
                        parentToolCallId: toolCallId,
                    });
                    return result.content;
                }

                // Case 2: genuinely unknown tool — return an error tool_result
                // so the LLM can self-correct on the next turn instead of
                // bringing down the whole conversation.
                const available = [
                    'delegate_task',
                    ...Array.from(this._subAgents.keys()).map(n => `delegate_task(agent="${n}")`),
                ].join(', ');
                return `Error: Unknown tool "${toolName}". ` +
                    `This tool is not registered on the main agent. ` +
                    `Available delegation paths: ${available}. ` +
                    `Remember: sub-agents (vault/web/code) are NOT callable as tool names — ` +
                    `you must call the "delegate_task" tool with the "agent" parameter set to their name.`;
            },
        });

        // Register static tools that belong to the main agent
        // (These are tools NOT delegated to sub-agents, e.g., memory, conversation, builtin)
        // The caller is responsible for registering these via registerMainAgentTool()
    }

    // ── Public interface (compatible with ChatStream) ────────────────────────

    /** Read-only snapshot of the main agent's message history */
    get messages(): ReadonlyArray<ChatMessage> {
        return this._mainAgent.messages;
    }

    /** Current session state (delegates to main agent) */
    get state(): ChatSessionState {
        return this._mainAgent.state;
    }

    /**
     * Cumulative token usage: main-agent + all sub-agents combined.
     */
    get sessionTokenUsage(): TokenUsage {
        const main = this._mainAgent.sessionTokenUsage;
        return {
            promptTokens: main.promptTokens + this._totalSubAgentTokenUsage.promptTokens,
            completionTokens: main.completionTokens + this._totalSubAgentTokenUsage.completionTokens,
            totalTokens: main.totalTokens + this._totalSubAgentTokenUsage.totalTokens,
        };
    }

    /** Current conversation turn number */
    get currentTurn(): number {
        return this._mainAgent.currentTurn;
    }

    /** Get all conversation summaries (for persistence) */
    get summaries(): ConversationSummary[] {
        return this._mainAgent.summaries;
    }

    /** Get sub-agent execution logs (for UI display) */
    get subAgentLogs(): ReadonlyArray<SubAgentExecutionLog> {
        return [...this._subAgentLogs];
    }

    /**
     * Per-agent cumulative token usage split (main + each sub-agent by name).
     * Returned value is a snapshot; mutations by the caller do not affect internal state.
     */
    get agentTokenBreakdown(): AgentTokenBreakdown {
        const subAgents: Record<string, TokenUsage> = {};
        for (const [name, usage] of this._subAgentTokenUsagePerAgent) {
            subAgents[name] = { ...usage };
        }
        return {
            main: this._mainAgent.sessionTokenUsage,
            subAgents,
        };
    }

    /**
     * Restore the per-agent token usage breakdown from persisted data.
     * Rebuilds both the per-agent map and the aggregate `_totalSubAgentTokenUsage`
     * so that future reads of `sessionTokenUsage` remain consistent.
     *
     * Must be called AFTER `restoreState` (which stuffs the combined total into
     * main-agent's session usage); this method then corrects main-agent's usage
     * by overwriting it with the historical `breakdown.main`.
     */
    restoreAgentTokenBreakdown(breakdown: AgentTokenBreakdown): void {
        // Correct main-agent's own usage (restoreState had stuffed the combined total).
        this._mainAgent.setSessionTokenUsage(breakdown.main);

        // Rebuild per-agent map and aggregate total from scratch.
        this._subAgentTokenUsagePerAgent.clear();
        let aggPrompt = 0, aggCompletion = 0, aggTotal = 0;
        for (const [name, usage] of Object.entries(breakdown.subAgents)) {
            this._subAgentTokenUsagePerAgent.set(name, { ...usage });
            aggPrompt += usage.promptTokens;
            aggCompletion += usage.completionTokens;
            aggTotal += usage.totalTokens;
        }
        this._totalSubAgentTokenUsage = {
            promptTokens: aggPrompt,
            completionTokens: aggCompletion,
            totalTokens: aggTotal,
        };
    }

    /** Clear all history and reset state */
    clearHistory(): void {
        this._mainAgent.clearHistory();
        this._subAgentLogs = [];
        this._subAgentMessages.clear();
        this._totalSubAgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        this._subAgentTokenUsagePerAgent.clear();
        // Reset all sub-agent contexts when clearing history
        for (const agent of this._subAgents.values()) {
            agent.resetContext();
        }
    }

    /** Restore state from a previous session */
    restoreState(messages: ReadonlyArray<ChatMessage>, tokenUsage: TokenUsage, summaries?: ConversationSummary[]): void {
        this._mainAgent.restoreState(messages, tokenUsage, summaries);
    }

    /** Restore summaries from a previous session */
    restoreSummaries(summaries: ConversationSummary[]): void {
        this._mainAgent.restoreSummaries(summaries);
    }

    // ── Sub-agent inline display (IChatAgent interface) ──

    /** Get sub-agent messages for a given delegate_task toolCallId */
    getSubAgentMessages(parentToolCallId: string): ReadonlyArray<ChatMessage> {
        return this._subAgentMessages.get(parentToolCallId) ?? [];
    }

    /** Get all sub-agent messages keyed by parentToolCallId (for persistence) */
    getAllSubAgentMessages(): ReadonlyMap<string, ChatMessage[]> {
        return this._subAgentMessages;
    }

    /** Restore sub-agent messages from persisted data */
    restoreSubAgentMessages(map: Record<string, ChatMessage[]>): void {
        this._subAgentMessages.clear();
        for (const [parentToolCallId, messages] of Object.entries(map)) {
            this._subAgentMessages.set(parentToolCallId, messages.map(m => ({ ...m })));
        }
    }

    /**
     * Abort the current operation.
     * Cascades to the active sub-agent if one is running.
     */
    abort(): void {
        // Abort active sub-agent first
        if (this._activeSubAgent) {
            this._activeSubAgent.abort();
            this._activeSubAgent = null;
        }
        // Then abort main agent
        this._mainAgent.abort();
    }

    /**
     * Register a tool on the main agent.
     * Use this for tools that should stay on the main agent
     * (e.g., memory, conversation, builtin).
     */
    registerMainAgentTool(tool: RegisteredTool): void {
        this._mainAgent.registerTool(tool);
    }

    /**
     * Register a tool (IChatAgent interface compatibility).
     * Delegates to registerMainAgentTool.
     */
    registerTool(tool: RegisteredTool): void {
        this.registerMainAgentTool(tool);
    }

    /**
     * Send a user message and trigger the AI response flow.
     * Delegates to the main agent's prompt(), which may invoke
     * sub-agents via the delegate_task tool.
     */
    async prompt(
        userInput: string,
        options: {
            provider: LLMProvider;
            thinkingLevel?: ThinkingLevel;
            allowedCapabilities?: ToolCapability[];
            summarizer?: MinimalModelConfig;
            embedding?: MinimalModelConfig;
        },
    ): Promise<void> {
        // Store options for sub-agent use during this prompt cycle
        this._currentPromptOptions = options;

        try {
            await this._mainAgent.prompt(userInput, options);
        } finally {
            this._currentPromptOptions = null;
        }
    }

    /** Options from the current prompt() call, used by delegate_task */
    private _currentPromptOptions: {
        provider: LLMProvider;
        thinkingLevel?: ThinkingLevel;
        allowedCapabilities?: ToolCapability[];
        summarizer?: MinimalModelConfig;
        embedding?: MinimalModelConfig;
    } | null = null;

    // ── Private: delegate_task tool ──────────────────────────────────────────

    /**
     * Shared dispatcher that runs a sub-agent and returns a ToolCallResult-like
     * `{ success, content }` payload. Used by both the `delegate_task` tool's
     * `exec` handler and the defensive `onToolCall` fallback (which transparently
     * routes raw sub-agent-named tool calls through the same dispatch path).
     */
    private async _dispatchSubAgent(params: {
        agentName: string;
        task: string;
        taskContext?: string;
        parentToolCallId?: string;
    }): Promise<{ success: boolean; content: string }> {
        const { agentName, task, taskContext, parentToolCallId } = params;
        const agentNames = Array.from(this._subAgents.keys());

        const subAgent = this._subAgents.get(agentName);
        if (!subAgent) {
            return {
                success: false,
                content: `Error: Unknown sub-agent "${agentName}". Available: ${agentNames.join(', ')}`,
            };
        }

        if (!this._currentPromptOptions) {
            return {
                success: false,
                content: "Error: No active prompt options available for sub-agent execution.",
            };
        }

        // Notify UI that sub-agent is starting
        this._config.onSubAgentStart?.(agentName, task);
        this._activeSubAgent = subAgent;

        // Prepare the per-parent bucket to collect sub-agent messages
        // so the UI can render them inline and they can be persisted.
        if (parentToolCallId) {
            this._subAgentMessages.set(parentToolCallId, []);
        }

        try {
            const result = await subAgent.execute(task, {
                provider: this._currentPromptOptions.provider,
                thinkingLevel: this._currentPromptOptions.thinkingLevel,
                allowedCapabilities: this._currentPromptOptions.allowedCapabilities,
                summarizer: this._currentPromptOptions.summarizer,
                embedding: this._currentPromptOptions.embedding,
                context: taskContext,
                parentToolCallId,
                onMessageUpdate: (name, msg) => {
                    // Store / update the sub-agent message in our per-parent bucket
                    if (parentToolCallId) {
                        const bucket = this._subAgentMessages.get(parentToolCallId);
                        if (bucket) {
                            const idx = bucket.findIndex(m => m.id === msg.id);
                            if (idx >= 0) {
                                bucket[idx] = { ...msg };
                            } else {
                                bucket.push({ ...msg });
                            }
                        }
                    }
                    this._config.onSubAgentMessageUpdate?.(name, msg);
                },
                onToolCallEnd: (name, toolName, toolArgs, result, isError) => {
                    this._config.onSubAgentToolCallEnd?.(name, toolName, toolArgs, result, isError);
                },
                // Forward the user-level confirmation callback so that
                // sub-agent tools requiring confirmation also go through
                // the main UI's allow / reject flow.
                onConfirmToolCall: this._config.onConfirmToolCall,
            });

            // Accumulate sub-agent token usage (both aggregate and per-agent)
            this._totalSubAgentTokenUsage.promptTokens += result.tokenUsage.promptTokens;
            this._totalSubAgentTokenUsage.completionTokens += result.tokenUsage.completionTokens;
            this._totalSubAgentTokenUsage.totalTokens += result.tokenUsage.totalTokens;

            const perAgent = this._subAgentTokenUsagePerAgent.get(agentName)
                ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            perAgent.promptTokens += result.tokenUsage.promptTokens;
            perAgent.completionTokens += result.tokenUsage.completionTokens;
            perAgent.totalTokens += result.tokenUsage.totalTokens;
            this._subAgentTokenUsagePerAgent.set(agentName, perAgent);

            // Store execution log
            const log = subAgent.getExecutionLog();
            if (log) {
                this._subAgentLogs.push(log);
            }

            // Notify UI that sub-agent finished
            this._config.onSubAgentEnd?.(agentName, result);

            if (result.aborted) {
                return {
                    success: false,
                    content: `Sub-agent "${agentName}" was aborted before completing the task.`,
                };
            }

            return {
                success: true,
                content: result.summary,
            };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));

            // If it's an abort, re-throw to let ChatStream handle it
            if (error.name === 'AbortError') {
                throw err;
            }

            return {
                success: false,
                content: `Error executing sub-agent "${agentName}": ${error.message}`,
            };
        } finally {
            this._activeSubAgent = null;
        }
    }

    /**
     * Create the delegate_task tool that the main agent uses to invoke sub-agents.
     */
    private _createDelegateTaskTool(): RegisteredTool {
        const agentNames = Array.from(this._subAgents.keys());
        const agentDescriptions = Array.from(this._subAgents.entries())
            .map(([name, agent]) => `- "${name}": ${agent.description}`)
            .join('\n');

        return {
            ondemand: false,

            schema: {
                type: "function",
                function: {
                    name: "delegate_task",
                    description:
                        `Delegate a specific task to a specialized sub-agent. ` +
                        `Use this when the task requires specific tools or capabilities that you don't have directly. ` +
                        `Available sub-agents:\n${agentDescriptions}\n\n` +
                        `The sub-agent will execute the task independently and return a refined result.\n\n` +
                        `IMPORTANT: The sub-agent names (${agentNames.map(n => `"${n}"`).join(', ')}) are ONLY valid as ` +
                        `values of the "agent" parameter of THIS tool. They are NOT standalone tool names — ` +
                        `do NOT attempt to call a tool literally named "${agentNames[0] ?? 'vault'}" etc.; ` +
                        `always call the tool "delegate_task" and set "agent" accordingly.`,
                    parameters: {
                        type: "object",
                        properties: {
                            agent: {
                                type: "string",
                                enum: agentNames,
                                description: "The sub-agent to delegate to.",
                            },
                            task: {
                                type: "string",
                                description: "Clear description of the task for the sub-agent to execute.",
                            },
                            context: {
                                type: "string",
                                description: "Optional additional context from the conversation that the sub-agent needs.",
                            },
                        },
                        required: ["agent", "task"],
                    },
                },
            },
            exec: async (_chatStream, args, _signal, context): Promise<ToolCallResult> => {
                const agentName = args["agent"] as string;
                const task = args["task"] as string;
                const taskContext = args["context"] as string | undefined;
                const parentToolCallId = context?.toolCallId;

                const result = await this._dispatchSubAgent({
                    agentName,
                    task,
                    taskContext,
                    parentToolCallId,
                });
                return {
                    success: result.success,
                    type: "text",
                    content: result.content,
                };
            },
        };
    }
}
