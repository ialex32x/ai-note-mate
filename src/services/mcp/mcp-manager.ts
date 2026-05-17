import type { IMCPClient, MCPServerConfig, MCPServerState, MCPToolConfig, MCPToolInfo } from './mcp-types';
import type { RegisteredTool, ToolCallResult } from '../chat-stream';
import { SdkMCPClient } from './sdk-mcp-client';
import type NoteAssistantPlugin from '../../main';
import { t } from '../../i18n';
import { deriveSlugBase, disambiguateSlug, isValidSlug } from './slug-generator';

function generateId(): string {
	return `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Look up whether a tool is enabled in a persisted config list. Missing → true. */
function isToolEnabledInConfig(list: MCPToolConfig[], name: string): boolean {
	const entry = list.find(t => t.name === name);
	return entry ? entry.enabled : true;
}

/** Shallow compare two tool config lists (order, name, description, enabled). */
function toolsConfigChanged(a: MCPToolConfig[], b: MCPToolConfig[]): boolean {
	if (a.length !== b.length) return true;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		if (x.name !== y.name || x.enabled !== y.enabled || (x.description ?? '') !== (y.description ?? '')) {
			return true;
		}
	}
	return false;
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
		// Backfill missing / invalid slugs in one pass before any other
		// logic runs — _toRegisteredTool and the settings UI both assume
		// a non-empty, valid slug exists on every server.
		const slugsChanged = this._backfillSlugs(servers);
		if (slugsChanged) {
			try { await this.plugin.saveSettings(); }
			catch (err) { console.error('[MCP] Failed to persist backfilled slugs', err); }
		}
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

	/**
	 * One-shot migration: ensure every server has a valid `slug`.
	 *
	 * Walks `servers` in order; for each entry whose `slug` is missing /
	 * invalid / duplicate of an earlier entry's slug, assigns one derived
	 * from its display name and disambiguated against everything
	 * processed so far. The very first entry's slug "wins" any tie so
	 * that older configs (which previously rendered tool names from the
	 * sanitised display name) keep the same names where possible.
	 *
	 * Returns true iff at least one slug was written, so the caller can
	 * decide whether to persist.
	 */
	private _backfillSlugs(servers: MCPServerConfig[]): boolean {
		const taken = new Set<string>();
		let mutated = false;
		for (const cfg of servers) {
			const current = cfg.slug;
			// Reuse the existing slug iff it is well-formed AND not already
			// claimed by an earlier server. Otherwise regenerate.
			if (current && isValidSlug(current) && !taken.has(current)) {
				taken.add(current);
				continue;
			}
			const base = deriveSlugBase(cfg.name);
			const slug = disambiguateSlug(base, taken);
			cfg.slug = slug;
			taken.add(slug);
			mutated = true;
		}
		return mutated;
	}

	/** Add and optionally connect a new server */
	async addServer(config: MCPServerConfig): Promise<void> {
		// Ensure the new server has a unique, valid slug before exposing
		// it via getRegisteredTools(). Callers (settings UI, programmatic
		// imports) are not required to fill this in themselves.
		if (!config.slug || !isValidSlug(config.slug) || this._isSlugTakenByOther(config.slug, config.id)) {
			const base = deriveSlugBase(config.name);
			config.slug = disambiguateSlug(base, this._collectTakenSlugs(config.id));
		}
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

	/**
	 * Compute the set of slugs currently in use by all configured
	 * servers, optionally excluding one (typically the server we're
	 * about to assign a slug to, so it doesn't see its own old slug as
	 * a collision).
	 */
	private _collectTakenSlugs(excludeServerId?: string): Set<string> {
		const taken = new Set<string>();
		for (const s of this.plugin.settings.mcpServers ?? []) {
			if (s.id === excludeServerId) continue;
			if (s.slug && isValidSlug(s.slug)) taken.add(s.slug);
		}
		return taken;
	}

	private _isSlugTakenByOther(slug: string, serverId: string): boolean {
		for (const s of this.plugin.settings.mcpServers ?? []) {
			if (s.id === serverId) continue;
			if (s.slug === slug) return true;
		}
		return false;
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
	 * Get `RegisteredTool[]` for all currently usable MCP tools.
	 *
	 * Filtering is driven entirely by global plugin settings:
	 * - Server-level: `MCPServerConfig.enabled` (toggled in the MCP settings
	 *   section) — must be `true` AND the underlying client must be connected.
	 * - Tool-level: `MCPToolConfig.enabled` (toggled per tool in the same
	 *   settings section) — defaults to enabled if no entry exists yet.
	 */
	getRegisteredTools(): RegisteredTool[] {
		const tools: RegisteredTool[] = [];
		// Defensive: detect schema-name collisions across servers/tools
		// and drop the duplicates with a console warning instead of
		// silently shadowing one of them. With the slug system this
		// should be unreachable in normal operation; the guard is here
		// to surface data corruption (e.g. hand-edited data.json) rather
		// than let it manifest as "this tool never gets called".
		const seenNames = new Set<string>();

		for (const [serverId, client] of this.clients) {
			if (!client.connected) continue;

			const state = this._states.get(serverId);
			if (!state || !state.config.enabled) continue;

			const slug = state.config.slug ?? deriveSlugBase(state.config.name);
			const toolConfigs = state.config.tools;

			for (const tool of client.tools) {
				// Per-tool opt-out: skip tools the user has disabled in config.
				// If no entry exists yet (e.g., race before first sync), default to enabled.
				if (toolConfigs && !isToolEnabledInConfig(toolConfigs, tool.name)) continue;
				const registered = this._toRegisteredTool(serverId, state.config.name, slug, tool);
				const schemaName = registered.schema.function.name;
				if (seenNames.has(schemaName)) {
					console.warn(`[MCP] Dropping duplicate tool name "${schemaName}" (server "${state.config.name}"). Check MCP server slugs in settings.`);
					continue;
				}
				seenNames.add(schemaName);
				tools.push(registered);
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

	/**
	 * Create a default MCPServerConfig.
	 *
	 * `slug` is left undefined intentionally — {@link addServer} assigns
	 * one based on the final display name (which the UI typically sets
	 * after construction) and the current set of taken slugs.
	 */
	static createDefaultConfig(): MCPServerConfig {
		return {
			id: generateId(),
			name: 'New MCP Server',
			url: '',
			enabled: true,
			apiKey: '',
			tools: [],
		};
	}

	/**
	 * Regenerate the slug of an existing server from its current display
	 * name and persist the change. Intended to be invoked from the
	 * settings UI only, after the user has explicitly confirmed (because
	 * any Skill referencing the old `mcp_${oldSlug}_*` tool names will
	 * stop matching).
	 *
	 * Returns the new slug (which may equal the old one if the name now
	 * sanitises identically). Emits a change event so subscribers (UI)
	 * re-render.
	 */
	async regenerateSlug(serverId: string): Promise<string | null> {
		const state = this._states.get(serverId);
		if (!state) return null;
		const newSlug = this.previewSlugForServer(serverId);
		if (state.config.slug !== newSlug) {
			state.config.slug = newSlug;
			this._persistConfig(state.config);
			await this.plugin.saveSettings();
			this._emit();
		}
		return newSlug;
	}

	/**
	 * Compute what slug *would* be generated for `serverId` right now
	 * (based on its current display name and the slugs taken by other
	 * servers). Pure / non-mutating — safe to call from render paths to
	 * surface a "Slug differs from display name" hint or to preview the
	 * outcome of a regenerate action.
	 */
	previewSlugForServer(serverId: string): string {
		const state = this._states.get(serverId);
		if (!state) return '';
		const base = deriveSlugBase(state.config.name);
		return disambiguateSlug(base, this._collectTakenSlugs(serverId));
	}

	/**
	 * Toggle a single tool's enabled state on a server and persist the change.
	 * Safe to call before any successful connection — a config entry will be
	 * created if missing.
	 */
	async setToolEnabled(serverId: string, toolName: string, enabled: boolean): Promise<void> {
		const state = this._states.get(serverId);
		if (!state) return;

		const config = state.config;
		const list = config.tools ?? (config.tools = []);
		const entry = list.find(t => t.name === toolName);
		if (entry) {
			if (entry.enabled === enabled) return;
			entry.enabled = enabled;
		} else {
			list.push({ name: toolName, enabled });
		}

		this._persistConfig(config);
		await this.plugin.saveSettings();
		this._emit();
	}

	// ── Private ──────────────────────────────────────────

	/**
	 * Sync the live tool list returned by the server into the persisted
	 * `config.tools` array.
	 *
	 * Rules:
	 * - Existing entries: keep `enabled`, refresh `description`.
	 * - New entries: appended with `enabled: true`.
	 * - Stale entries (no longer reported by server): removed.
	 *
	 * If the merged result differs from the previous one, the change is
	 * written back to `plugin.settings.mcpServers` and persisted via
	 * `plugin.saveSettings()`.
	 */
	private async _syncToolsToConfig(config: MCPServerConfig, liveTools: MCPToolInfo[]): Promise<void> {
		const previous = config.tools ?? [];
		const previousByName = new Map(previous.map(t => [t.name, t]));

		const merged: MCPToolConfig[] = liveTools.map(live => {
			const existing = previousByName.get(live.name);
			return {
				name: live.name,
				description: live.description,
				enabled: existing ? existing.enabled : true,
			};
		});

		if (!toolsConfigChanged(previous, merged)) return;

		config.tools = merged;
		this._persistConfig(config);
		try {
			await this.plugin.saveSettings();
		} catch (err) {
			console.error('[MCP] Failed to persist tool list', err);
		}
	}

	/**
	 * Mirror a config object into `plugin.settings.mcpServers` so the next
	 * `saveSettings()` writes the latest values to disk.
	 */
	private _persistConfig(config: MCPServerConfig): void {
		const list = this.plugin.settings.mcpServers;
		if (!list) return;
		const idx = list.findIndex(s => s.id === config.id);
		if (idx === -1) return;
		// The state holds the same reference, but be defensive in case
		// settings was deep-cloned somewhere.
		list[idx] = config;
	}

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
			// Sync the live tool list back into the persisted config so users
			// can toggle individual tools (preserving their enabled choices).
			void this._syncToolsToConfig(state.config, tools);
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

	private _toRegisteredTool(serverId: string, serverName: string, slug: string, tool: MCPToolInfo): RegisteredTool {
		// `slug` is bounded to 12 chars by the slug generator, so the
		// final name is at most 4 (`mcp_`) + 12 + 1 (`_`) + len(tool.name)
		// — well under the OpenAI 64-char limit for any realistic
		// upstream tool name. The .slice(0, 64) is kept as a paranoid
		// last-resort cap that should never fire in practice.
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
