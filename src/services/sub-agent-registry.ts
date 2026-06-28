/**
 * Builds sub-agent configurations for the AgentOrchestrator.
 * Each sub-agent gets a dedicated tool set and system prompt.
 *
 * Extracted from SessionView for maintainability.
 */
import type { SubAgentConfig } from './sub-agent';
import type NoteAssistantPlugin from 'main';
import { createObsidianEditorTools, createObsidianReadOnlyTools } from './tools/obsidian';
import { createWebSearchTools } from './tools/web-search-toolcall';
import { createWebFetchTools } from './tools/web-fetch-toolcall';
import { createRSSFetchTools } from './tools/rss-fetch-toolcall';
import { createBuiltinTools } from './tools/builtin-toolcall';
import { createJavaScriptTools } from './tools/js_toolcall';
import {
    VAULT_AGENT_DESCRIPTION, VAULT_AGENT_PROMPT, VAULT_ROUTING_KEYWORDS,
    VAULT_EDITOR_DESCRIPTION, VAULT_EDITOR_PROMPT, VAULT_EDITOR_ROUTING_KEYWORDS,
    WEB_AGENT_DESCRIPTION, createWebAgentPrompt, WEB_ROUTING_KEYWORDS,
    CODE_AGENT_DESCRIPTION, CODE_AGENT_PROMPT, CODE_ROUTING_KEYWORDS,
} from './prompts/sub-agent-prompts';

/**
 * Default disabled state for built-in agents whose `canToggle` is true.
 *
 * Agents not listed here default to `false` (enabled). Entries are
 * overridden when {@link BuiltinAgentOverride.disabled} is present in
 * the user's settings.
 */
export const BUILTIN_AGENT_DEFAULT_DISABLED: Record<string, boolean> = {
    code: true,
};

/** Resolve whether a built-in agent is disabled from overrides + defaults. */
function isBuiltinDisabled(overrides: Record<string, { disabled?: boolean }>, key: string): boolean {
    return overrides[key]?.disabled ?? BUILTIN_AGENT_DEFAULT_DISABLED[key] ?? false;
}

export function buildSubAgentConfigs(plugin: NoteAssistantPlugin): SubAgentConfig[] {
    const configs: SubAgentConfig[] = [];
    const overrides = plugin.settings.builtinAgentOverrides;

    // Vault inspector sub-agent: read-only inspection (read / search /
    // list / metadata / link graph / tag queries). All vault MUTATIONS —
    // writes, deletes, renames, tag edits — are registered directly on
    // the main agent (see chat-factory.ts) so the routing rule is a
    // clean binary: "looking → delegate to vault_inspector; doing → call
    // directly". This both closes the prompt-injection seam for
    // content-bearing writes and removes a routing decision the LLM
    // kept getting wrong.
    //
    // The internal name `'vault_inspector'` is exactly what the routing
    // LLM sees as the value of `delegate_task.agent`; the name itself
    // is part of the "this is read-only" signal we want it to anchor to.
    const vaultTools = createObsidianReadOnlyTools(plugin);
    if (vaultTools.length > 0) {
        configs.push({
            name: 'vault_inspector',
            description: VAULT_AGENT_DESCRIPTION,
            systemPrompt: VAULT_AGENT_PROMPT,
            tools: vaultTools,
            resultMaxTokens: 15000,
            routingKeywords: VAULT_ROUTING_KEYWORDS,
            profile: overrides['vault_inspector']?.profile ?? undefined,
        });
    }

    // Vault editor sub-agent: WRITE-permitted, but scoped to rewriting
    // the BODY of ONE existing markdown file per task (see
    // docs/vault-editor-subagent-plan.md).
    //
    // Why it's separate from `vault_inspector` even though its tool set
    // is a strict superset:
    //  - The inspector is the "safe delegation target" the main agent
    //    reaches for when it just wants to look. Giving it write tools
    //    would re-introduce the exact routing ambiguity the main-agent
    //    write-split was designed to remove (see `createObsidianMutationTools`
    //    comment in `./tools/obsidian/index.ts`).
    //  - The editor exists specifically for "rewrite a whole note"
    //    tasks where having the main agent produce the new body would
    //    blow up its context. Its result schema (strategy +
    //    sample_diff[]) is tuned for that single case.
    //
    // The orchestrator injects `delegate_task` only on the main agent,
    // so the editor automatically cannot recurse — no extra opt-out
    // needed here.
    const editorTools = createObsidianEditorTools(plugin);
    if (editorTools.length > 0) {
        configs.push({
            name: 'vault_editor',
            description: VAULT_EDITOR_DESCRIPTION,
            systemPrompt: VAULT_EDITOR_PROMPT,
            tools: editorTools,
            // Diff summaries are far smaller than digest arrays — cap
            // at 4K to keep a wholesale-rewrite result trimmed even if
            // the sub-agent stuffs all 5 samples at full 240-char cap.
            resultMaxTokens: 4000,
            routingKeywords: VAULT_EDITOR_ROUTING_KEYWORDS,
            profile: overrides['vault_editor']?.profile ?? undefined,
        });
    }

    // Web search sub-agent: handles internet searches and content fetching.
    // Gated by the user's override (or built-in default — enabled by default).
    if (!isBuiltinDisabled(overrides, 'web')) {
        const webTools = [
            ...createWebSearchTools(plugin),
            ...createWebFetchTools(plugin),
            ...createRSSFetchTools(plugin),
        ];
        if (webTools.length > 0) {
            configs.push({
                name: 'web',
                description: WEB_AGENT_DESCRIPTION,
                systemPrompt: createWebAgentPrompt(),
                tools: webTools,
                resultMaxTokens: 15000,
                routingKeywords: WEB_ROUTING_KEYWORDS,
                profile: overrides['web']?.profile ?? undefined,
            });
        }
    }

    // Code execution sub-agent: handles JavaScript code execution.
    // Gated by the user's override (or built-in default — disabled by default).
    if (!isBuiltinDisabled(overrides, 'code')) {
        const jsTools = createJavaScriptTools(plugin);
        if (jsTools.length > 0) {
            configs.push({
                name: 'code',
                description: CODE_AGENT_DESCRIPTION,
                systemPrompt: CODE_AGENT_PROMPT,
                tools: jsTools,
                resultMaxTokens: 10000,
                routingKeywords: CODE_ROUTING_KEYWORDS,
                profile: overrides['code']?.profile ?? undefined,
            });
        }
    }

    return configs;
}

