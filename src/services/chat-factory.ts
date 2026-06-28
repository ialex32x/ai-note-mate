import { arrayBufferToBase64 } from 'obsidian';
import type NoteAssistantPlugin from 'main';
import { IChatAgent, ChatMessage, type ContextCompressionOptions, type ToolFilterOptions } from './chat-stream';
import type { MediaAttachment } from './llm-provider';
import type { GeneratedAsset } from './generated-asset-collection';
import { AgentOrchestrator } from './agent-orchestrator';
import { getActiveProfile, getSummarizerProfile, getInsightsProfile, getActiveEmbeddingConfig } from '../settings';
import { resolveSubAgentProvider } from '../settings/helpers';
import type { TextGenConfig } from '../settings/types';
import {
    DEFAULT_TOOL_FILTER_TOP_K,
    DEFAULT_SKILL_FILTER_TOP_K,
    DEFAULT_SKILL_HINT_THRESHOLD,
    DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
    DEFAULT_SUB_AGENT_FILTER_TOP_K,
} from '../settings/defaults';
import type { LLMProvider, MinimalModelConfig } from './llm-provider';
import { createProviderForActiveProfile } from '../utils/provider-factory';
import { buildBuiltinSystemPrompt } from './prompts/session-prompts';
import { buildSubAgentConfigs } from './sub-agent-registry';
import { buildCustomSubAgentConfigs, computeClaimedMcpTools } from './custom-agents';
import { buildSkillSystemPromptForQuery } from '../skills/skill-catalogue';
import { buildMemorySystemPromptPrefix } from './memory';
import type { ArtifactStore } from './artifact-store';
import { createObsidianMutationTools } from './tools/obsidian';
import { vaultReadSection } from './tools/obsidian/read';
import { createImageDownloadTools } from './tools/web-search-toolcall';

import { createBuiltinTools } from './tools/builtin-toolcall';
import { createMemoryTools } from './tools/memory-toolcall';
import { createSkillTools } from './tools/skill-toolcall';
import { createImageTool } from './tools/image-toolcall';
import { createSpeechToTextTool } from './tools/speech-to-text-toolcall';
import { createConversationTools } from './tools/conversation-toolcall';
import { createRecallArtifactTool } from './tools/recall-artifact-toolcall';
import { createTodoTool, type TodoStateSource } from './tools/todo-toolcall';
import { inferModelContextWindow } from './model-context-window';
import { resolveSecret } from 'utils/secret-helper';
import { isAbortError } from '../utils/abortable-request';

