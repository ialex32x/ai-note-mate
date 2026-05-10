import type { IMCPClient, MCPServerConfig, MCPServerState, MCPToolInfo } from './mcp-types';
import type { RegisteredTool, ToolCallResult } from '../chat-stream';
import { SdkMCPClient } from './sdk-mcp-client';
import type NoteAssistantPlugin from '../../main';
import { t } from '../../i18n';

function generateId(): string {
	return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Sanitize a string for use as part of a tool function name (a-zA-Z0-9_-) */
function sanitizeForToolName(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_|_$/g, '');
}

/**
 * Manages connections to multiple MCP servers.
		* Uses `IMCPClient` internally — swap the concrete class to change
		 * the transport without changing any other code.
 */
export class MCPManager {
	private plugin: NoteAssistantPlugin;
	private clients = new Map<string, IMCPClient>();
	private _states = new Map<string, MCPServerState>();
	private _listeners: Array<() => void> = [];

	constructor(plugin: NoteAssistantPlugin) {
		this.plugin = plugin;
	}

	// ── Observer pattern ──────────────────────────────────

	onChange(cb: () => void) { this._listeners.push(cb); }
	offChange(cb: () => void) {
		const i = this._listeners.indexOf(cb);
		if (i !== -1) this._listeners.splice(i, 1);
	}
	private _emit() { for (const cb of this._listeners) cb(); }

	// ── Public API ────────────────────────────────────────

	/** Get observable state of all configured servers */
	getServerStates(): MCPServerState[] {
		return Array.from(this._states.values());
	}

	/** Get state for a specific server */
	getServerState(serverId: string): MCPServerState | undefined {
		return this._states.get(serverId);
	}

	/** Initialize: connect to all globally enabled servers from settings */
	async initialize(): Promise<void> {
		const servers = this.plugin.settings.mcpServers ?? [];
		for (const config of servers) {
			this._states.set(config.id, {
				config,
				status: 'disconnected',
				tools: [],
			});
			if (config.enabled) {
				void this._connectServer(config.id);
			}
		}
	}

	/** Add and optionally connect a new server */
	async addServer(config: MCPServerConfig): Promise<void> {
		this._states.set(config.id, {
			config,
			status: 'disconnected',
			tools: [],
		});
		if (config.enabled) {
			await this._connectServer(config.id);
		}
		this._emit();
	}

	/** Remove and disconnect a server */
	async removeServer(serverId: string): Promise<void> {
		const client = this.clients.get(serverId);
		if (client) { client.close(); this.clients.delete(serverId); }
		this._states.delete(serverId);
		this._emit();
	}

	/** Reconnect a specific server */
	async reconnectServer(serverId: string): Promise<void> {
		await this._connectServer(serverId);
	}

	/** Update a server config and reconnect if needed */
	async updateServer(oldId: string, newConfig: MCPServerConfig): Promise<void> {
		if (oldId !== newConfig.id) {
			const client = this.clients.get(oldId);
			if (client) { client.close(); this.clients.delete(oldId); }
			this._states.delete(oldId);
		}

		this._states.set(newConfig.id, {
			config: newConfig,
			status: 'disconnected',
			tools: [],
		});

		if (newConfig.enabled) {
			await this._connectServer(newConfig.id);
		} else {
			const client = this.clients.get(newConfig.id);
			if (client) { client.close(); this.clients.delete(newConfig.id); }
		}
		this._emit();
	}

	/**
	 * Get `RegisteredTool[]` from connected servers, filtered by session state.
	 *
	 * @param enabledServerIds  Servers enabled for this session
	 */
	getRegisteredTools(
		enabledServerIds: Set<string>,
	): RegisteredTool[] {
		const tools: RegisteredTool[] = [];

		for (const [serverId, client] of this.clients) {
			if (!client.connected) continue;
			if (!enabledServerIds.has(serverId)) continue;

			const state = this._states.get(serverId);
			const serverName = state?.config.name ?? serverId;

			for (const tool of client.tools) {
				tools.push(this._toRegisteredTool(serverId, serverName, tool));
			}
		}
		return tools;
	}

	/** Call a tool on a specific server */
	async callTool(
		serverId: string,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		const client = this.clients.get(serverId);
		if (!client?.connected) {
			throw new Error(t('mcp.serverNotConnected'));
		}
		return client.callTool(toolName, args, signal);
	}

	/** Close all connections */
	async closeAll(): Promise<void> {
		for (const client of this.clients.values()) client.close();
		this.clients.clear();
		for (const state of this._states.values()) {
			state.status = 'disconnected';
			state.tools = [];
			state.error = undefined;
		}
		this._emit();
	}

	/** Disconnect a specific server without removing it */
	disconnectServer(serverId: string): void {
		const client = this.clients.get(serverId);
		if (client) { client.close(); this.clients.delete(serverId); }
		const state = this._states.get(serverId);
		if (state) {
			state.status = 'disconnected';
			state.tools = [];
			state.error = undefined;
		}
		this._emit();
	}

	/** Create a default MCPServerConfig */
	static createDefaultConfig(): MCPServerConfig {
		return {
			id: generateId(),
			name: 'New MCP Server',
			url: '',
			enabled: true,
			apiKey: '',
			userToggled: false,
		};
	}

	// ── Private ──────────────────────────────────────────

	private async _connectServer(serverId: string): Promise<void> {
		const state = this._states.get(serverId);
		if (!state) return;

		// Close existing connection if any
		const existing = this.clients.get(serverId);
		if (existing) { existing.close(); this.clients.delete(serverId); }

		state.status = 'connecting';
		state.error = undefined;
		this._emit();

		try {
			const client: IMCPClient = new SdkMCPClient();
			const apiKey = this._resolveApiKey(state.config.apiKey);
			const tools = await client.connect(state.config.url, { apiKey, useRequestUrl: state.config.useRequestUrl });

			// Server may have been removed or disconnected while connecting
			if (!this._states.has(serverId) || state.status !== 'connecting') {
				client.close();
				return;
			}

			this.clients.set(serverId, client);
			state.status = 'connected';
			state.tools = tools;
			this._emit();
		} catch (err) {
			// Server may have been removed or disconnected while connecting
			if (!this._states.has(serverId) || state.status !== 'connecting') return;

			state.status = 'error';
			state.error = err instanceof Error ? err.message : String(err);
			this._emit();
		}
	}

	private _resolveApiKey(stored: string): string | undefined {
		if (!stored) return undefined;
		try {
			const secret = this.plugin.app.secretStorage?.getSecret(stored);
			return secret ?? stored;
		} catch {
			return stored;
		}
	}

	private _toRegisteredTool(serverId: string, serverName: string, tool: MCPToolInfo): RegisteredTool {
		const slug = sanitizeForToolName(serverName);
		const schemaName = `mcp_${slug}_${tool.name}`.slice(0, 64);

		return {
			ondemand: true,

			schema: {
				type: 'function',
				function: {
					name: schemaName,
					description: tool.description
						? `[MCP: ${serverName}] ${tool.description}`
						: `[MCP: ${serverName}] ${tool.name}`,
					parameters: tool.inputSchema,
				},
			},
			capabilities: ['network'],
			exec: async (_chatStream, args, signal?: AbortSignal): Promise<ToolCallResult> => {
				try {
					const result = await this.callTool(serverId, tool.name, args, signal);
					return { success: true, type: 'text', content: result };
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return { success: false, type: 'text', content: msg };
				}
			},
		};
	}
}
