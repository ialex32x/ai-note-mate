import { SecretComponent, Setting, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { MCPManager } from "../../services/mcp/mcp-manager";
import type { MCPServerConfig, MCPServerState } from "../../services/mcp/mcp-types";
import type { SectionContext, SettingsSection } from "./types";

/** CSS classes applied to the status button, keyed by status. */
const STATUS_CLASSES = [
	'oap-settings-mcp-status--connected',
	'oap-settings-mcp-status--error',
	'oap-settings-mcp-status--connecting',
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

export class MCPSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.mcpServers';

	private onMcpStateChanged: (() => void) | null = null;
	/** Per-server status button refs, keyed by server.id (rebuilt on every render). */
	private statusButtons = new Map<string, HTMLButtonElement>();
	/** Coalesce rapid onChange emissions into a single update pass. */
	private updateScheduled = false;

	constructor(private readonly ctx: SectionContext) {}

	renderHeaderActions(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const mcpServers = plugin.settings.mcpServers;
		const addBtn = container.createEl('button', {
			cls: 'clickable-icon oap-settings-header-action-btn',
		});
		setIcon(addBtn, 'plus');
		setTooltip(addBtn, t('settings.addMcpServer'));
		addBtn.addEventListener('click', async () => {
			const config = MCPManager.createDefaultConfig();
			config.name = `MCP Server ${mcpServers.length + 1}`;
			mcpServers.unshift(config);
			await plugin.saveSettings();
			plugin.mcpManager?.addServer(config);
			refreshSection(this);
		});
	}

	render(container: HTMLElement): void {
		const { plugin } = this.ctx;
		const mcpServers = plugin.settings.mcpServers;

		// Reset the per-server status button map; it will be repopulated
		// as we render each server row below.
		this.statusButtons.clear();

		if (mcpServers.length === 0) {
			container.createEl('div', {
				cls: 'oap-settings-empty',
				text: t('settings.mcpEmpty'),
			});
		}

		for (let idx = 0; idx < mcpServers.length; idx++) {
			const server = mcpServers[idx]!;
			this.renderMCPServerItem(container, server, idx, mcpServers);
		}

		// Subscribe to MCP state changes so the UI reflects live connection
		// status (connecting / connected / error) without manual refresh.
		// Subscribe only once; the listener performs incremental status-icon
		// updates so input focus in other fields is preserved.
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
		this.statusButtons.clear();
		this.updateScheduled = false;
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
		if (configured.length !== this.statusButtons.size) {
			refreshSection(this);
			return;
		}
		for (const server of configured) {
			if (!this.statusButtons.has(server.id)) {
				refreshSection(this);
				return;
			}
		}

		for (const [serverId, btn] of this.statusButtons) {
			applyStatusToButton(btn, manager.getServerState(serverId));
		}
	}

	private renderMCPServerItem(
		container: HTMLElement,
		server: MCPServerConfig,
		idx: number,
		mcpServers: MCPServerConfig[],
	): void {
		const { app, plugin, refreshSection } = this.ctx;
		const state = plugin.mcpManager?.getServerState(server.id);

		// Server header row
		const headerSetting = new Setting(container)
			.setClass('oap-settings-mcp-header')
			.addText(text => text
				.setValue(server.name)
				.setPlaceholder(t('settings.mcpServerName'))
				.onChange(async (value) => {
					server.name = value || 'Unnamed';
					await plugin.saveSettings();
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
				}))
			.addButton(btn => btn
				.setIcon('trash')
				.setTooltip(t('settings.deleteMcpServer'))
				.setWarning()
				.onClick(async () => {
					mcpServers.splice(idx, 1);
					await plugin.saveSettings();
					await plugin.mcpManager?.removeServer(server.id);
					refreshSection(this);
				}));

		// Status icon with tooltip — always create the button so it can be
		// updated incrementally when the MCP manager emits state changes.
		const statusBtn = headerSetting.controlEl.createEl('button', {
			cls: 'oap-settings-mcp-status clickable-icon',
		});
		applyStatusToButton(statusBtn, state);
		statusBtn.addEventListener('click', async () => {
			const currentState = plugin.mcpManager?.getServerState(server.id);
			await navigator.clipboard.writeText(resolveStatusTooltip(currentState));
		});
		this.statusButtons.set(server.id, statusBtn);

		// URL field
		new Setting(container)
			.setClass('oap-settings-field')
			.setName(t('settings.mcpServerUrl'))
			.addText(text => text
				.setValue(server.url)
				.setPlaceholder('https://example.com/mcp')
				.onChange(async (value) => {
					server.url = value;
					await plugin.saveSettings();
				}));

		// API Key field
		new Setting(container)
			.setClass('oap-settings-field')
			.setName(t('settings.mcpServerApiKey'))
			.addComponent(el => new SecretComponent(app, el)
				.setValue(server.apiKey)
				.onChange(async (value) => {
					server.apiKey = value;
					await plugin.saveSettings();
				}));

		// Use requestUrl toggle
		new Setting(container)
			.setClass('oap-settings-field')
			.setName(t('settings.mcpUseRequestUrl'))
			.setDesc(t('settings.mcpUseRequestUrlDesc'))
			.addToggle(toggle => toggle
				.setValue(server.useRequestUrl ?? false)
				.onChange(async (value) => {
					server.useRequestUrl = value || undefined;
					await plugin.saveSettings();
				}));
	}
}
