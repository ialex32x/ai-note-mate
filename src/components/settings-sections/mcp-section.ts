import { SecretComponent, Setting, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { MCPManager } from "../../services/mcp/mcp-manager";
import type { MCPServerConfig, MCPServerState } from "../../services/mcp/mcp-types";
import { copyToClipboard } from "../../utils/clipboard";
import {
	createApiKeyField,
	createTabBar,
	createTextField,
	createToggleField,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";

/** CSS classes applied to the status button, keyed by status. */
const STATUS_CLASSES = [
	'oap-settings-mcp-status--connected',
	'oap-settings-mcp-status--error',
	'oap-settings-mcp-status--connecting',
] as const;

/** CSS classes applied to the per-tab status dot, keyed by status. */
const TAB_DOT_CLASSES = [
	'oap-mcp-tab-dot--connected',
	'oap-mcp-tab-dot--error',
	'oap-mcp-tab-dot--connecting',
] as const;

function resolveStatusIcon(status: MCPServerState['status'] | undefined): string {
	switch (status) {
		case 'connected': return 'check-circle';
		case 'error': return 'alert-circle';
		case 'connecting': return 'loader-2';
		default: return 'circle-off';
	}
}

function resolveStatusTooltip(state: MCPServerState | undefined): string {
	if (!state) return '';
	const parts: string[] = [state.status];
	if (state.error) parts.push(state.error);
	if (state.tools.length > 0) parts.push(`${state.tools.length} tools`);
	return parts.join(' — ');
}

function applyStatusToButton(btn: HTMLButtonElement, state: MCPServerState | undefined): void {
	setIcon(btn, resolveStatusIcon(state?.status));
	setTooltip(btn, resolveStatusTooltip(state));
	for (const cls of STATUS_CLASSES) btn.removeClass(cls);
	if (state?.status === 'connected') btn.addClass('oap-settings-mcp-status--connected');
	else if (state?.status === 'error') btn.addClass('oap-settings-mcp-status--error');
	else if (state?.status === 'connecting') btn.addClass('oap-settings-mcp-status--connecting');
}

function applyStatusToTabDot(dot: HTMLElement, state: MCPServerState | undefined): void {
	for (const cls of TAB_DOT_CLASSES) dot.removeClass(cls);
	if (state?.status === 'connected') dot.addClass('oap-mcp-tab-dot--connected');
	else if (state?.status === 'error') dot.addClass('oap-mcp-tab-dot--error');
	else if (state?.status === 'connecting') dot.addClass('oap-mcp-tab-dot--connecting');
	setTooltip(dot, resolveStatusTooltip(state));
}

export class MCPSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.mcpServers';

	/** ID of the server currently being edited in the tab bar. */
	private editingServerId: string | null = null;

	private onMcpStateChanged: (() => void) | null = null;
	/** Status button ref for the currently-rendered editor (null when empty). */
	private editorStatusBtn: HTMLButtonElement | null = null;
	/** ID of the server `editorStatusBtn` belongs to. */
	private editorStatusServerId: string | null = null;
	/** Per-server tab status dots, keyed by server.id. Rebuilt on each render. */
	private tabDots = new Map<string, HTMLElement>();
	/** Coalesce rapid onChange emissions into a single update pass. */
	private updateScheduled = false;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const mcpServers = plugin.settings.mcpServers;

		// Reset per-render refs.
		this.editorStatusBtn = null;
		this.editorStatusServerId = null;
		this.tabDots.clear();

		// Resolve which server is being edited.
		const editingId = this.getEditingServerId();
		const editingServer = mcpServers.find(s => s.id === editingId) || mcpServers[0];
		if (editingServer) {
			this.editingServerId = editingServer.id;
		}

		// ── Tab bar (always rendered so the "+" Add button is available even
		//    when there are no servers yet) ──
		const tabBarResult = createTabBar({
			container,
			items: mcpServers.map(s => ({
				id: s.id,
				name: s.name,
				tooltip: s.url || s.name || 'Unnamed',
			})),
			// MCP has no "active" concept (each server is independently
			// enabled), so reuse `editingId` here. activeDotTooltip is omitted
			// so no extra dot is drawn.
			activeId: editingServer?.id ?? '',
			editingId: editingServer?.id ?? '',
			onTabClick: (id) => {
				this.editingServerId = id;
				refreshSection(this);
			},
			extraClass: 'oap-mcp-tabs',
			onAdd: async () => {
				const config = MCPManager.createDefaultConfig();
				config.name = `MCP Server ${mcpServers.length + 1}`;
				mcpServers.unshift(config);
				this.editingServerId = config.id;
				await plugin.saveSettings();
				plugin.mcpManager?.addServer(config);
				refreshSection(this);
			},
			addTooltip: t('settings.addMcpServer'),
			onDelete: editingServer ? async () => {
				const idx = mcpServers.findIndex(s => s.id === editingServer.id);
				if (idx < 0) return;
				mcpServers.splice(idx, 1);
				await plugin.saveSettings();
				await plugin.mcpManager?.removeServer(editingServer.id);
				this.editingServerId = mcpServers[0]?.id ?? null;
				refreshSection(this);
			} : undefined,
			deleteTooltip: t('settings.deleteMcpServer'),
			disableDelete: !editingServer,
		});

		// Augment each tab with a small status dot. Placed before the label
		// (prepended) to keep visual consistency with `.oap-profile-tab__active-dot`.
		for (const server of mcpServers) {
			const tabEl = tabBarResult.tabElMap.get(server.id);
			if (!tabEl) continue;
			const dot = tabEl.doc.createElement('span');
			dot.addClass('oap-mcp-tab-dot');
			tabEl.prepend(dot);
			applyStatusToTabDot(dot, plugin.mcpManager?.getServerState(server.id));
			this.tabDots.set(server.id, dot);
		}

		// ── Empty state / editor ──
		if (!editingServer) {
			container.createEl('div', {
				cls: 'oap-settings-empty',
				text: t('settings.mcpEmpty'),
			});
		} else {
			this.renderEditor(container, editingServer, tabBarResult.refreshTabLabel);
		}

		// Subscribe to MCP state changes so the UI reflects live connection
		// status (connecting / connected / error) without manual refresh.
		// Subscribe only once; the listener performs incremental updates.
		if (!this.onMcpStateChanged) {
			const listener = () => this.scheduleStatusUpdate();
			this.onMcpStateChanged = listener;
			plugin.mcpManager?.onChange(listener);
		}
	}

	dispose(): void {
		if (this.onMcpStateChanged) {
			this.ctx.plugin.mcpManager?.offChange(this.onMcpStateChanged);
			this.onMcpStateChanged = null;
		}
		this.editorStatusBtn = null;
		this.editorStatusServerId = null;
		this.tabDots.clear();
		this.updateScheduled = false;
	}

	/** Get the ID of the server currently being edited. */
	private getEditingServerId(): string {
		const { plugin } = this.ctx;
		if (this.editingServerId) {
			const exists = plugin.settings.mcpServers.some(s => s.id === this.editingServerId);
			if (exists) return this.editingServerId;
		}
		return plugin.settings.mcpServers[0]?.id ?? '';
	}

	/**
	 * Defer status updates to a microtask so that (a) we don't mutate the
	 * DOM while MCPManager is still iterating its listener list, and
	 * (b) multiple rapid emissions collapse into a single update.
	 */
	private scheduleStatusUpdate(): void {
		if (this.updateScheduled) return;
		this.updateScheduled = true;
		Promise.resolve().then(() => {
			this.updateScheduled = false;
			this.applyStatusUpdates();
		});
	}

	private applyStatusUpdates(): void {
		const { plugin, refreshSection } = this.ctx;
		const manager = plugin.mcpManager;
		if (!manager) return;

		const configured = plugin.settings.mcpServers ?? [];
		// If the set of servers we rendered diverges from the current
		// configuration (e.g. a server was added/removed outside of our
		// explicit refresh paths), fall back to a full section re-render.
		if (configured.length !== this.tabDots.size) {
			refreshSection(this);
			return;
		}
		for (const server of configured) {
			if (!this.tabDots.has(server.id)) {
				refreshSection(this);
				return;
			}
		}

		// Update each tab's status dot.
		for (const [serverId, dot] of this.tabDots) {
			applyStatusToTabDot(dot, manager.getServerState(serverId));
		}

		// Update the editor's status button (only one server is shown).
		if (this.editorStatusBtn && this.editorStatusServerId) {
			applyStatusToButton(
				this.editorStatusBtn,
				manager.getServerState(this.editorStatusServerId),
			);
		}
	}

	private renderEditor(
		container: HTMLElement,
		server: MCPServerConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin } = this.ctx;
		const state = plugin.mcpManager?.getServerState(server.id);

		// ── Header row: name + enabled toggle + reconnect + status ──
		const headerSetting = new Setting(container)
			.setName(t('settings.mcpServerName'))
			.addText(text => text
				.setValue(server.name)
				.setPlaceholder(t('settings.mcpServerName'))
				.onChange(async (value) => {
					server.name = value || 'Unnamed';
					await plugin.saveSettings();
					refreshTabLabel(server.id, server.name, server.url || server.name);
				}))
			.addToggle(toggle => toggle
				.setValue(server.enabled)
				.onChange(async (value) => {
					server.enabled = value;
					server.userToggled = true;
					await plugin.saveSettings();
					if (value) {
						await plugin.mcpManager?.updateServer(server.id, server);
					} else {
						plugin.mcpManager?.disconnectServer(server.id);
					}
				}))
			.addButton(btn => btn
				.setIcon('rotate-cw')
				.setTooltip(t('settings.mcpReconnect'))
				.onClick(async () => {
					await plugin.mcpManager?.reconnectServer(server.id);
				}));

		// Status icon with tooltip — also clickable to copy details.
		const statusBtn = headerSetting.controlEl.createEl('button', {
			cls: 'oap-settings-mcp-status clickable-icon',
		});
		applyStatusToButton(statusBtn, state);
		statusBtn.addEventListener('click', async () => {
			const currentState = plugin.mcpManager?.getServerState(server.id);
			await copyToClipboard(resolveStatusTooltip(currentState));
		});
		this.editorStatusBtn = statusBtn;
		this.editorStatusServerId = server.id;

		// URL field
		createTextField({
			container,
			name: t('settings.mcpServerUrl'),
			placeholder: 'https://example.com/mcp',
			value: server.url,
			onChange: async (value) => {
				server.url = value;
				await plugin.saveSettings();
				refreshTabLabel(server.id, server.name, server.url || server.name);
			},
		});

		// API Key field
		new Setting(container)
			.setName(t('settings.mcpServerApiKey'))
			.addComponent(el => new SecretComponent(app, el)
				.setValue(server.apiKey)
				.onChange(async (value) => {
					server.apiKey = value;
					await plugin.saveSettings();
				}));

		// Use requestUrl toggle
		createToggleField({
			container,
			name: t('settings.mcpUseRequestUrl'),
			desc: t('settings.mcpUseRequestUrlDesc'),
			value: server.useRequestUrl ?? false,
			onChange: async (value) => {
				server.useRequestUrl = value || undefined;
				await plugin.saveSettings();
			},
		});
	}
}
