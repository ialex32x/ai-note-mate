/**
 * Runtime utilities for custom-agent tool matching.
 *
 * These helpers operate on the persisted {@link CustomAgentConfig} from
 * settings — they no longer parse markdown notes.
 */

import type { MCPServerConfig } from "../mcp/mcp-types";

/**
 * Normalise a raw tools value into a clean string list.
 *
 * Accepts a natural YAML array form as well as a single string (split on
 * commas and newlines). Non-string array members are coerced via
 * `String(...)`; blank entries are dropped and duplicates removed while
 * preserving first-seen order.
 */
export function normalizeAgentTools(raw: unknown): string[] {
	let parts: string[];
	if (Array.isArray(raw)) {
		parts = raw.map(v => String(v));
	} else if (typeof raw === "string") {
		parts = raw.split(/[,\n]/);
	} else {
		return [];
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Test whether a tool name matches a wildcard pattern.
 *
 * Supports a single `*` glob that matches zero or more characters.
 * Matching is case-insensitive. Examples:
 *   - `mcp_*` matches `mcp_search_grep`, `mcp_web_fetch`
 *   - `*search*` matches anything containing "search"
 */
export function matchesWildcard(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	const regexStr = escaped.replace(/\*/g, '.*');
	try {
		return new RegExp(`^${regexStr}$`, 'i').test(value);
	} catch {
		return false;
	}
}

/**
 * Build a flat list of prefixed tool names from persisted MCP server
 * configurations. Each name follows the `mcp_${slug}_${toolName}` pattern
 * used at runtime. Servers without a slug or without tools are skipped.
 */
export function buildMcpToolNames(servers: readonly MCPServerConfig[]): string[] {
	const names: string[] = [];
	for (const server of servers) {
		if (!server.slug || !server.tools) continue;
		for (const tool of server.tools) {
			names.push(`mcp_${server.slug}_${tool.name}`);
		}
	}
	return names;
}

/** A tool entry with its name and optional description. */
export interface McpToolInfo {
	name: string;
	description?: string;
}

/**
 * Build a flat list of prefixed tool names with descriptions from persisted
 * MCP server configurations, filtered by the given wildcard patterns.
 */
export function buildMcpToolInfos(
	servers: readonly MCPServerConfig[],
	patterns: readonly string[],
): McpToolInfo[] {
	const result: McpToolInfo[] = [];
	for (const server of servers) {
		if (!server.slug || !server.tools) continue;
		for (const tool of server.tools) {
			const fullName = `mcp_${server.slug}_${tool.name}`;
			if (patterns.some(p => matchesWildcard(p, fullName))) {
				result.push({ name: fullName, description: tool.description });
			}
		}
	}
	return result;
}