function createModelConfigFromProfile(
    plugin: NoteAssistantPlugin,
    profile: TextGenConfig,
): MinimalModelConfig | undefined {
    const apiKey = resolveSecret(plugin.app, profile.apiKey);
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
 * When `insightsProfileId` is empty, insight extraction is disabled.
 */
export function createInsightsConfig(plugin: NoteAssistantPlugin): MinimalModelConfig | undefined {
    const settings = plugin.settings;
    const dedicatedId = settings.insightsProfileId;
    if (dedicatedId && settings.profiles.some(p => p.id === dedicatedId)) {
        return createModelConfigFromProfile(plugin, getInsightsProfile(settings));
    }
    return undefined;
}

/** Resolve the embedding model config from settings (if any). */
export function createEmbeddingConfig(plugin: NoteAssistantPlugin): MinimalModelConfig | undefined {
    const settings = plugin.settings;
    const embeddingConfig = getActiveEmbeddingConfig(settings);
    if (!embeddingConfig) return undefined;

    const apiKey = resolveSecret(plugin.app, embeddingConfig.apiKey);
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
    /** Called when a tool execution produces generated assets (e.g. images). */
    onAssetGenerated?(assets: GeneratedAsset[]): void;
    onFinish(): void;
    onAbort(msg: ChatMessage): void;
    onUsageUpdate(): void;
    onError(err: Error): void;
    onContextCompressed(): void;
    onSummarizing(): void;
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

    // Add custom sub-agents from user settings.
    const customSubAgentConfigs = buildCustomSubAgentConfigs(plugin, settings.agents);
    const allSubAgentConfigs = [...subAgentConfigs, ...customSubAgentConfigs];

    // Compute which MCP tools are claimed by custom agents so they
    // can be excluded from the main agent's dynamic tool list.
    const claimedMcpTools = plugin.mcpManager
        ? computeClaimedMcpTools(settings.agents, plugin.mcpManager.getRegisteredTools())
        : new Set<string>();

    // The DELEGATION block is no longer baked into the static system
    // prompt — `AgentOrchestrator` injects it per-turn via
    // `systemPromptSuffix`, scoped to whichever sub-agents the
    // sub-agent router shortlists for the current user query. We just
    // tell the prompt builder whether to use the multi-agent
    // intro/HINTS flavour (slimmer, delegation-aware) or the
    // single-agent one (richer, direct-tool-use framing).
    const builtinSystemPrompt = buildBuiltinSystemPrompt({
        multiAgent: allSubAgentConfigs.length > 0,
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
    // AGENT.md takes priority over the inline Initial Prompt string.
    // The file content is cached on plugin startup / settings change by
    // `plugin.refreshAgentMd()` so this read is always synchronous.
    // An explicit section heading is added so the model unambiguously
    // interprets the custom instructions as being ABOUT the AI itself,
    // not about the user.
    const agentMdContent = plugin.agentMdCache?.content;
    const customPrompt = agentMdContent ?? (settings.systemPrompt || '');
    const customPromptSection = customPrompt
        ? `\n\n## Custom Instructions\n${customPrompt}`
        : '';
    const fullSystemPrompt = builtinSystemPrompt + customPromptSection;

    // Resolve per-profile context-compression overrides from the active
    // profile. Stored on disk as 0 = "use plugin default", which the
    // ContextCompressor interprets natively, so we just forward the raw
    // numbers without translating sentinels.
    //
    // Sub-agents share these values (see plan §5.1 — we deliberately do
    // not introduce per-sub-agent compression knobs so the surface area
    // stays small) so the same struct is also injected into every
    // SubAgentConfig below.
    const activeProfile = getActiveProfile(settings);
    // Inferred from the active profile's model identifier — no user
    // input required. the compressor uses this to derive an adaptive
    // emergency line so small-window models (e.g. legacy GPT-3.5 16k)
    // get force-shrunk **before** the prompt exceeds the model window,
    // even when the user's `compressionThreshold` is set for a much
    // larger model. Unknown models fall back to a conservative 32k
    // floor (see `inferModelContextWindow` / `SAFE_FALLBACK_TOKENS`).
    const compressionOptions: Pick<ContextCompressionOptions,
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
                    if (isAbortError(err)) throw err;
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
        // Per-turn TODO reminder: inject the active (pending / in_progress)
        // items directly into the system prompt so the model sees them
        // without needing an explicit `manage_todos({ action: "list" })`
        // call. Only `id`, `brief`, and `status` are injected — `content`
        // is deliberately omitted to keep token usage bounded; the model
        // can still call `list` when it needs the full scratchpad.
        //
        // Strategy mirrors the "hybrid injection" pattern used by Cursor:
        // - ≤ MAX_INLINE items → all active items injected inline.
        // - > MAX_INLINE items → show first MAX_INLINE (in_progress
        //   first), then a summary hint + `list` fallback.
        // Completed / cancelled items are never injected (pure noise).
        systemPromptSuffix: () => {
            if (!callbacks.getTodoStateSource) return '';
            const source = callbacks.getTodoStateSource();
            if (!source) return '';
            const state = source.get();

            const active = state.items.filter(
                i => i.status === 'pending' || i.status === 'in_progress',
            );
            if (active.length === 0) return '';

            // in_progress first (current focus), then pending
            const sorted = [...active].sort((a, b) => {
                if (a.status === 'in_progress' && b.status !== 'in_progress') return -1;
                if (a.status !== 'in_progress' && b.status === 'in_progress') return 1;
                return 0;
            });

            const MAX_INLINE = 5;
            const shown = sorted.slice(0, MAX_INLINE);
            const remaining = sorted.length - MAX_INLINE;

            const lines = shown.map(
                item => `- [${item.status}] ${item.brief} (\`${item.id}\`)`,
            );

            let block: string;
            if (remaining <= 0) {
                block = `## Active TODO items\n\n${lines.join('\n')}`;
            } else {
                block =
                    `## Active TODO items (${sorted.length} remaining, showing first ${MAX_INLINE})\n\n` +
                    `${lines.join('\n')}\n` +
                    `... and ${remaining} more. Call \`manage_todos({ action: "list" })\` for full details.`;
            }

            // CRITICAL reminder: the model MUST update todo status BEFORE
            // writing the final assistant reply, otherwise the user sees
            // stale "in_progress" items on the pinned panel. Make the
            // instruction specific and emphatic — a generic hint is too
            // easy for the model to skim past after a long turn.
            const inProgress = sorted.filter(i => i.status === 'in_progress');
            if (inProgress.length > 0) {
                const ids = inProgress.map(i => `"${i.id}"`).join(', ');
                block +=
                    `\n\n**IMPORTANT — BEFORE your final reply this turn:** ` +
                    `You have ${inProgress.length} item(s) currently in_progress: ${ids}. ` +
                    `If any of these are now finished, you MUST call ` +
                    `\`manage_todos({ action: "update", id: "...", status: "completed" })\` ` +
                    `to mark them done BEFORE writing your final answer. ` +
                    `The user sees the TODO panel live — stale in_progress items after ` +
                    `you've finished working is confusing and looks like a bug.`;
            } else {
                block +=
                    '\n\nWhen you finish an item, mark it done via ' +
                    '`manage_todos({ action: "update", id: "...", status: "completed" })`.';
            }
            return block;
        },
        compressionOptions,
        dynamicTools: () => {
            const tools = callbacks.getDynamicTools();
            if (claimedMcpTools.size > 0) {
                return tools.filter(t => !claimedMcpTools.has(t.schema.function.name));
            }
            return tools;
        },
        // Forward the runtime's per-session artifact store. Two consumers
        // share this single getter:
        //   1. `AgentOrchestrator.buildDelegatePayload` (multi-agent
        //      branch below) — E-3, build-time promotion of 32–128 KB
        //      sub-agent returns into the store instead of dropping
        //      them to `omitted`.
        //   2. `ChatStream`'s call to `ContextCompressor.compress` — B-1,
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
        onAssetGenerated: callbacks.onAssetGenerated
            ? (assets: GeneratedAsset[]) => {
                if (!callbacks.generationMatches()) return;
                callbacks.onAssetGenerated!(assets);
            }
            : undefined,
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
        // we deliberately omit the callback so ChatStream (main and
        // sub-agents — see SubAgent + AgentOrchestrator) skips the whole
        // pending → allowed flow — otherwise the UI would briefly render
        // an Allow / Allowed badge even though no user approval is needed.
        ...(plugin.settings.toolConfirmMode === 'always' && callbacks.onConfirmToolCall ? {
            onConfirmToolCall: ({ messageId, signal }: { messageId: string; signal?: AbortSignal }) => {
                if (!callbacks.generationMatches()) {
                    return Promise.resolve(true);
                }
                return callbacks.onConfirmToolCall!(messageId, signal);
            },
        } : {}),
        resolveAttachment: async (
            cachePath: string,
            mimeType: string,
            _fileName: string,
        ): Promise<MediaAttachment | null> => {
            try {
                const adapter = plugin.app.vault.adapter;
                if (!(await adapter.exists(cachePath))) {
                    console.warn(`[chat-factory] Attachment cache file missing: ${cachePath}`);
                    return null;
                }
                const buf = await adapter.readBinary(cachePath);
                const base64 = arrayBufferToBase64(buf);
                // Infer the modality kind from MIME type
                const m = mimeType.toLowerCase();
                let kind: MediaAttachment['kind'] = 'image';
                if (m.startsWith('audio/')) kind = 'audio';
                else if (m.startsWith('video/')) kind = 'video';
                else if (m === 'application/pdf') kind = 'pdf';
                return {
                    kind,
                    mimeType,
                    base64,
                    sourcePath: _fileName,
                };
            } catch (err) {
                console.warn(`[chat-factory] Failed to resolve attachment: ${cachePath}`, err);
                return null;
            }
        },

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
        onSummarizing: () => {
            if (!callbacks.generationMatches()) return;
            callbacks.onSummarizing();
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
        for (const subConfig of allSubAgentConfigs) {
            subConfig.compressionOptions = compressionOptions;
        }

        // Multi-agent mode: use AgentOrchestrator
        chat = new AgentOrchestrator({
            ...chatStreamConfig,
            subAgents: allSubAgentConfigs,
            // Per-turn sub-agent shortlist cap. The orchestrator
            // clamps and falls back internally; we just forward the
            // current setting verbatim. Honour 0 as "use built-in
            // default" the same way the other top-K knobs do.
            subAgentFilterTopK: settings.subAgentFilterTopK > 0
                ? settings.subAgentFilterTopK
                : DEFAULT_SUB_AGENT_FILTER_TOP_K,
            // Per-agent profile resolver: when a sub-agent has a
            // non-empty `profile` override, resolve it to a provider.
            // Falls back to the main agent's provider when the profile
            // id is empty, the profile is missing, or the API key is
            // not configured.
            resolveSubAgentProvider: (profileId: string) =>
                resolveSubAgentProvider(plugin.app, settings, profileId),
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
        //   - `read_section` (read-modify-write partner of `set_section`;
        //     needed for the body_hash contract)
        //
        // The vault sub-agent holds the remaining read-only inspection
        // tools. This read/write split gives the routing LLM a trivial
        // rule — "looking → delegate; doing → call directly" — and removes
        // the prompt-injection seam for content-bearing writes by letting
        // the tool's native (path, content) JSON schema carry the body
        // instead of `delegate_task` prose.
        createBuiltinTools(plugin).forEach(tool => chat.registerTool(tool));
        createSkillTools(plugin).forEach(tool => chat.registerTool(tool));
        createObsidianMutationTools(plugin).forEach(tool => chat.registerTool(tool));
        chat.registerTool(vaultReadSection(plugin));
		// `download_image_urls` is a vault-write tool (creates files under
		// the configured attachments folder), so it lives on the main
		// agent for the same reason as the other mutation tools — see the
		// comment block above. The web sub-agent only returns image URLs
		// via `image_search`; the main agent saves them.
		//
		// Only registered when the web sub-agent is present (not disabled
		// by the user) — without it there is no `image_search` to produce
		// URLs from.
		if (allSubAgentConfigs.some(c => c.name === 'web')) {
            createImageDownloadTools(plugin).forEach(tool => chat.registerTool(tool));
        }

        // Register `recall_artifact` only when an artifact store is wired
        // (production: SessionRuntime supplies one; some tests deliberately
        // omit the callback). The tool is bound via a getter — the chat is
        // long-lived but the store reference, while stable for a given
        // runtime, is conceptually owned by the runtime and threading it
        // through a getter avoids capturing the wrong instance in any
        // future refactor that introduces store rebuilds.
        //
        // Sub-agents do NOT receive this tool (plan §1.4): they deliver
        // structured data through their own handoff store; the main
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
        // buildSubAgentConfigs() always returns at least vault_inspector
        // and vault_editor (hardcoded, no off-switch), so this branch is
        // unreachable.  Crash loudly so a future refactor that violates
        // this invariant can't silently fall through to a tool-less chat.
        throw new Error(
            'chat-factory: subAgentConfigs is empty — this should never happen. ' +
            'vault_inspector and vault_editor are hardcoded in buildSubAgentConfigs().',
        );
    }
    return chat;
}

/**
 * Build the list of per-turn dynamic tools (image, memory, conversation
 * history retrieval, MCP). Extracted from SessionView.getDynamicTools().
 *
 * MCP tools claimed by custom sub-agents are filtered upstream by
 * {@link createChatAgent} — this function always returns all MCP tools.
 */
export function buildDynamicTools(
    plugin: NoteAssistantPlugin,
    opts: {
        hasContextCompressed: boolean;
        getArtifactStore?: () => ArtifactStore | null;
    },
): ReturnType<typeof createBuiltinTools> {
    const tools: ReturnType<typeof createBuiltinTools> = [];

    const imageTool = createImageTool(plugin);
    if (imageTool) tools.push(imageTool);

    const sttTool = createSpeechToTextTool(plugin, opts.getArtifactStore);
    if (sttTool) tools.push(sttTool);

    if (plugin.settings.memoryEnabled) {
        tools.push(...createMemoryTools(plugin));
    }

    // Only add conversation history retrieval tools if context compression has occurred
    if (opts.hasContextCompressed) {
        tools.push(...createConversationTools());
    }

    if (plugin.mcpManager) {
        tools.push(...plugin.mcpManager.getRegisteredTools());
    }
    return tools;
}
