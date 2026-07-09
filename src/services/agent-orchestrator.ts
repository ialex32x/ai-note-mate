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

import { logger } from "../utils/logger";

const log = logger("[AgentOrchestrator]");

import {
    ChatStream,
    ChatMessage,
    ChatStreamConfig,
    ChatSessionState,
    RegisteredTool,
    ToolCallResult,
    IChatAgent,
    AgentTokenBreakdown,
    QuickAskTurn,
    QUICK_ASK_SYSTEM_PROMPT,
    type ToolFilterOptions,
    type ChatAttachment,
    type ContextBreakdown,
} from "./chat-stream";
import type { ConversationSummary } from "./context-compression";
import { createChatCompletion } from "./context-compression";
import type {
    LLMProvider,
    TokenUsage,
    ThinkingLevel,
    ToolCapability,
    MinimalModelConfig,
} from "./llm-provider";
import { SubAgent, SubAgentConfig, SubAgentResult, SubAgentExecutionLog } from "./sub-agent";
import { type HandoffStore } from "./tools/handoff-toolcall";
import {
    selectMatchingSubAgents,
    refineMatchingSubAgentsSync,
    buildSubAgentCandidateTexts,
} from "./sub-agent-router";
import { buildDelegationSystemPrompt, type SubAgentDescriptor } from "./prompts/session-prompts";
import { generateId } from "../utils/id-utils";
import { isAbortError } from "../utils/abortable-request";
import { buildDelegatePayload } from "./agent-orchestrator/delegate-payload";
import { buildInitialStore } from "./agent-orchestrator/handoff-seed";

// Re-export sub-agent types for external consumers
export type { SubAgentConfig, SubAgentResult, SubAgentExecutionLog };
// Re-exports from split modules (backward compat; tests import via agent-orchestrator)
export { buildDelegatePayload, HANDOFF_VALUE_MAX_BYTES, type BuildDelegatePayloadOptions } from "./agent-orchestrator/delegate-payload";
export { buildInitialStore, InvalidDelegateInputError } from "./agent-orchestrator/handoff-seed";
// Re-exports from delegate-envelope-shape (backward compat)
export {
    DELEGATE_ENVELOPE_KIND,
    DELEGATE_ENVELOPE_VERSION,
    type DelegatePayload,
    type ArtifactRef,
    type ArtifactRefReason,
} from "./delegate-envelope-shape";

// (The delegate payload builder and handoff seed builder live in
// ./agent-orchestrator/delegate-payload.ts and ./agent-orchestrator/handoff-seed.ts
// respectively. They are pure functions with no class dependency, split out to keep
// this file focused on orchestration logic.)


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

    /**
     * Maximum number of sub-agents kept in the per-turn DELEGATION
     * block (and in the `delegate_task` tool's `agent` enum) after
     * the hybrid BM25 + embedding retriever ranks them against the
     * user query. Defaults to a small number (see
     * `DEFAULT_SUB_AGENT_FILTER_TOP_K`) when omitted.
     *
     * Sticky-on-history is applied UNION-style on top of this cap
     * (see {@link selectMatchingSubAgents}) so a once-used sub-agent
     * never silently disappears mid-conversation.
     */
    subAgentFilterTopK?: number;

    /**
     * Optional callback that resolves a profile ID to an `LLMProvider`
     * for sub-agent dispatch. When provided, each sub-agent with a
     * non-empty {@link SubAgentConfig.profile} will call this to
     * obtain its own provider instead of inheriting the main agent's.
     *
     * Return `undefined` to fall back to inheritance (same as when the
     * callback is omitted entirely).
     */
    resolveSubAgentProvider?: (profileId: string) => LLMProvider | undefined;

    /**
     * Optional callback that resolves a profile ID to a display model
     * name (e.g. "claude-sonnet-4-6") for tagging sub-agent messages.
     * When a sub-agent has a profile override, this is called to
     * produce the correct {@link ChatMessage.modelName}; when omitted
     * or returning `undefined`, the sub-agent inherits the main agent's
     * model name (for backwards-compatibility).
     */
    resolveSubAgentModelName?: (profileId: string) => string | undefined;

    /** Called when a sub-agent starts executing a task */
    onSubAgentStart?: (agentName: string, task: string) => void;
    /** Called when a sub-agent finishes executing a task */
    onSubAgentEnd?: (agentName: string, result: SubAgentResult) => void;
    /** Called when a sub-agent sends a message update (for real-time UI) */
    onSubAgentMessageUpdate?: (agentName: string, msg: ChatMessage) => void;
    /** Called when a sub-agent completes a tool call (for real-time progress display) */
    onSubAgentToolCallEnd?: (agentName: string, toolName: string, args: Record<string, unknown>, result: string, isError: boolean) => void;
}

/**
 * Fallback cap used by {@link AgentOrchestrator} when the caller does
 * not supply {@link AgentOrchestratorConfig.subAgentFilterTopK}.
 * Mirrors {@link DEFAULT_SUB_AGENT_FILTER_TOP_K} from `settings/defaults`
 * but kept local to avoid pulling the settings module into this
 * service-layer file.
 */
