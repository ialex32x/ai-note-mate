import type NoteAssistantPlugin from 'main';
import { ChatStream, IChatAgent, ChatMessage, type ContextReduceOptions } from '../../services/chat-stream';
import { AgentOrchestrator } from '../../services/agent-orchestrator';
import { getActiveProfile, getSummarizerProfile, getActiveEmbeddingConfig } from '../../settings';
import type { LLMProvider, MinimalModelConfig } from '../../services/llm-provider';
import { createProviderForActiveProfile } from '../../utils/provider-factory';
import { buildBuiltinSystemPrompt } from '../../services/prompts/session-prompts';
import { buildSubAgentConfigs } from '../../services/sub-agent-registry';
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

/** Resolve the summarizer model config from settings (if any). */
export function createSummarizerConfig(plugin: NoteAssistantPlugin): MinimalModelConfig | undefined {
    const settings = plugin.settings;
    if (!settings.summarizerProfileId) return undefined;

    const sp = getSummarizerProfile(settings);
    const spApiKey = plugin.app.secretStorage.getSecret(sp.apiKey) ?? sp.apiKey;
    if (!spApiKey) return undefined;

    return {
        type: sp.provider,
        apiKey: spApiKey,
        baseURL: sp.baseUrl,
        model: sp.model,
    };
}

/** Resolve the embedding model config from settings (if any). */
export function createEmbeddingConfig(plugin: NoteAssistantPlugin): MinimalModelConfig | undefined {
    const settings = plugin.settings;
    const embeddingConfig = getActiveEmbeddingConfig(settings);
    if (!embeddingConfig) return undefined;

    const apiKey = plugin.app.secretStorage.getSecret(embeddingConfig.apiKey) ?? embeddingConfig.apiKey;
    if (!apiKey) return undefined;

    return {
        type: embeddingConfig.type,
        apiKey,
        baseURL: embeddingConfig.baseUrl,
        model: embeddingConfig.model,
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
    onSubAgentMessageUpdate(agentName: string, msg: ChatMessage): void;
    /** Registered only when tool confirmation is in "always" mode. */
    onConfirmToolCall?: (messageId: string) => Promise<boolean>;
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

    const skillsPrompt = plugin.skillManager.buildSystemPrompt();
    const fullSystemPrompt = builtinSystemPrompt +
        (settings.systemPrompt || '') +
        (skillsPrompt ? '\n\n' + skillsPrompt : '');

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
    const compressionOptions: Pick<ContextReduceOptions,
        'compressionThreshold' | 'slidingWindowSize' | 'maxSummariesThreshold'
    > = {
        compressionThreshold: activeProfile.contextCompressionThreshold,
        slidingWindowSize: activeProfile.slidingWindowSize,
        maxSummariesThreshold: activeProfile.maxSummariesThreshold,
    };

    const chatStreamConfig = {
        systemPrompt: fullSystemPrompt,
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
            onConfirmToolCall: ({ messageId }: { messageId: string }) => {
                if (!callbacks.generationMatches()) {
                    return Promise.resolve(true);
                }
                return callbacks.onConfirmToolCall!(messageId);
            },
        } : {}),
        onContextCompressed: () => {
            if (!callbacks.generationMatches()) return;
            callbacks.onContextCompressed();
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
