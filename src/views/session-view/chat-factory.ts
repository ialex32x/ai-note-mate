import type NoteAssistantPlugin from 'main';
import { ChatStream, IChatAgent, ChatMessage, type ContextReduceOptions, type ToolFilterOptions } from '../../services/chat-stream';
import { AgentOrchestrator } from '../../services/agent-orchestrator';
import { getActiveProfile, getSummarizerProfile, getInsightsProfile, getActiveEmbeddingConfig } from '../../settings';
import type { ProviderProfile } from '../../settings/types';
import {
    DEFAULT_TOOL_FILTER_TOP_K,
    DEFAULT_SKILL_FILTER_TOP_K,
    DEFAULT_SKILL_HINT_THRESHOLD,
    DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
} from '../../settings/defaults';
import type { LLMProvider, MinimalModelConfig } from '../../services/llm-provider';
import { createProviderForActiveProfile } from '../../utils/provider-factory';
import { buildBuiltinSystemPrompt } from '../../services/prompts/session-prompts';
import { buildSubAgentConfigs } from '../../services/sub-agent-registry';
import { buildSkillSystemPromptForQuery } from '../../skills/skill-catalogue';
import { buildMemorySystemPromptPrefix } from '../../services/memory';
import type { ArtifactStore } from '../../services/artifact-store';
import { createObsidianTools, createObsidianMutationTools } from '../../services/tools/obsidian';
import { createWebSearchTools, createImageDownloadTools } from '../../services/tools/web-search-toolcall';
import { createWebFetchTools } from '../../services/tools/web-fetch-toolcall';
import { createRSSFetchTools } from '../../services/tools/rss-fetch-toolcall';
import { createBuiltinTools } from '../../services/tools/builtin-toolcall';
import { createMemoryTools } from '../../services/tools/memory-toolcall';
import { createJavaScriptTools } from '../../services/tools/js_toolcall';
import { createSkillTools } from '../../services/tools/skill-toolcall';
import { createImageTool } from '../../services/tools/image-toolcall';
import { createConversationTools } from '../../services/tools/conversation-toolcall';
import { createRecallArtifactTool } from '../../services/tools/recall-artifact-toolcall';
import { createTodoTool, type TodoStateSource } from '../../services/tools/todo-toolcall';
import { inferModelContextWindow } from '../../services/model-context-window';
import { getAppSecret } from 'utils/secret-helper';

function createModelConfigFromProfile(
    plugin: NoteAssistantPlugin,
    profile: ProviderProfile,
): MinimalModelConfig | undefined {
    const apiKey = plugin.app.secretStorage.getSecret(profile.apiKey) ?? profile.apiKey;
    if (!apiKey) return undefined;

    return {
        type: profile.provider,
        apiKey,
        baseURL: profile.baseUrl,
        model: profile.model,
    };
}

/** Resolve the summarizer model config from settings (if any). */
export function createSummarizerConfig(plugin: NoteAssistantPlugin): MinimalModelConfig | undefined {
    const settings = plugin.settings;
    if (!settings.summarizerProfileId) return undefined;

    return createModelConfigFromProfile(plugin, getSummarizerProfile(settings));
}

/**
 * Resolve the model config used for insight extraction.
 * When `insightsProfileId` is empty, falls back to {@link createSummarizerConfig}.
 */
export function createInsightsConfig(plugin: NoteAssistantPlugin): MinimalModelConfig | undefined {
    const settings = plugin.settings;
    const dedicatedId = settings.insightsProfileId;
    if (dedicatedId && settings.profiles.some(p => p.id === dedicatedId)) {
        return createModelConfigFromProfile(plugin, getInsightsProfile(settings));
    }
    return createSummarizerConfig(plugin);
}

/** Resolve the embedding model config from settings (if any). */
export function createEmbeddingConfig(plugin: NoteAssistantPlugin): MinimalModelConfig | undefined {
    const settings = plugin.settings;
    const embeddingConfig = getActiveEmbeddingConfig(settings);
    if (!embeddingConfig) return undefined;

    const apiKey = getAppSecret(plugin.app, embeddingConfig.apiKey);
    if (!apiKey) return undefined;

    return {
        type: embeddingConfig.type,
        apiKey,
        baseURL: embeddingConfig.baseUrl,
        model: embeddingConfig.model,
    };
}

/**
 * Resolve the tool retriever options from settings. Safe to forward
 * unconditionally — when embedding is not configured, the retriever
 * runs BM25-only.
 */
