/**
 * Build SubAgentConfig entries from CustomAgentConfig settings.
 *
 * Each custom agent gets its matching MCP tools. Tools claimed by ANY
 * custom agent are excluded from the main agent's tool list.
 */

import type { CustomAgentConfig } from "../../settings/types";
import type { SubAgentConfig } from "../sub-agent";
import type { RegisteredTool } from "../chat-stream-types";
import { matchesWildcard } from "./custom-agent-parser";
import type NoteAssistantPlugin from "../../main";

/**
 * Compute the set of MCP tool names claimed by any custom agent.
 *
 * Used by {@link buildDynamicTools} to filter these tools out of the
 * main agent's tool list. A tool is "claimed" if its runtime name
 * (`mcp_${slug}_${toolName}`) matches any pattern in any agent's
 * `tools` field.
 */
export function computeClaimedMcpTools(
	agents: readonly CustomAgentConfig[],
	registeredTools: readonly RegisteredTool[],
): Set<string> {
	const claimed = new Set<string>();
	const toolNames = registeredTools.map(t => t.schema.function.name);
	for (const agent of agents) {
		// Must match the same eligibility checks as buildCustomSubAgentConfigs
		// so a pattern-only agent with an empty name doesn't claim tools
		// while producing no sub-agent to serve them.
		if (agent.disabled || !agent.name.trim() || agent.tools.length === 0) continue;
		for (const name of toolNames) {
			if (agent.tools.some(p => matchesWildcard(p, name))) {
				claimed.add(name);
			}
		}
	}
	return claimed;
}

/**
 * Build SubAgentConfig entries from CustomAgentConfig settings.
 *
 * Only agents with at least one matched tool and a non-empty name are
 * included. Agents without matching tools are silently skipped.
 *
 * @param plugin  Plugin instance (for MCP manager access)
 * @param agents  Custom agent configs from settings
 * @returns SubAgentConfig array ready for the AgentOrchestrator
 */
export function buildCustomSubAgentConfigs(
	plugin: NoteAssistantPlugin,
	agents: readonly CustomAgentConfig[],
): SubAgentConfig[] {
	if (!plugin.mcpManager) return [];

	const allMcpTools = plugin.mcpManager.getRegisteredTools();
	if (allMcpTools.length === 0) return [];

	const configs: SubAgentConfig[] = [];
	const seenNames = new Set<string>();

	for (const agent of agents) {
		// Skip disabled agents or those with no name / no tool patterns.
		if (agent.disabled || !agent.name.trim() || agent.tools.length === 0) continue;

		// Match tools against this agent's patterns.
		const matchedTools: RegisteredTool[] = [];
		for (const tool of allMcpTools) {
			const toolName = tool.schema.function.name;
			if (agent.tools.some(p => matchesWildcard(p, toolName))) {
				matchedTools.push(tool);
			}
		}

		if (matchedTools.length === 0) continue;

		// Deduplicate names by appending a suffix when the same name
		// appears more than once (e.g. two agents both named "Searcher").
		let baseName = `custom_${agent.name.trim()}`;
		if (seenNames.has(baseName)) {
			let suffix = 2;
			while (seenNames.has(`${baseName}_${suffix}`)) {
				suffix++;
			}
			baseName = `${baseName}_${suffix}`;
		}
		seenNames.add(baseName);

		configs.push({
			name: baseName,
			description: agent.description.trim(),
			systemPrompt: agent.systemPrompt.trim() || defaultSystemPrompt(agent.name),
			tools: matchedTools,
			routingKeywords: [],
		});
	}

	return configs;
}

/** Fallback system prompt when the user hasn't written one. */
function defaultSystemPrompt(agentName: string): string {
	return [
		`You are "${agentName}", a specialised sub-agent.`,
		'',
		'Use the tools available to you to complete the task delegated',
		'by the main agent. Be thorough and concise.',
		'',
		'When you have completed the task, provide a clear summary of',
		'your findings or actions as your final reply.',
	].join('\n');
}