/**
 * Lightweight metadata for a single built-in agent, used by the settings
 * UI to display read-only information. Does NOT construct full tool objects.
 */
export interface BuiltinAgentMeta {
    /** Stable internal key (e.g. "vault_inspector", "web") */
    key: string;
    /** Human-readable name for the settings tab */
    name: string;
    /** High-level description shown to the main agent for routing */
    description: string;
    /** Full system prompt injected when this agent executes */
    systemPrompt: string;
    /** Tool function names available to this agent at the current plugin state */
    toolNames: string[];
    /** Whether this agent is currently enabled (affects whether it appears in agent menus) */
    enabled: boolean;
    /** Whether the user can toggle this agent on/off in settings */
    canToggle: boolean;
}

/**
 * Returns read-only metadata for all built-in sub-agents.
 *
 * Called by the Agents settings section to render built-in agent cards
 * alongside user-defined custom agents. Tool names are resolved from
 * the same factory functions used at runtime, so they accurately reflect
 * the current plugin state (e.g. tools gated behind feature toggles).
 */
export function getBuiltinAgentMeta(plugin: NoteAssistantPlugin): BuiltinAgentMeta[] {
    const meta: BuiltinAgentMeta[] = [];
    const overrides = plugin.settings.builtinAgentOverrides;

    // vault_inspector — always present (hardcoded, no off-switch)
    {
        const vaultTools = createObsidianReadOnlyTools(plugin);
        const builtinTools = createBuiltinTools(plugin);
        const allToolNames = [
            ...vaultTools.map(t => t.schema.function.name),
            ...builtinTools.map(t => t.schema.function.name),
        ];
        meta.push({
            key: 'vault_inspector',
            name: 'Vault Inspector',
            description: VAULT_AGENT_DESCRIPTION,
            systemPrompt: VAULT_AGENT_PROMPT,
            toolNames: allToolNames,
            enabled: vaultTools.length > 0,
            canToggle: false,
        });
    }

    // vault_editor — always present (hardcoded, no off-switch)
    {
        const editorTools = createObsidianEditorTools(plugin);
        const builtinTools = createBuiltinTools(plugin);
        const allToolNames = [
            ...editorTools.map(t => t.schema.function.name),
            ...builtinTools.map(t => t.schema.function.name),
        ];
        meta.push({
            key: 'vault_editor',
            name: 'Vault Editor',
            description: VAULT_EDITOR_DESCRIPTION,
            systemPrompt: VAULT_EDITOR_PROMPT,
            toolNames: allToolNames,
            enabled: editorTools.length > 0,
            canToggle: false,
        });
    }

    // web — gated by override (default: enabled)
    {
        const webTools = [
            ...createWebSearchTools(plugin),
            ...createWebFetchTools(plugin),
            ...createRSSFetchTools(plugin),
        ];
        const builtinTools = createBuiltinTools(plugin);
        const allToolNames = [
            ...webTools.map(t => t.schema.function.name),
            ...builtinTools.map(t => t.schema.function.name),
        ];
        meta.push({
            key: 'web',
            name: 'Web Search',
            description: WEB_AGENT_DESCRIPTION,
            systemPrompt: createWebAgentPrompt(),
            toolNames: allToolNames,
            enabled: !isBuiltinDisabled(overrides, 'web'),
            canToggle: true,
        });
    }

    // code — gated by override (default: disabled)
    {
        const jsTools = createJavaScriptTools(plugin);
        const builtinTools = createBuiltinTools(plugin);
        const allToolNames = [
            ...jsTools.map(t => t.schema.function.name),
            ...builtinTools.map(t => t.schema.function.name),
        ];
        meta.push({
            key: 'code',
            name: 'Code Executor',
            description: CODE_AGENT_DESCRIPTION,
            systemPrompt: CODE_AGENT_PROMPT,
            toolNames: allToolNames,
            enabled: !isBuiltinDisabled(overrides, 'code'),
            canToggle: true,
        });
    }

    return meta;
}
