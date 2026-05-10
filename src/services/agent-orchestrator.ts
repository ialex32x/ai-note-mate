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
} from "./chat-stream";
import type { ConversationSummary } from "./context-reducer";
import type {
    LLMProvider,
    TokenUsage,
    ThinkingLevel,
    ToolCapability,
    MinimalModelConfig,
} from "./llm-provider";
import { SubAgent, SubAgentConfig, SubAgentResult, SubAgentExecutionLog } from "./sub-agent";
import { type ExchangeStore, estimateValueSize, validateSerializable } from "./tools/exchange-toolcall";

// Re-export sub-agent types for external consumers
export type { SubAgentConfig, SubAgentResult, SubAgentExecutionLog };

// ─────────────────────────────────────────────
// delegate_task payload envelope
// ─────────────────────────────────────────────

/**
 * Per-key serialized-size cap for values returned via the exchange channel.
 * Values whose `JSON.stringify(value).length` exceeds this cap are dropped
 * from the envelope and replaced with a `{<key>_omitted: true, <key>_size: N}`
 * marker, so the main agent learns the value existed and how big it was
 * without blowing its context window.
 *
 * 32 KB is a balance between "almost all useful structured returns fit"
 * (lists of paths, plans with a handful of steps, verdicts) and "we don't
 * accidentally pull a whole document into main-agent context". If real
 * workloads need more, raise it deliberately rather than chasing the cap.
 */
export const EXCHANGE_VALUE_MAX_BYTES = 32 * 1024;

/**
 * The envelope returned to the main agent as the `delegate_task` tool_result
 * content (after `JSON.stringify`). Always carries `text`; `result` and
 * `extras` are omitted (not set to `null`) when the sub-agent did not
 * populate them, so the JSON stays compact for the common case.
 *
 * Exported for tests.
 */
export interface DelegatePayload {
    /** Human-readable summary — the sub-agent's last assistant text, same as before exchange existed. */
    text: string;
    /** Canonical structured return value, present iff the sub-agent put something under key "result". */
    result?: unknown;
    /** Auxiliary keys the sub-agent put under names other than "result". */
    extras?: Record<string, unknown>;
    /**
     * Per-key oversized-drop markers, e.g. `{ "result_omitted": true,
     * "result_size": 51234 }`. Present iff at least one value was dropped.
     * Sits at the top level (not nested under `extras`) so the main LLM
     * sees it without parsing extras unnecessarily.
     */
    omitted?: Record<string, true | number>;
}

/**
 * Build the envelope returned to the main agent for a successful
 * `delegate_task` invocation. The store is read once and never retained
 * (the orchestrator drops its reference immediately after this call).
 *
 * Behaviour:
 * - The sub-agent's text summary is always carried as `text`.
 * - The reserved key `"result"` (if present) is lifted to a top-level
 *   `result` field; everything else lives under `extras`.
 * - Any value larger than `EXCHANGE_VALUE_MAX_BYTES` is dropped and
 *   recorded under `omitted` as both an `_omitted: true` flag and an
 *   `_size: N` byte count, so the main LLM can decide whether to ask
 *   the sub-agent to re-run with a leaner output.
 *
 * Exported for tests.
 */
export function buildDelegatePayload(text: string, store: ExchangeStore): DelegatePayload {
    const payload: DelegatePayload = { text };
    let omitted: Record<string, true | number> | undefined;
    let extras: Record<string, unknown> | undefined;

    for (const [key, value] of store.entries()) {
        const size = estimateValueSize(value);
        if (size > EXCHANGE_VALUE_MAX_BYTES) {
            // Oversized — drop the value but tell the main agent it existed
            // and how large it was, so it can react (e.g. re-delegate with a
            // narrower scope) instead of silently losing data.
            omitted ??= {};
            omitted[`${key}_omitted`] = true;
            omitted[`${key}_size`] = size;
            continue;
        }

        if (key === "result") {
            payload.result = value;
        } else {
            extras ??= {};
            extras[key] = value;
        }
    }

    if (extras) payload.extras = extras;
    if (omitted) payload.omitted = omitted;
    return payload;
}

// ─────────────────────────────────────────────
// delegate_task inputs (main → sub direction)
// ─────────────────────────────────────────────