export function createToolFilterOptions(plugin: NoteAssistantPlugin): ToolFilterOptions {
    const settings = plugin.settings;
    return {
        topK: settings.toolFilterTopK ?? DEFAULT_TOOL_FILTER_TOP_K,
    };
}

/**
 * Resolve the skill-catalogue shortlist options from settings.
 *
 * Separate from {@link createToolFilterOptions} because skills have
 * their own defaults: they're few and the per-skill rendering is
 * light, so a larger topK is the right starting point. Same shape
 * as the tool-filter options so the catalogue builder can consume
 * it without translation.
 */
export function createSkillFilterOptions(plugin: NoteAssistantPlugin): ToolFilterOptions {
    const settings = plugin.settings;
    return {
        topK: settings.skillFilterTopK ?? DEFAULT_SKILL_FILTER_TOP_K,
    };
}

/** Build a provider using the active profile. */
export function createProviderForActiveProfileOf(plugin: NoteAssistantPlugin): LLMProvider {
    return createProviderForActiveProfile(plugin).provider;
}

/**
 * Callbacks supplied by the SessionView so the factory can attach
 * lifecycle hooks without depending on the view class itself.
 *
 * Every callback except `generationMatches` is only invoked when
 * `generationMatches()` returns true — the factory performs the guard
 * itself so individual callbacks don't need to repeat the check.
 */
export interface ChatAgentCallbacks {
    /** Returns true iff the captured chatGeneration is still current. */
    generationMatches(): boolean;
    onStart(): void;
    onMessageUpdate(msg: ChatMessage): void;
    onToolCallEnd(): void;
    onFinish(): void;
    onAbort(msg: ChatMessage): void;
    onUsageUpdate(): void;
    onError(err: Error): void;
    onContextCompressed(): void;
    onEmergencyShrink(): void;
    onSubAgentMessageUpdate(agentName: string, msg: ChatMessage): void;
    /**
     * Registered only when tool confirmation is in "always" mode.
     *
     * The optional `signal` is the current chat turn's AbortSignal.
     * Implementations that block on user input (e.g. the in-bubble
     * Allow / Reject buttons) MUST observe this signal and reject the
     * returned promise with an `AbortError` (DOMException) on abort —
     * otherwise the chat-stream loop deadlocks awaiting a user decision
     * that has been implicitly cancelled by the global stop button.
     * See `runtime-factory.ts` for the canonical implementation.
     */
    onConfirmToolCall?: (messageId: string, signal?: AbortSignal) => Promise<boolean>;
    /** Returns the list of tools that can change dynamically per turn. */
    getDynamicTools(): ReturnType<typeof createBuiltinTools>;
    /**
     * Returns the per-session artifact store used by the main agent's
     * `recall_artifact` tool (multi-agent mode only). Implementations
     * MUST return the same instance for the runtime's whole life so
     * that the tool, registered once at construction time, always
     * reaches the right store. Returning `null` is reserved for tests
     * that explicitly want to disable the recall channel; in that
     * case the recall tool is not registered.
     */
    getArtifactStore?(): ArtifactStore | null;
    /**
     * Returns the per-session TODO state source used by the main
     * agent's `manage_todos` tool. Same lifetime contract as
     * {@link getArtifactStore}: return a stable reference for the
     * runtime's whole life. Returning `null` disables the tool
     * (useful for some tests / single-agent-without-runtime call
     * paths). In production the runtime factory always wires this.
     */
    getTodoStateSource?(): TodoStateSource | null;
}

/**
 * Build the IChatAgent (either single-agent ChatStream or a multi-agent
 * AgentOrchestrator) for the current session, installing all built-in
 * tools as appropriate.
 */
