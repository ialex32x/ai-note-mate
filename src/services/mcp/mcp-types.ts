// ─────────────────────────────────────────────
// MCP Types & Interfaces
// ─────────────────────────────────────────────

/**
 * A persisted, user-controllable record of a tool exposed by an MCP server.
 *
 * Synced from the live tool list returned by the server on each successful
 * connection. The `enabled` flag is preserved across syncs so users keep
 * their per-tool on/off preferences.
 */
export interface MCPToolConfig {
	/** Tool name as reported by the MCP server */
	name: string;
	/** Latest description reported by the server (refreshed on every sync) */
	description?: string;
	/** Whether this tool is exposed to the model. Defaults to true for new tools. */
	enabled: boolean;
}

/** Configuration for an MCP server (persisted in plugin settings) */
export interface MCPServerConfig {
	/** Unique ID (auto-generated) */
	id: string;
	/** Display name */
	name: string;
	/**
	 * Stable identifier used to build the tool name exposed to the LLM
	 * (`mcp_${slug}_${toolName}`). Auto-generated from `name` on first
	 * save and **never** mutated by routine operations (renames, reloads,
	 * reconnects, add/remove of other servers). Users may explicitly
	 * regenerate it via the "Regenerate slug" action, with the
	 * understanding that any Skill referencing the old tool names will
	 * stop working.
	 *
	 * Optional on the type to support backwards-compatible loading of
	 * older `data.json` files. {@link MCPManager.initialize} fills it in
	 * (and persists) on first load.
	 */
	slug?: string;
	/** Server URL (Streamable HTTP endpoint) */
	url: string;
	/** Whether this server is globally enabled */
	enabled: boolean;
	/** Optional API key for authentication */
	apiKey: string;
	/** Use Obsidian's requestUrl instead of native fetch (bypasses CORS) */
	useRequestUrl?: boolean;
	/**
	 * Persisted, user-controllable list of tools exposed by this server.
	 *
	 * - Empty before the first successful connection.
	 * - Synced after each successful connection: existing entries keep their
	 *   `enabled` state but get their `description` refreshed; new tools are
	 *   appended with `enabled: true`; tools no longer reported by the
	 *   server are removed.
	 */
	tools?: MCPToolConfig[];
}

/** A tool exposed by an MCP server */
export interface MCPToolInfo {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

/** Connection status */
export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Observable state of a managed MCP server (for UI display) */
export interface MCPServerState {
	config: MCPServerConfig;
	status: MCPServerStatus;
	tools: MCPToolInfo[];
	error?: string;
}

/**
 * Abstract MCP client interface.
 * Swap the implementation to change the transport
 * (e.g., replace fetch-based with @modelcontextprotocol/sdk).
 */
export interface IMCPClient {
	readonly connected: boolean;
	readonly tools: MCPToolInfo[];
	connect(url: string, options?: { apiKey?: string; useRequestUrl?: boolean }): Promise<MCPToolInfo[]>;
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
	close(): void;
}