/**
 * Error thrown when the main agent supplies an `inputs` object on
 * `delegate_task` that cannot be safely handed to the sub-agent (non-
 * serializable value, or a single value that exceeds the per-key size cap).
 *
 * We surface this as a hard failure (caught by `_dispatchSubAgent` and
 * converted to a `success: false` tool_result) rather than silently
 * dropping or mangling the input, because:
 *  - inputs are programmatic by design (the main LLM constructed them
 *    deliberately); silently losing one would change the sub-agent's
 *    interpretation of the task in ways the main agent cannot detect;
 *  - the main LLM gets a clear error message and can self-correct on the
 *    next turn (e.g. re-delegate with the input narrowed or moved into
 *    `task` prose).
 *
 * This is asymmetric with the *output* side (`buildDelegatePayload`),
 * which degrades oversized values to `omitted` markers — there the cost
 * of generation has already been paid, so soft degradation is preferable
 * to a hard failure that wastes the sub-agent's whole turn.
 */
export class InvalidDelegateInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidDelegateInputError";
    }
}

/**
 * Build the initial exchange store for a `delegate_task` dispatch from the
 * main agent's `inputs` argument. Each (key, value) pair becomes a
 * pre-populated entry the sub-agent can read via `exchange.get(key)` /
 * `exchange.list()` before deciding how to act.
 *
 * Validation rules (mirrored from the exchange tool's `put` path so the
 * main → sub direction has the same safety guarantees as the sub → sub
 * direction):
 *  - `inputs` may be `undefined` / `null` / an empty object → returns an
 *    empty store; this is the common case (no structured input).
 *  - `inputs` MUST be a plain object (not an array, not a class instance);
 *    keys are strings, values are JSON-serializable per
 *    `validateSerializable`.
 *  - Each value's serialized size MUST be ≤ `EXCHANGE_VALUE_MAX_BYTES`.
 *    Oversized inputs are REJECTED (not truncated) — see
 *    `InvalidDelegateInputError` doc for rationale.
 *
 * Exported for tests.
 */
