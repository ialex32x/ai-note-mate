// ─────────────────────────────────────────────
// MCP Types & Interfaces
// ─────────────────────────────────────────────

/** Configuration for an MCP server (persisted in plugin settings) */
export interface MCPServerConfig {
	/** Unique ID (auto-generated) */
	id: string;
	/** Display name */
	name: string;
	/** Server URL (Streamable HTTP endpoint) */
	url: string;
	/** Whether this server is globally enabled */
	enabled: boolean;
	/** Optional API key for authentication */
	apiKey: string;
	/** Use Obsidian's requestUrl instead of native fetch (bypasses CORS) */
	useRequestUrl?: boolean;
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