const FALLBACK_SUB_AGENT_FILTER_TOP_K = 2;

/** Maximum number of sub-agents kept in the sticky-on-history window.
 *  Once a sub-agent drops out of the most-recent N, the router no longer
 *  unions it into the shortlist, saving DELEGATION block tokens on long
 *  conversations where early-turn agents are no longer relevant. */
const MAX_STICKY_AGENTS = 3;

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

    /** QuickAsk side-turns anchored to specific assistant messages. */
    private _quickAskTurns: QuickAskTurn[] = [];

    /** Execution logs from sub-agents (for UI display, not persisted) */
    private _subAgentLogs: SubAgentExecutionLog[] = [];

    /** Aggregated token usage across all sub-agents combined (kept for backward-compat) */
    private _totalSubAgentTokenUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };

    /**
     * Per-sub-agent cumulative token usage, keyed by sub-agent name.
     * Used to render a detailed breakdown in the status panel and for persistence.
     */
    private _subAgentTokenUsagePerAgent: Map<string, TokenUsage> = new Map();

    /**
     * Per-turn shortlist of sub-agents picked by
     * {@link selectMatchingSubAgents}. Populated at the very start of
     * {@link _runSubAgentRouter} (called from `systemPromptSuffix`)
     * and read by {@link _createDelegateTaskTool} via the
     * `dynamicTools` callback. Cleared in `prompt()`'s `finally` so
     * the next turn always recomputes against the fresh user query.
     *
     * `null` means "no filter has run yet for this turn" — callers
     * default to the full sub-agent set as a safety fallback (see
     * `dynamicTools`); this only matters for exotic call orders
     * (e.g. tests that invoke the tool getter directly).
     */
    private _currentTurnFilteredSubAgents: SubAgentConfig[] | null = null;

    /**
     * The previous turn's shortlist, used as the fallback target for
     * short / signal-poor queries (typically follow-ups like "yes" /
     * "继续"). Without this a `"yes"` reply mid-conversation would
     * collapse the DELEGATION block to the full set every time —
     * losing the per-turn token savings we set out to win — while a
     * `"yes"` on the very first turn (no last shortlist) safely falls
     * back to the full configured set inside the router.
     */
    private _lastMatchedSubAgents: SubAgentConfig[] | null = null;

    /**
     * Original user input of the current turn, captured at the start
     * of {@link _runSubAgentRouter}. Used by the per-iteration sync
     * re-rank ({@link refineMatchingSubAgentsSync}) to build the
     * enriched query `userInput + lastAssistantText` on every
     * tool-call iteration. Mirrors the existing
     * `_getBestMatchedTools` filter-query pattern in ChatStream.
     */
    private _turnLevelUserInput: string = '';

    /**
     * BM25 candidate texts for ALL configured sub-agents, parallel-
     * indexed with `_config.subAgents`. Computed once at the start of
     * every turn (in {@link _runSubAgentRouter}) and reused by every
     * `dynamicTools` invocation for the rest of the turn. Avoids
     * rebuilding the `name + description + Triggers: ...` strings
     * on each iteration.
     */
    private _turnLevelCandidateTexts: string[] = [];

    /**
     * Latest finalised main-agent assistant text seen in the current
     * turn. Populated by an `onMessageUpdate` interceptor below
     * (assistant role + non-empty content + `streaming: false`). Read
     * by {@link refineMatchingSubAgentsSync} to expand the per-
     * iteration shortlist when the model's intent drifts mid-turn
     * (e.g. iteration 1 used vault_inspector; assistant narrates "I
     * should also check the web" before iteration 2 → BM25 picks up
     * `web` triggers and adds it for iteration 2).
     *
     * Cleared in `prompt()`'s `finally` and in `clearHistory`.
     */
    private _lastAssistantTextForRouting: string = '';

    /**
     * Names of recently-used sub-agents in MRU (most-recently-used) order.
     * Drives the sticky-on-history union in the router. Capped at
     * {@link MAX_STICKY_AGENTS} so long conversations naturally rotate
     * out early-turn sub-agents whose envelope references the model no
     * longer needs to interpret.
     *
     * Rebuilt from history on `restoreState` /
     * `restoreSubAgentMessages` so a session reload preserves the
     * sticky behaviour across persistence boundaries.
     */
    private _usedSubAgentNames: string[] = [];

    /** Return the sticky set as a {@link ReadonlySet} for the router. */
    private _getStickyAgentNames(): ReadonlySet<string> {
        return new Set(this._usedSubAgentNames);
    }

    /** Record a sub-agent as used, maintaining MRU order capped at {@link MAX_STICKY_AGENTS}. */
    private _addUsedSubAgent(name: string): void {
        // Remove existing occurrence (dedup)
        const idx = this._usedSubAgentNames.indexOf(name);
        if (idx !== -1) this._usedSubAgentNames.splice(idx, 1);
        // Push to front (most recent)
        this._usedSubAgentNames.unshift(name);
        // Truncate to window
        if (this._usedSubAgentNames.length > MAX_STICKY_AGENTS) {
            this._usedSubAgentNames.length = MAX_STICKY_AGENTS;
        }
    }

    /**
     * Opaque contextTag forwarded to the main agent ChatStream and
     * propagated into each sub-agent's ChatStream at `delegate_task`
     * dispatch time. See `ChatStream.contextTag` for usage.
     */
    get contextTag(): string | undefined {
        return this._mainAgent.contextTag;
    }
    set contextTag(tag: string | undefined) {
        this._mainAgent.contextTag = tag;
    }

    constructor(config: AgentOrchestratorConfig) {
        this._config = config;

        // Create sub-agents from config FIRST so the onToolCall fallback below
        // can inspect `this._subAgents` when the main ChatStream invokes it.
        const subAgentToolConfirmationEnabled = !!config.onConfirmToolCall;
        for (const subConfig of config.subAgents) {
            this._subAgents.set(
                subConfig.name,
                new SubAgent(subConfig, {
                    toolConfirmationEnabled: subAgentToolConfirmationEnabled,
                }),
            );
        }

        // Capture the caller-supplied suffix (if any) so the wrapped
        // version below can still chain to it. Pulled out into a
        // local so the closure doesn't accidentally recurse on
        // itself via `config.systemPromptSuffix`.
        const userSystemPromptSuffix = config.systemPromptSuffix;
        // Same trick for `onMessageUpdate`: we intercept it to
        // track the latest finalised main-agent assistant text for
        // per-iteration sub-agent re-routing, then chain to the
        // user's callback so the view-side rendering still works.
        const userOnMessageUpdate = config.onMessageUpdate;

        // Create the main agent with the delegate_task tool injected
        // We intercept the original config callbacks to add orchestration logic
        this._mainAgent = new ChatStream({
            ...config,
            // Tag the main agent's log lines so the per-LLM-call tool-count
            // debug output (see `ChatStream.prompt`) is distinguishable
            // from each sub-agent's. Overrides any value the caller may
            // have set in `config` since this orchestrator owns the label.
            agentLabel: 'main',
            // Tap into `onMessageUpdate` to keep
            // `_lastAssistantTextForRouting` fresh between iterations.
            // We deliberately only capture FINALISED assistant text
            // (streaming === false AND non-empty content) so a half-
            // streamed chunk doesn't churn the routing query.
            onMessageUpdate: (msg) => {
                if (msg.role === 'assistant' && msg.streaming === false && msg.content) {
                    this._lastAssistantTextForRouting = msg.content;
                }
                userOnMessageUpdate?.(msg);
            },
            // Per-turn DELEGATION block: the orchestrator owns the
            // sub-agent selection logic, so it injects its own suffix
            // here rather than have the caller bake DELEGATION text
            // into the static `systemPrompt`. We chain to any
            // user-provided suffix so callers can still add custom
            // tail prompts (the user-provided one lands BEFORE the
            // DELEGATION block — DELEGATION is closest to the user
            // message for instructional recency).
            //
            // The retriever call inside `_runSubAgentRouter` is the
            // single source of truth for `_currentTurnFilteredSubAgents`;
            // `dynamicTools` below reads the cache populated here.
            // ChatStream guarantees `systemPromptSuffix` runs BEFORE
            // the first `dynamicTools` invocation of the turn (suffix
            // happens during prompt setup, dynamicTools inside the
            // tool-call loop), so the cache is always warm by then.
            systemPromptSuffix: async (query, signal) => {
                const userSuffix = userSystemPromptSuffix
                    ? (await userSystemPromptSuffix(query, signal)) ?? ''
                    : '';
                const delegation = await this._runSubAgentRouter(query, signal);
                if (!userSuffix && !delegation) return '';
                if (!userSuffix) return delegation;
                if (!delegation) return userSuffix;
                return `${userSuffix}\n\n${delegation}`;
            },
            // Dynamic tools: include delegate_task (scoped to this
            // turn's shortlist) + any user-provided dynamic tools.
            // When the shortlist is empty, `delegate_task` is omitted
            // entirely — the model gets a single-agent-shaped tool
            // surface for that turn so it doesn't try to call a tool
            // whose enum has zero valid values.
            dynamicTools: () => {
                const userDynamic = config.dynamicTools?.() ?? [];
                const shortlist = this._currentTurnShortlistForDelegateTool();
                if (shortlist.length === 0) return userDynamic;
                return [...userDynamic, this._createDelegateTaskTool(shortlist)];
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

                const { toolName, toolArgs, toolCallId, message } = args;

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
                    // Accept the handoff seed here too so the same fail-soft
                    // routing works when a weaker model calls e.g.
                    // `vault_inspector({ task, handoff })` directly instead of
                    // the proper `delegate_task({ agent: "vault_inspector",
                    // handoff })` shape. Also accept the legacy `inputs` key
                    // (some models may have memorised it) as a transitional
                    // fallback so a stale name doesn't silently drop data.
                    const rawHandoff = toolArgs["handoff"] ?? toolArgs["inputs"];
                    const handoff = rawHandoff === undefined
                        ? undefined
                        : (rawHandoff as Record<string, unknown>);

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
                        handoff,
                    });
                    return result.content;
                }

                // Case 2: tool name matches a real tool registered on the main
                // agent (static or dynamic) that just happened to be filtered
                // out of this iteration's embedding-based on-demand subset.
                // Dispatch it via the main agent so the model's deliberate
                // choice to call this tool wins over the heuristic filter's
                // score — returning "Unknown tool" here would force the model
                // into a useless retry loop (the tool name is still in
                // conversation history, so it would keep trying the same call
                // next turn).
                //
                // The same situation can arise across turns: a tool used in
                // turn N stays in the history and may be re-called in turn
                // N+1 even though the new turn's filter query no longer scores
                // it high enough. The within-turn case is also covered by the
                // sticky-on-demand mechanism inside ChatStream (so this
                // fallback usually doesn't fire mid-turn), but the
                // cross-turn case can only be caught here.
                const mainAgentTool = this._mainAgent.findRegisteredTool(toolName);
                if (mainAgentTool) {
                    log.debug(
                        `[AgentOrchestrator] Tool "${toolName}" was registered on the main ` +
                        `agent but filtered out of this turn's tool surface; executing via ` +
                        `fallback so the model doesn't get a spurious "Unknown tool" error.`,
                    );
                    try {
                        const execResult = await this._mainAgent.invokeRegisteredTool(
                            toolName,
                            toolArgs,
                            { toolCallId, toolCallMessage: message },
                        );
                        return ChatStream.serialiseToolResult(execResult);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        return `Error executing tool "${toolName}": ${msg}`;
                    }
                }

                // Case 3: genuinely unknown tool — return an error tool_result
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
            cachedPromptTokens:
                main.cachedPromptTokens + this._totalSubAgentTokenUsage.cachedPromptTokens,
            lastCallTotalTokens: main.lastCallTotalTokens,
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

    /** Per-turn context composition breakdown, forwarded from the main agent. */
    get contextBreakdown() {
        return this._mainAgent.contextBreakdown;
    }

    /** Restore a context breakdown from persisted cache (debug mode). */
    restoreContextBreakdown(breakdown: ContextBreakdown): void {
        this._mainAgent.restoreContextBreakdown(breakdown);
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
        let aggPrompt = 0, aggCompletion = 0, aggTotal = 0, aggCached = 0;
        for (const [name, usage] of Object.entries(breakdown.subAgents)) {
            this._subAgentTokenUsagePerAgent.set(name, { ...usage });
            aggPrompt += usage.promptTokens;
            aggCompletion += usage.completionTokens;
            aggTotal += usage.totalTokens;
            aggCached += usage.cachedPromptTokens;
        }
        this._totalSubAgentTokenUsage = {
            promptTokens: aggPrompt,
            completionTokens: aggCompletion,
            totalTokens: aggTotal,
            cachedPromptTokens: aggCached,
        };
    }

    /** Clear all history and reset state */
    clearHistory(): void {
        this._mainAgent.clearHistory();
        this._subAgentLogs = [];
        this._subAgentMessages.clear();
        this._quickAskTurns = [];
        this._totalSubAgentTokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };
        this._subAgentTokenUsagePerAgent.clear();
        // Reset the per-turn router caches and the sticky-on-history
        // set so a cleared conversation starts with a clean routing
        // slate — otherwise the first turn after a clear would still
        // sticky-include every sub-agent used in the abandoned
        // conversation.
        this._currentTurnFilteredSubAgents = null;
        this._lastMatchedSubAgents = null;
        this._usedSubAgentNames = [];
        this._turnLevelUserInput = '';
        this._turnLevelCandidateTexts = [];
        this._lastAssistantTextForRouting = '';
        // Reset all sub-agent contexts when clearing history
        for (const agent of this._subAgents.values()) {
            agent.resetContext();
        }
    }

    /** Restore state from a previous session */
    restoreState(messages: ReadonlyArray<ChatMessage>, tokenUsage: TokenUsage, summaries?: ConversationSummary[]): void {
        this._mainAgent.restoreState(messages, tokenUsage, summaries);
        // Rebuild the sticky-on-history set from the restored main
        // agent messages so a session reload preserves the sticky
        // behaviour across persistence boundaries. Without this, the
        // first turn after a restore would lose the union and could
        // drop a sub-agent the model is still actively reasoning about
        // (via tool_result envelopes already in history).
        this._rebuildUsedSubAgentNamesFromHistory();
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
        // Persisted sub-agent messages carry `subAgent.agentName` —
        // another reliable source of "which sub-agents has this
        // conversation actually used". Fold it into the sticky set so
        // the sticky-on-history union survives restore even on call
        // paths where `restoreState` was skipped (e.g. tests that
        // exercise sub-agent message restoration in isolation).
        for (const messages of this._subAgentMessages.values()) {
            for (const msg of messages) {
                const name = msg.subAgent?.agentName;
                if (name) this._addUsedSubAgent(name);
            }
        }
    }

    // ── QuickAsk side-turns ─────────────────────────────────────────────────

    /**
     * Execute a QuickAsk side-turn. Delegates to the main agent's
     * ChatStream which owns the message history needed to build the
     * context window.
     */
    async promptQuickAsk(
        parentMessageId: string,
        userInput: string,
        modelConfig: MinimalModelConfig,
    ): Promise<ChatMessage> {
        // Find the parent assistant message
        const parentMsg = this._mainAgent.messages.find(m => m.id === parentMessageId);
        if (!parentMsg || parentMsg.role !== 'assistant') {
            throw new Error('QuickAsk: parent message not found or not an assistant message');
        }

        const userMsg: ChatMessage = {
            id: generateId(),
            role: 'user',
            content: userInput,
            streaming: false,
            timestamp: Date.now(),
            quickAsk: { parentMessageId },
        };

        const sideTurn: QuickAskTurn = {
            parentMessageId,
            userMessage: userMsg,
            assistantMessage: {
                id: generateId(),
                role: 'assistant',
                content: '',
                streaming: false,
                timestamp: Date.now(),
                quickAsk: { parentMessageId },
            },
            loading: true,
        };
        this._quickAskTurns.push(sideTurn);

        const parentTurn = parentMsg.turn ?? 0;
        const turnMessages = this._mainAgent.messages.filter(
            m => m.turn === parentTurn && (m.role === 'user' || m.role === 'assistant'),
        );

        const contextMessages = [
            { role: 'system' as const, content: QUICK_ASK_SYSTEM_PROMPT },
            ...turnMessages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user' as const, content: userInput },
        ];

        try {
            const content = await createChatCompletion(modelConfig, contextMessages);
            const trimmed = content.trim();

            sideTurn.assistantMessage = {
                ...sideTurn.assistantMessage,
                content: trimmed,
                timestamp: Date.now(),
            };
            sideTurn.loading = false;

            return sideTurn.assistantMessage;
        } catch {
            this._quickAskTurns = this._quickAskTurns.filter(t => t !== sideTurn);
            throw new Error('QuickAsk: LLM call failed');
        }
    }

    getQuickAskTurns(): QuickAskTurn[] {
        return this._quickAskTurns.map(t => ({ ...t }));
    }

    restoreQuickAskTurns(turns: QuickAskTurn[]): void {
        this._quickAskTurns = turns.map(t => ({ ...t }));
    }

    /** Remove a QuickAsk turn by parent message ID. */
    removeQuickAskTurn(parentMessageId: string): void {
        this._quickAskTurns = this._quickAskTurns.filter(
            t => t.parentMessageId !== parentMessageId,
        );
    }

        /**
     * Walk the main agent's message history and rebuild
     * {@link _usedSubAgentNames} from any `delegate_task` tool_call
     * entries we find. Used after {@link restoreState} so a restored
     * conversation correctly re-applies sticky-on-history on its
     * first turn.
     *
     * Conservative on parsing — anything we can't unambiguously
     * resolve to a configured sub-agent name is skipped silently
     * rather than risk poisoning the set with garbage.
     */
    private _rebuildUsedSubAgentNamesFromHistory(): void {
        this._usedSubAgentNames = [];
        for (const msg of this._mainAgent.messages) {
            if (msg.role !== 'tool_call') continue;
            const meta = msg.toolCallMeta;
            if (!meta || meta.toolName !== 'delegate_task') continue;
            const agent = (meta.toolArgs as Record<string, unknown> | undefined)?.['agent'];
            if (typeof agent === 'string' && this._subAgents.has(agent)) {
                this._addUsedSubAgent(agent);
            }
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
            embeddingFilter?: ToolFilterOptions;
            /**
             * Forwarded to the main agent so the view can render the user
             * bubble using the agent's own message id. See
             * {@link IChatAgent.prompt} for rationale.
             */
            onUserMessage?: (userMessage: ChatMessage) => void;
            /** Model identifier for this turn, stored on assistant messages. */
            modelName?: string;
            /** User-pasted image attachments (forwarded to main agent). */
            attachments?: ChatAttachment[];
        },
    ): Promise<void> {
        // Store options for sub-agent use during this prompt cycle.
        // Note: sub-agents reuse the same options object (provider,
        // thinkingLevel, capabilities, summarizer, embedding) but MUST NOT
        // inherit the view-facing onUserMessage callback — that callback
        // is tied to the top-level user turn, not to the synthetic "user"
        // messages a delegated sub-agent assembles internally. Copy only
        // the fields a sub-agent should see.
        this._currentPromptOptions = {
            provider: options.provider,
            thinkingLevel: options.thinkingLevel,
            allowedCapabilities: options.allowedCapabilities,
            summarizer: options.summarizer,
            embedding: options.embedding,
            embeddingFilter: options.embeddingFilter,
            modelName: options.modelName,
        };

        try {
            await this._mainAgent.prompt(userInput, options);
        } finally {
            this._currentPromptOptions = null;
            // Clear the per-turn shortlist cache so the next prompt()
            // recomputes against the new user query. `_lastMatchedSubAgents`
            // is intentionally NOT cleared here — it survives the turn
            // boundary so the next short-query fallback (e.g. "yes")
            // can reuse this turn's shortlist.
            this._currentTurnFilteredSubAgents = null;
            // Per-iteration sync-rerank inputs are turn-scoped: the
            // userInput and lastAssistantText only make sense within
            // the current prompt() call. Drop them so a subsequent
            // out-of-band `dynamicTools` call (no active prompt())
            // doesn't reuse stale routing signal.
            this._turnLevelUserInput = '';
            this._turnLevelCandidateTexts = [];
            this._lastAssistantTextForRouting = '';
        }
    }

    /** Options from the current prompt() call, used by delegate_task */
    private _currentPromptOptions: {
        provider: LLMProvider;
        thinkingLevel?: ThinkingLevel;
        allowedCapabilities?: ToolCapability[];
        summarizer?: MinimalModelConfig;
        embedding?: MinimalModelConfig;
        embeddingFilter?: ToolFilterOptions;
        modelName?: string;
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
         * Initial seed of the sub-agent's handoff store, as supplied by
         * the main agent via the `handoff` argument of `delegate_task`.
         * Pre-populated into the store before the sub-agent runs; the
         * sub-agent reads it via its `read_handoff` tool. See
         * `buildInitialStore` for the validation rules.
         */
        handoff?: Record<string, unknown>;
    }): Promise<{ success: boolean; content: string }> {
        const { agentName, task, taskContext, parentToolCallId, handoff } = params;
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

        // Validate the handoff seed BEFORE notifying the UI / mutating any
        // state, so a bad value doesn't leave the UI in a "sub-agent
        // started but never finished" zombie state. `buildInitialStore` is
        // a pure synchronous validator — fail-fast here means no sub-agent
        // tokens are spent and no UI lifecycle callbacks fire.
        let handoffStore: HandoffStore;
        try {
            handoffStore = buildInitialStore(handoff);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                content: `Error: invalid \`handoff\` for delegate_task(agent="${agentName}"): ${msg}`,
            };
        }

        // Per-dispatch result store — fresh empty map the sub-agent
        // populates via write_result / write_result_array /
        // write_result_object. Completely separate from the seed store
        // so there is zero risk of seed/output key collision.
        const resultStore: HandoffStore = new Map();

        // Sticky-on-history bookkeeping: once a sub-agent has been
        // dispatched at this conversation, the router unions its name
        // back into every future turn's shortlist so the model never
        // loses sight of an agent whose envelope it may still be
        // reasoning about. Recorded BEFORE the actual sub-agent
        // execute() so even an aborted / failed dispatch counts —
        // failure leaves the same kind of dangling references in
        // history as success does.
        this._addUsedSubAgent(agentName);

        // Notify UI that sub-agent is starting
        this._config.onSubAgentStart?.(agentName, task);
        this._activeSubAgent = subAgent;

        // Prepare the per-parent bucket to collect sub-agent messages
        // so the UI can render them inline and they can be persisted.
        if (parentToolCallId) {
            this._subAgentMessages.set(parentToolCallId, []);
        }

        // Per-dispatch stores — two independent maps:
        //   - seed store (main → sub): pre-populated by `buildInitialStore(handoff)`,
        //     readable by the sub-agent via `read_handoff` / `list_handoff`.
        //   - result store (sub → main): initially empty, populated by the
        //     sub-agent via `write_result` / `write_result_array` /
        //     `write_result_object`; read back via `buildDelegatePayload`.
        // Both stores live ONLY for this call. No global state, no
        // cross-dispatch leakage. Zero risk of seed/output key collision.

        try {
            // Resolve the provider for this sub-agent: use its override
            // profile when configured, otherwise inherit the main agent's.
            const resolvedProvider =
                this._config.resolveSubAgentProvider && subAgent.profile
                    ? (this._config.resolveSubAgentProvider(subAgent.profile)
                        ?? this._currentPromptOptions.provider)
                    : this._currentPromptOptions.provider;

            // Resolve the display model name for this sub-agent's
            // messages. When a profile override is active, resolve the
            // actual model name from the profile so persisted messages
            // reflect reality instead of showing the main agent's model.
            const resolvedModelName =
                (subAgent.profile
                    && this._config.resolveSubAgentModelName?.(subAgent.profile))
                ?? this._currentPromptOptions.modelName;

            const result = await subAgent.execute(task, {
                provider: resolvedProvider,
                thinkingLevel: this._currentPromptOptions.thinkingLevel,
                allowedCapabilities: this._currentPromptOptions.allowedCapabilities,
                summarizer: this._currentPromptOptions.summarizer,
                embedding: this._currentPromptOptions.embedding,
                embeddingFilter: this._currentPromptOptions.embeddingFilter,
                modelName: resolvedModelName,
                context: taskContext,
                parentToolCallId,
                handoffStore,
                resultStore,
                // Forward the main agent's contextTag so vault-mutation side
                // effects performed by this sub-agent are attributed back to
                // the same session as the main conversation.
                contextTag: this._mainAgent.contextTag,
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
            this._totalSubAgentTokenUsage.cachedPromptTokens += result.tokenUsage.cachedPromptTokens;

            const perAgent = this._subAgentTokenUsagePerAgent.get(agentName)
                ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };
            perAgent.promptTokens += result.tokenUsage.promptTokens;
            perAgent.completionTokens += result.tokenUsage.completionTokens;
            perAgent.totalTokens += result.tokenUsage.totalTokens;
            perAgent.cachedPromptTokens += result.tokenUsage.cachedPromptTokens;
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
            // text summary AND any values it handed off via write_result.
            // This is the main agent's only view into the sub-agent's
            // structured output — `text` alone matches the pre-handoff
            // behaviour (and is what the LLM gets when no write_result
            // calls happened), `result` / `extras` carry typed payload when
            // present. We read from the RESULT store (sub → main), not the
            // seed store (main → sub).
            //
            // We JSON-stringify here because `tool_result.type === "text"`
            // is a string-typed channel; the main agent's prompt instructs
            // the LLM to parse this JSON. See §3.3 of the design doc.
            //
            // Error and abort branches deliberately return plain strings so
            // existing main-side error-handling paths stay untouched.
            //
            // E-3 wiring: the per-session artifact store (if the runtime
            // wired one in) is forwarded so 32 KB < size ≤ 128 KB values
            // are promoted to artifacts instead of dropped. The
            // `parentToolCallId` doubles as the artifact-key namespace
            // (`auto:<parentToolCallId>:<field>`) — when it's absent
            // (e.g. exotic call paths that didn't carry one through),
            // promotion is silently skipped and the legacy `omitted`
            // path absorbs the value. See `BuildDelegatePayloadOptions`
            // for the exact mutual-presence requirement.
            const payload = buildDelegatePayload(result.summary, resultStore, agentName, {
                artifactStore: this._config.getArtifactStore?.() ?? null,
                delegateCallId: parentToolCallId,
            });
            return {
                success: true,
                content: JSON.stringify(payload),
            };
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));

            // If it's an abort, re-throw to let ChatStream handle it
            if (isAbortError(error)) {
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
     * Run the per-turn sub-agent router and build the dynamic
     * DELEGATION block for {@link systemPromptSuffix} consumption.
     *
     * Populates {@link _currentTurnFilteredSubAgents} and
     * {@link _lastMatchedSubAgents} as side effects so the
     * `dynamicTools` callback (which fires later in the same turn)
     * reads a consistent shortlist. Returns the empty string when no
     * sub-agents are configured at all — caller skips the entire
     * delegation suffix on that path.
     */
    private async _runSubAgentRouter(query: string, signal?: AbortSignal): Promise<string> {
        if (this._subAgents.size === 0) {
            this._currentTurnFilteredSubAgents = [];
            this._turnLevelUserInput = '';
            this._turnLevelCandidateTexts = [];
            this._lastAssistantTextForRouting = '';
            return '';
        }

        const allConfigs = this._config.subAgents;
        const topK = this._config.subAgentFilterTopK ?? FALLBACK_SUB_AGENT_FILTER_TOP_K;

        // Cache the inputs the per-iteration sync re-rank depends on.
        // Done BEFORE the async retrieve call so an in-flight abort
        // still leaves consistent state (the sync re-rank only ever
        // runs on the success path anyway, but better to keep these
        // assignments paired with the lifecycle clear in `prompt()`).
        this._turnLevelUserInput = query;
        this._turnLevelCandidateTexts = buildSubAgentCandidateTexts(allConfigs);
        // Fresh turn → no prior assistant signal yet. Iteration 1's
        // sync re-rank effectively reuses the embedding shortlist
        // verbatim because the enriched query collapses to just
        // `userInput`.
        this._lastAssistantTextForRouting = '';

        let shortlist: SubAgentConfig[];
        try {
            shortlist = await selectMatchingSubAgents(query, allConfigs, {
                topK,
                embeddingConfig: this._currentPromptOptions?.embedding ?? null,
                signal,
                stickyAgentNames: this._getStickyAgentNames(),
                fallbackOnShortQuery: this._lastMatchedSubAgents ?? undefined,
            });
        } catch (err) {
            if (isAbortError(err)) throw err;
            // selectMatchingSubAgents already handles non-abort
            // failures internally (returns full set). This catch is
            // a belt-and-braces guard against any future regression
            // where a thrown error bypasses its own fallback.
            console.warn('[AgentOrchestrator] sub-agent router threw, defaulting to full set:', err);
            shortlist = [...allConfigs];
        }

        this._currentTurnFilteredSubAgents = shortlist;
        // Cache as last-matched ONLY when the shortlist is non-empty.
        // An empty result is the legitimate "no sub-agent applies"
        // signal for THIS turn; reusing it as the short-query
        // fallback for the NEXT turn would amplify a single empty
        // turn into a permanent collapse.
        if (shortlist.length > 0) {
            this._lastMatchedSubAgents = shortlist;
        }

        const descriptors: SubAgentDescriptor[] = shortlist.map(c => ({
            name: c.name,
            description: c.description,
        }));
        return buildDelegationSystemPrompt(descriptors);
    }

    /**
     * Resolve the shortlist the `dynamicTools` callback should use to
     * build the `delegate_task` schema this iteration.
     *
     * Strategy (per the plan-B mid-turn-shift design):
     *   1. Baseline = the async router's turn-level shortlist
     *      (populated in {@link _runSubAgentRouter}; falls back to
     *      the FULL configured set when invoked out-of-band, e.g. a
     *      test that drives `dynamicTools` without going through
     *      `prompt()`).
     *   2. Per-iteration sync re-rank: BM25 against
     *      `userInput + lastAssistantText`, take top-K NEW hits,
     *      append them on top of the baseline. Sticky-on-history
     *      union'd in as well.
     *   3. Returned list keeps baseline order first (mirrors the
     *      DELEGATION text's listing); BM25 / sticky additions land
     *      after.
     *
     * The DELEGATION text was built ONCE at turn start from the
     * baseline alone, so sub-agents added here by the sync re-rank
     * appear in the `delegate_task.agent` enum without their per-
     * agent tip block — relying on the schema's per-entry
     * description for guidance. That's the deliberate cost of
     * mid-turn flexibility (see chat transcript on plan B).
     */
    private _currentTurnShortlistForDelegateTool(): SubAgentDescriptor[] {
        if (this._subAgents.size === 0) return [];

        const allConfigs = this._config.subAgents;
        const baseline = this._currentTurnFilteredSubAgents ?? allConfigs;
        const topK = this._config.subAgentFilterTopK ?? FALLBACK_SUB_AGENT_FILTER_TOP_K;

        // The sync re-rank needs candidate texts. They are populated
        // by `_runSubAgentRouter` on every turn, but out-of-band call
        // paths (tests that invoke `dynamicTools` directly) won't
        // have populated them — build on the fly in that case.
        const candidateTexts = this._turnLevelCandidateTexts.length === allConfigs.length
            ? this._turnLevelCandidateTexts
            : buildSubAgentCandidateTexts(allConfigs);

        const enrichedQuery = this._lastAssistantTextForRouting
            ? `${this._turnLevelUserInput}\n${this._lastAssistantTextForRouting.slice(0, 300)}`
            : this._turnLevelUserInput;

        const refined = refineMatchingSubAgentsSync(
            enrichedQuery,
            allConfigs,
            candidateTexts,
            {
                topK,
                baselineShortlist: baseline,
                stickyAgentNames: this._getStickyAgentNames(),
            },
        );

        return refined.map(c => ({ name: c.name, description: c.description }));
    }

    /**
     * Create the delegate_task tool that the main agent uses to invoke sub-agents.
     *
     * The `shortlist` argument restricts the tool's `agent` enum AND
     * the inline description listing to only the sub-agents picked by
     * the per-turn router. This keeps the tool schema's token cost
     * proportional to "what's actually offered to the model this
     * turn" rather than "every sub-agent ever configured".
     */
    private _createDelegateTaskTool(shortlist: ReadonlyArray<SubAgentDescriptor>): RegisteredTool {
        const agentNames = shortlist.map(a => a.name);
        const agentDescriptions = shortlist
            .map(a => `- "${a.name}": ${a.description}`)
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
                            handoff: {
                                type: "object",
                                description:
                                    `Initial seed of the sub-agent's SEED store (separate from the result store the sub-agent writes to). Each (key, value) pair is pre-loaded so the sub-agent can read it via \`read_handoff({key:"..."})\` or \`read_handoff({keys:[...]})\` / \`list_handoff()\` at the start of its turn. The sub-agent's RESULT store (where it writes via \`write_result\` / \`write_result_array\` / \`write_result_object\`) is a completely independent map — seed and result keys never collide. ` +
                                    `Use this for data the sub-agent will consume programmatically — file paths, lists of paths, prior results, focus strings, constraints, configuration. Do NOT duplicate the same data in the \`task\` prose. ` +
                                    `Values MUST be JSON-serializable (string / number / boolean / null / plain array / plain object); each value's serialized size MUST be ≤ 32 KB. ` +
                                    `By convention, the key \`source\` is a good default for "the thing the sub-agent should operate on" (e.g. a path or a list of paths).`,
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
                // `handoff` is `additionalProperties: true` so the JSON
                // schema doesn't constrain the value shape — we accept
                // any plain object and let `buildInitialStore` validate.
                // Anything that's not a plain object (e.g. string, array)
                // is forwarded as-is so `buildInitialStore` can produce
                // a consistent error message via `InvalidDelegateInputError`.
                //
                // Transitional fallback: some models may still emit the
                // legacy `inputs` key from older training data / cached
                // tool schemas. Accept it as a secondary alias so the
                // payload doesn't silently disappear; the prompts and
                // schema description above point exclusively at `handoff`,
                // so over time this fallback will go cold.
                const rawHandoff = args["handoff"] ?? args["inputs"];
                const handoff = rawHandoff === undefined
                    ? undefined
                    : (rawHandoff as Record<string, unknown>);
                const parentToolCallId = context?.toolCallId;

                const result = await this._dispatchSubAgent({
                    agentName,
                    task,
                    taskContext,
                    parentToolCallId,
                    handoff,
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