export function buildInitialStore(inputs?: Record<string, unknown> | null): ExchangeStore {
    const store: ExchangeStore = new Map();
    if (inputs === undefined || inputs === null) {
        return store;
    }

    // Reject anything that isn't a plain object. Arrays / Maps / class
    // instances would silently lose structure when treated as a kv bag.
    if (typeof inputs !== "object" || Array.isArray(inputs)) {
        throw new InvalidDelegateInputError(
            `inputs must be a plain object mapping string keys to JSON-serializable values; got ${Array.isArray(inputs) ? "array" : typeof inputs}.`
        );
    }
    const proto: object | null = Object.getPrototypeOf(inputs) as object | null;
    if (proto !== null && proto !== Object.prototype) {
        throw new InvalidDelegateInputError(
            `inputs must be a plain object (Object.prototype or null prototype); got an instance of ${proto?.constructor?.name ?? "<unknown>"}.`
        );
    }

    for (const [key, value] of Object.entries(inputs)) {
        // Same key constraints the exchange tool enforces internally — keep
        // them aligned so a key accepted as input is also a legal key for
        // the sub-agent's later `exchange.put` overwrites.
        if (key.length === 0) {
            throw new InvalidDelegateInputError(`inputs contains an empty key.`);
        }

        const reason = validateSerializable(value);
        if (reason !== null) {
            throw new InvalidDelegateInputError(
                `inputs[${JSON.stringify(key)}] is not JSON-serializable: ${reason}`
            );
        }

        const size = estimateValueSize(value);
        if (size > EXCHANGE_VALUE_MAX_BYTES) {
            throw new InvalidDelegateInputError(
                `inputs[${JSON.stringify(key)}] is too large (${size} bytes > ${EXCHANGE_VALUE_MAX_BYTES} cap); ` +
                `narrow the input or pass a reference (e.g. a vault path) and let the sub-agent fetch it.`
            );
        }

        store.set(key, value);
    }

    return store;
}

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
            // they call a tool literally named "vault_inspector" / "web" / "code"
            // instead of calling `delegate_task({ agent: "vault_inspector", ... })`).
            // Rather than aborting the whole turn, transparently route such calls
            // through the real delegate_task dispatcher and return a friendly
            // tool_result for anything we still cannot resolve, so the LLM can
            // self-correct.
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
                        ? toolArgs["task"]
                        : typeof toolArgs["input"] === "string"
                            ? toolArgs["input"]
                            : JSON.stringify(toolArgs);
                    const taskContext = typeof toolArgs["context"] === "string"
                        ? toolArgs["context"]
                        : undefined;
                    // Accept `inputs` here too so the same fail-soft routing
                    // works when a weaker model calls e.g. `vault_inspector({ task,
                    // inputs })` directly instead of the proper
                    // `delegate_task({ agent: "vault_inspector", inputs })` shape.
                    const rawInputs = toolArgs["inputs"];
                    const inputs = rawInputs === undefined
                        ? undefined
                        : (rawInputs as Record<string, unknown>);

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
                        inputs,
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
        /**
         * Structured inputs from the main agent. Pre-populated into the
         * exchange store before the sub-agent runs; the sub-agent reads
         * them via its `exchange` tool. See `buildInitialStore` for the
         * validation rules.
         */
        inputs?: Record<string, unknown>;
    }): Promise<{ success: boolean; content: string }> {
        const { agentName, task, taskContext, parentToolCallId, inputs } = params;
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

        // Validate `inputs` BEFORE notifying the UI / mutating any state,
        // so a bad input doesn't leave the UI in a "sub-agent started but
        // never finished" zombie state. `buildInitialStore` is a pure
        // synchronous validator — fail-fast here means no sub-agent
        // tokens are spent and no UI lifecycle callbacks fire.
        let exchangeStore: ExchangeStore;
        try {
            exchangeStore = buildInitialStore(inputs);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                content: `Error: invalid \`inputs\` for delegate_task(agent="${agentName}"): ${msg}`,
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

        // Per-dispatch exchange store ownership reminder:
        //   - main → sub: pre-populated above by `buildInitialStore(inputs)`,
        //     readable by the sub-agent via `exchange.get` / `exchange.list`.
        //   - sub → main: the sub-agent further writes into the same store
        //     via `exchange.put`; on success we read it back via
        //     `buildDelegatePayload`.
        // The store lives ONLY for this call. No global state, no
        // cross-dispatch leakage.

        try {
            const result = await subAgent.execute(task, {
                provider: this._currentPromptOptions.provider,
                thinkingLevel: this._currentPromptOptions.thinkingLevel,
                allowedCapabilities: this._currentPromptOptions.allowedCapabilities,
                summarizer: this._currentPromptOptions.summarizer,
                embedding: this._currentPromptOptions.embedding,
                context: taskContext,
                parentToolCallId,
                exchangeStore,
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

            // Build the structured envelope that carries both the sub-agent's
            // text summary AND any values it stored via the exchange tool.
            // This is the main agent's only view into the sub-agent's
            // structured output — `text` alone matches the pre-exchange
            // behaviour (and is what the LLM gets when no exchange.put
            // happened), `result` / `extras` carry typed payload when present.
            //
            // We JSON-stringify here because `tool_result.type === "text"`
            // is a string-typed channel; the main agent's prompt instructs
            // the LLM to parse this JSON. See §3.3 of the design doc.
            //
            // Error and abort branches deliberately return plain strings so
            // existing main-side error-handling paths stay untouched.
            const payload = buildDelegatePayload(result.summary, exchangeStore);
            return {
                success: true,
                content: JSON.stringify(payload),
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
                        `do NOT attempt to call a tool literally named "${agentNames[0] ?? 'vault_inspector'}" etc.; ` +
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
                            inputs: {
                                type: "object",
                                description:
                                    `Optional structured inputs for the sub-agent. Each (key, value) is pre-loaded into the sub-agent's exchange store; the sub-agent reads them via \`exchange.get(key)\` or \`exchange.list()\` before deciding how to act. ` +
                                    `Use this for data the sub-agent will consume programmatically — lists of paths, prior results, constraints, configuration. Do NOT duplicate the same data in the \`task\` prose. ` +
                                    `Values MUST be JSON-serializable (string / number / boolean / null / plain array / plain object); each value's serialized size MUST be ≤ 32 KB. ` +
                                    `By convention, the key \`source\` is a good default for "the thing the sub-agent should operate on".`,
                                additionalProperties: true,
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
                // `inputs` is `additionalProperties: true` so the JSON
                // schema doesn't constrain the value shape — we accept
                // any plain object and let `buildInitialStore` validate.
                // Anything that's not a plain object (e.g. string, array)
                // is forwarded as-is so `buildInitialStore` can produce
                // a consistent error message via `InvalidDelegateInputError`.
                const rawInputs = args["inputs"];
                const inputs = rawInputs === undefined
                    ? undefined
                    : (rawInputs as Record<string, unknown>);
                const parentToolCallId = context?.toolCallId;

                const result = await this._dispatchSubAgent({
                    agentName,
                    task,
                    taskContext,
                    parentToolCallId,
                    inputs,
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