export function createChatAgent(
    plugin: NoteAssistantPlugin,
    callbacks: ChatAgentCallbacks,
): IChatAgent {
    const settings = plugin.settings;

    // Build sub-agent configurations first (needed for system prompt)
    const subAgentConfigs = buildSubAgentConfigs(plugin);

    // Build sub-agent descriptors for the dynamic system prompt
    const subAgentDescriptors = subAgentConfigs.map(c => ({
        name: c.name,
        description: c.description,
    }));

    const builtinSystemPrompt = buildBuiltinSystemPrompt(subAgentDescriptors, {
        structuredFollowUps: settings.followUpSuggestionsEnabled && settings.followUpSuggestionsStructured,
    });

    // Skills are intentionally NOT folded into the static `systemPrompt`
    // here — they are *prepended* per-turn via `systemPromptPrefix` below
    // so the catalogue lands at the very top of the system prompt (the
    // "STEP 0: scan skills" framing only works when the model sees the
    // catalogue before the rules/HINTS/DELEGATION blocks compete for its
    // attention). The catalogue is also shortlisted by embedding
    // similarity to the current user query and supports a strong-match
    // hint plus an auto-inject mode for very-high-confidence matches
    // (see `src/skills/skill-catalogue.ts`). The full-catalogue fallback
    // (no embedding configured / query too short / embed failed) is
    // handled inside the catalogue builder.
    const fullSystemPrompt = builtinSystemPrompt + (settings.systemPrompt || '');

    // Resolve per-profile context-compression overrides from the active
    // profile. Stored on disk as 0 = "use plugin default", which the
    // ContextReducer interprets natively, so we just forward the raw
    // numbers without translating sentinels.
    //
    // Sub-agents share these values (see plan §5.1 — we deliberately do
    // not introduce per-sub-agent compression knobs so the surface area
    // stays small) so the same struct is also injected into every
    // SubAgentConfig below.
    const activeProfile = getActiveProfile(settings);
    // Inferred from the active profile's model identifier — no user
    // input required. The reducer uses this to derive an adaptive
    // emergency line so small-window models (e.g. legacy GPT-3.5 16k)
    // get force-shrunk **before** the prompt exceeds the model window,
    // even when the user's `compressionThreshold` is set for a much
    // larger model. Unknown models fall back to a conservative 32k
    // floor (see `inferModelContextWindow` / `SAFE_FALLBACK_TOKENS`).
    const compressionOptions: Pick<ContextReduceOptions,
        'compressionThreshold' | 'slidingWindowSize' | 'maxSummariesThreshold' | 'modelContextWindow'
    > = {
        compressionThreshold: activeProfile.contextCompressionThreshold,
        slidingWindowSize: activeProfile.slidingWindowSize,
        maxSummariesThreshold: activeProfile.maxSummariesThreshold,
        modelContextWindow: inferModelContextWindow(activeProfile.model),
    };

    const chatStreamConfig = {
        systemPrompt: fullSystemPrompt,
        // Per-turn skill catalogue, prepended at the very top of the
        // system prompt so the "STEP 0: scan skills" framing is the
        // first thing the model sees. Shortlist by embedding similarity
        // to the current user input when an embedding profile is
        // configured; otherwise return the full enabled-skill catalogue.
        // Errors degrade silently to the full catalogue —
        // `ChatStream.prompt()` also swallows non-abort errors from
        // this callback as an extra safety net.
        systemPromptPrefix: async (query: string, signal?: AbortSignal) => {
            // Memory and skills both want to live ABOVE the static
            // system prompt; we build them in parallel and concatenate
            // memory-first so the model treats long-term facts as
            // background context BEFORE the per-turn skill catalogue.
            // Either path may fail silently (returning '') — the chat
            // turn must never block on either.
            const embeddingConfig = createEmbeddingConfig(plugin) ?? null;
            const [memoryPrefix, skillPrefix] = await Promise.all([
                buildMemorySystemPromptPrefix({
                    plugin,
                    store: plugin.memoryStore,
                    query,
                    embeddingConfig,
                    signal,
                }).catch(err => {
                    if (err instanceof DOMException && err.name === 'AbortError') throw err;
                    console.warn('[chat-factory] memory prefix failed, ignoring:', err);
                    return '';
                }),
                buildSkillSystemPromptForQuery({
                    skillManager: plugin.skillManager,
                    query,
                    embeddingConfig,
                    filterOpts: createSkillFilterOptions(plugin),
                    hintThreshold: settings.skillHintThreshold ?? DEFAULT_SKILL_HINT_THRESHOLD,
                    autoInjectThreshold: settings.skillAutoInjectThreshold ?? DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
                    signal,
                }),
            ]);
            if (!memoryPrefix && !skillPrefix) return '';
            if (!memoryPrefix) return skillPrefix;
            if (!skillPrefix) return memoryPrefix;
            return `${memoryPrefix}\n${skillPrefix}`;
        },
        compressionOptions,
        dynamicTools: () => callbacks.getDynamicTools(),
        // Forward the runtime's per-session artifact store. Two consumers
        // share this single getter:
        //   1. `AgentOrchestrator.buildDelegatePayload` (multi-agent
        //      branch below) — E-3, build-time promotion of 32–128 KB
        //      sub-agent returns into the store instead of dropping
        //      them to `omitted`.
        //   2. `ChatStream`'s call to `ContextReducer.reduce` — B-1,
        //      shrink-time spill of historical envelope `result` /
        //      `extras` into the same store with `reason: "shrunk"`.
        // Co-locating the getter on the base config (rather than only on
        // the orchestrator) keeps both writers feeding the exact same
        // store instance, which is the invariant `recall_artifact`
        // depends on. Single-agent mode never produces envelopes so the
        // shrink path is a no-op there; passing the getter is harmless
        // and keeps the wiring uniform.
        //
        // Defensive: if the runtime didn't wire a store (some tests,
        // exotic call paths), returning `null` disables both spill
        // paths and falls back to legacy `omitted` / generic-truncation
        // behaviour. Both consumers handle the null case explicitly.
        getArtifactStore: callbacks.getArtifactStore
            ? () => callbacks.getArtifactStore!()
            : undefined,
        onStart: () => {
            if (!callbacks.generationMatches()) return;
            callbacks.onStart();
        },
        onMessageUpdate: (msg: ChatMessage) => {
            if (!callbacks.generationMatches()) return;
            callbacks.onMessageUpdate(msg);
        },
        onToolCallEnd: () => {
            if (!callbacks.generationMatches()) return;
            callbacks.onToolCallEnd();
        },
        onFinish: () => {
            if (!callbacks.generationMatches()) return;
            callbacks.onFinish();
        },
        onAbort: (msg: ChatMessage) => {
            if (!callbacks.generationMatches()) return;
            callbacks.onAbort(msg);
        },
        onUsageUpdate: () => {
            if (!callbacks.generationMatches()) return;
            callbacks.onUsageUpdate();
        },
        onError: (err: Error) => {
            if (!callbacks.generationMatches()) return;
            callbacks.onError(err);
        },
        // Only provide onConfirmToolCall in "always" mode. In "auto" mode
        // we deliberately omit the callback so ChatStream skips the whole
        // pending → allowed flow — otherwise the UI would briefly render
        // an Allow button even though no user approval is actually needed.
        ...(plugin.settings.toolConfirmMode === 'always' && callbacks.onConfirmToolCall ? {
            onConfirmToolCall: ({ messageId, signal }: { messageId: string; signal?: AbortSignal }) => {
                if (!callbacks.generationMatches()) {
                    return Promise.resolve(true);
                }
                return callbacks.onConfirmToolCall!(messageId, signal);
            },
        } : {}),
        onContextCompressed: () => {
            // Drop the active-skill set unconditionally — even when the
            // captured `generationMatches()` check below would short-
            // circuit the UI callback, the underlying ChatStream has
            // already mutated its history. Any skill body that was
            // injected via `load_skill` or auto-inject may now have
            // been summarised away, so the catalogue must stop showing
            // those skills as `[loaded]` to avoid the model thinking
            // it can skip re-loading.
            plugin.skillManager.clearActiveSkills();
            if (!callbacks.generationMatches()) return;
            callbacks.onContextCompressed();
        },
        onEmergencyShrink: () => {
            if (!callbacks.generationMatches()) return;
            callbacks.onEmergencyShrink();
        },
    };

    let chat: IChatAgent;
    if (subAgentConfigs.length > 0) {
        // Mirror the main agent's compression tuning onto every sub-agent
        // before handing them to the orchestrator. We mutate in place
        // rather than re-mapping because SubAgentConfig has multiple
        // closure-captured fields (e.g. tool callbacks) and a shallow
        // re-spread would force reasoning about which fields are safe to
        // copy.
        for (const subConfig of subAgentConfigs) {
            subConfig.compressionOptions = compressionOptions;
        }

        // Multi-agent mode: use AgentOrchestrator
        chat = new AgentOrchestrator({
            ...chatStreamConfig,
            subAgents: subAgentConfigs,
            onSubAgentMessageUpdate: (agentName, msg) => {
                if (!callbacks.generationMatches()) return;
                callbacks.onSubAgentMessageUpdate(agentName, msg);
            },
        });

        // Register main-agent tools.
        //
        // The main agent owns:
        //   - generic builtins (memory, conversation, builtin, skill)
        //   - ALL vault MUTATION tools (writes, deletes, renames, tag edits)
        //
        // The vault sub-agent only holds read-only inspection tools. This
        // strict read/write split (see `createObsidianMutationTools`)
        // gives the routing LLM a trivial rule — "looking → delegate;
        // doing → call directly" — and removes the prompt-injection seam
        // for content-bearing writes by letting the tool's native (path,
        // content) JSON schema carry the body instead of `delegate_task`
        // prose.
        createBuiltinTools(plugin).forEach(tool => chat.registerTool(tool));
        createSkillTools(plugin).forEach(tool => chat.registerTool(tool));
        createObsidianMutationTools(plugin).forEach(tool => chat.registerTool(tool));
        // `download_image_urls` is a vault-write tool (creates files under
        // the configured attachments folder), so it lives on the main
        // agent for the same reason as the other mutation tools — see the
        // comment block above. The web sub-agent only returns image URLs
        // via `image_search`; the main agent saves them.
        createImageDownloadTools(plugin).forEach(tool => chat.registerTool(tool));

        // Register `recall_artifact` only when an artifact store is wired
        // (production: SessionRuntime supplies one; some tests deliberately
        // omit the callback). The tool is bound via a getter — the chat is
        // long-lived but the store reference, while stable for a given
        // runtime, is conceptually owned by the runtime and threading it
        // through a getter avoids capturing the wrong instance in any
        // future refactor that introduces store rebuilds.
        //
        // Sub-agents do NOT receive this tool (plan §1.4): they upload
        // structured data through their own `exchange` store; the main
        // agent reads via the envelope and recalls via this tool.
        if (callbacks.getArtifactStore) {
            // Capture inside an arrow to preserve `callbacks` as the
            // method receiver; assigning the method to a bare local
            // would unbind it (lint: @typescript-eslint/unbound-method).
            chat.registerTool(createRecallArtifactTool(() => callbacks.getArtifactStore!()));
        }

        // `manage_todos` — session-scoped planning checklist for the
        // main agent. Registered only when the host wired a state
        // source (production: SessionRuntime supplies one; some test
        // call paths intentionally omit it to keep the tool surface
        // minimal). Sub-agents never see this tool by design — see
        // todo-toolcall.ts for the rationale.
        if (callbacks.getTodoStateSource) {
            chat.registerTool(createTodoTool(() => callbacks.getTodoStateSource!()));
        }
    } else {
        // Fallback: single-agent mode (all tools on one ChatStream)
        chat = new ChatStream(chatStreamConfig);

        createObsidianTools(plugin).forEach(tool => chat.registerTool(tool));
        createWebSearchTools(plugin).forEach(tool => chat.registerTool(tool));
        createImageDownloadTools(plugin).forEach(tool => chat.registerTool(tool));
        createWebFetchTools(plugin).forEach(tool => chat.registerTool(tool));
        createRSSFetchTools(plugin).forEach(tool => chat.registerTool(tool));
        createBuiltinTools(plugin).forEach(tool => chat.registerTool(tool));
        createJavaScriptTools(plugin).forEach(tool => chat.registerTool(tool));
        createSkillTools(plugin).forEach(tool => chat.registerTool(tool));

        // `manage_todos` — same single source-of-truth registration
        // path as the multi-agent branch. Single-agent sessions
        // benefit from the planning channel too, especially when the
        // user kicks off a multi-step vault refactor that runs end
        // to end without delegation.
        if (callbacks.getTodoStateSource) {
            chat.registerTool(createTodoTool(() => callbacks.getTodoStateSource!()));
        }
    }
    return chat;
}

/**
 * Build the list of per-turn dynamic tools (image, memory, conversation
 * history retrieval, MCP). Extracted from SessionView.getDynamicTools().
 */
export function buildDynamicTools(
    plugin: NoteAssistantPlugin,
    opts: {
        hasContextCompressed: boolean;
    },
): ReturnType<typeof createBuiltinTools> {
    const tools: ReturnType<typeof createBuiltinTools> = [];

    const imageTool = createImageTool(plugin);
    if (imageTool) tools.push(imageTool);

    if (plugin.settings.memoryEnabled) {
        tools.push(...createMemoryTools(plugin));
    }

    // Only add conversation history retrieval tools if context compression has occurred
    if (opts.hasContextCompressed) {
        tools.push(...createConversationTools());
    }

    if (plugin.mcpManager) {
        // MCP server/tool enablement is sourced entirely from plugin settings
        // (server.enabled + per-tool toggle). No per-session selector exists.
        tools.push(...plugin.mcpManager.getRegisteredTools());
    }
    return tools;
}
