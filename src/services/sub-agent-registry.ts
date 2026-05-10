/**
 * Builds sub-agent configurations for the AgentOrchestrator.
 * Each sub-agent gets a dedicated tool set and system prompt.
 *
 * Extracted from SessionView for maintainability.
 */
import type { SubAgentConfig } from './sub-agent';
import type NoteAssistantPlugin from 'main';
import { createObsidianReadOnlyTools } from './tools/obsidian';
import { createWebSearchTools } from './tools/web-search-toolcall';
import { createWebFetchTools } from './tools/web-fetch-toolcall';
import { createRSSFetchTools } from './tools/rss-fetch-toolcall';
import { createBuiltinTools } from './tools/builtin-toolcall';
import { createJavaScriptTools } from './tools/js_toolcall';
import {
    VAULT_AGENT_DESCRIPTION, VAULT_AGENT_PROMPT, VAULT_ROUTING_KEYWORDS,
    WEB_AGENT_DESCRIPTION, WEB_AGENT_PROMPT, WEB_ROUTING_KEYWORDS,
    CODE_AGENT_DESCRIPTION, CODE_AGENT_PROMPT, CODE_ROUTING_KEYWORDS,
} from './prompts/sub-agent-prompts';

export function buildSubAgentConfigs(plugin: NoteAssistantPlugin): SubAgentConfig[] {
    const configs: SubAgentConfig[] = [];

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
            tools: [...vaultTools, ...createBuiltinTools(plugin)],
            resultMaxTokens: 15000,
            routingKeywords: VAULT_ROUTING_KEYWORDS,
        });
    }

    // Web search sub-agent: handles internet searches and content fetching
    const webTools = [
        ...createWebSearchTools(plugin),
        ...createWebFetchTools(plugin),
        ...createRSSFetchTools(plugin),
    ];
    if (webTools.length > 0) {
        configs.push({
            name: 'web',
            description: WEB_AGENT_DESCRIPTION,
            systemPrompt: WEB_AGENT_PROMPT,
            tools: [...webTools, ...createBuiltinTools(plugin)],
            resultMaxTokens: 15000,
            routingKeywords: WEB_ROUTING_KEYWORDS,
        });
    }

    // Code execution sub-agent: handles JavaScript code execution
    const jsTools = createJavaScriptTools(plugin);
    if (jsTools.length > 0) {
        configs.push({
            name: 'code',
            description: CODE_AGENT_DESCRIPTION,
            systemPrompt: CODE_AGENT_PROMPT,
            tools: [...jsTools, ...createBuiltinTools(plugin)],
            resultMaxTokens: 10000,
            routingKeywords: CODE_ROUTING_KEYWORDS,
        });
    }

    return configs;
}
