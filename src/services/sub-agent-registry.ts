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
            tools: [...editorTools, ...createBuiltinTools(plugin)],
            // Diff summaries are far smaller than digest arrays — cap
            // at 4K to keep a wholesale-rewrite result trimmed even if
            // the sub-agent stuffs all 5 samples at full 240-char cap.
            resultMaxTokens: 4000,
            routingKeywords: VAULT_EDITOR_ROUTING_KEYWORDS,
        });
    }

    // Web search sub-agent: handles internet searches and content fetching
    const webSearchTools = createWebSearchTools(plugin);
    const webTools = [
        ...webSearchTools,
        ...createWebFetchTools(plugin),
        ...createRSSFetchTools(plugin),
    ];
    if (webTools.length > 0) {
        configs.push({
            name: 'web',
            description: WEB_AGENT_DESCRIPTION,
            systemPrompt: createWebAgentPrompt(webSearchTools.length > 0),
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
