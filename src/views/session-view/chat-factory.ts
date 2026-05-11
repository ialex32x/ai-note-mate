import type NoteAssistantPlugin from 'main';
import { ChatStream, IChatAgent, ChatMessage, type ContextReduceOptions } from '../../services/chat-stream';
import { AgentOrchestrator } from '../../services/agent-orchestrator';
import { getActiveProfile, getSummarizerProfile, getActiveEmbeddingConfig } from '../../settings';
import type { LLMProvider, MinimalModelConfig } from '../../services/llm-provider';
import { createProviderForActiveProfile } from '../../utils/provider-factory';
import { buildBuiltinSystemPrompt } from '../../services/prompts/session-prompts';
import { buildSubAgentConfigs } from '../../services/sub-agent-registry';
import { createObsidianTools, createObsidianMutationTools } from '../../services/tools/obsidian';
import { createWebSearchTools } from '../../services/tools/web-search-toolcall';
import { createWebFetchTools } from '../../services/tools/web-fetch-toolcall';
import { createRSSFetchTools } from '../../services/tools/rss-fetch-toolcall';
import { createBuiltinTools } from '../../services/tools/builtin-toolcall';
import { createMemoryTools } from '../../services/tools/memory-toolcall';
import { createJavaScriptTools } from '../../services/tools/js_toolcall';
import { createSkillTools } from '../../services/tools/skill-toolcall';
import { createImageTool } from '../../services/tools/image-toolcall';
import { createConversationTools } from '../../services/tools/conversation-toolcall';

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
    } else {
        // Fallback: single-agent mode (all tools on one ChatStream)
        chat = new ChatStream(chatStreamConfig);

        createObsidianTools(plugin).forEach(tool => chat.registerTool(tool));
        createWebSearchTools(plugin).forEach(tool => chat.registerTool(tool));
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
