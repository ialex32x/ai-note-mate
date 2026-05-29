import { SecretComponent, Setting, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { MCPManager } from "../../services/mcp/mcp-manager";
import type { MCPServerConfig, MCPServerState, MCPToolConfig } from "../../services/mcp/mcp-types";
import { copyToClipboard } from "../../utils/clipboard";
import { RegenerateSlugConfirmModal } from "../../modals/regenerate-slug-confirm-modal";
import { ALL_TOOL_CAPABILITIES, type ToolCapability } from "../../services/llm-provider";
import {
	createDefaultUploadConfig,
	DEFAULT_TOOL_FILTER_TOP_K,
	DEFAULT_SUB_AGENT_FILTER_TOP_K,
} from "../../settings/defaults";
import type { UploadConfig, UploadProviderType } from "../../settings/types";
import {
	createApiKeyField,
	createDropdownField,
	createSettingsGroupHeading,
	createTabBar,
	createTextField,
	createToggleField,
	isAdvancedSettingsVisible,
	markSettingAdvanced,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { TOOLS_SECTION_ID } from "../../settings/section-ids";

/**
 * Label / description i18n keys for each capability in the tools settings UI.
 * Reuses the existing `view.cap*` / `view.cap*Tip` keys used by the toolbar
 * selector so the two surfaces stay consistent.
 */
const CAPABILITY_I18N: Record<ToolCapability, { label: string; desc: string }> = {
	read_file: { label: 'view.capReadFile', desc: 'view.capReadFileTip' },
	write_file: { label: 'view.capWriteFile', desc: 'view.capWriteFileTip' },
	create_file: { label: 'view.capCreateFile', desc: 'view.capCreateFileTip' },
	delete_file: { label: 'common.delete', desc: 'view.capDeleteFileTip' },
	network: { label: 'view.capNetwork', desc: 'view.capNetworkTip' },
	multimodal_generate: { label: 'view.capMultimodalGenerate', desc: 'view.capMultimodalGenerateTip' },
	execute: { label: 'view.capExecute', desc: 'view.capExecuteTip' },
};

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

export class ToolsSettingsSection implements SettingsSection {
	readonly titleKey = TOOLS_SECTION_ID;

	/** ID of the server currently being edited in the tab bar. */
	private editingServerId: string | null = null;

	private onMcpStateChanged: (() => void) | null = null;
	/** Status button ref for the currently-rendered editor (null when empty). */
	private editorStatusBtn: HTMLButtonElement | null = null;
	/** ID of the server `editorStatusBtn` belongs to. */
	private editorStatusServerId: string | null = null;
	/** Per-server tab status dots, keyed by server.id. Rebuilt on each render. */
	private tabDots = new Map<string, HTMLElement>();
	/**
	 * Signature of the tools list currently shown in the editor. Used to
	 * detect server-side tool changes (after a (re)connect) and trigger a
	 * full re-render so the displayed list stays in sync.
	 */
	private editorToolsSignature: string | null = null;
	/** Coalesce rapid onChange emissions into a single update pass. */
	private updateScheduled = false;

	// ── Upload state ──
	private editingUploadId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	private renderBuiltinToolToggles(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createToggleField({
			container,
			name: t('settings.builtinWebSearch'),
			desc: t('settings.builtinWebSearchDesc'),
			value: plugin.settings.builtinWebSearchEnabled,
			onChange: async (value) => {
				plugin.settings.builtinWebSearchEnabled = value;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});

		createToggleField({
			container,
			name: t('settings.builtinWebFetch'),
			desc: t('settings.builtinWebFetchDesc'),
			value: plugin.settings.builtinWebFetchEnabled,
			onChange: async (value) => {
				plugin.settings.builtinWebFetchEnabled = value;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});

		createToggleField({
			container,
			name: t('settings.builtinRSSFetch'),
			desc: t('settings.builtinRSSFetchDesc'),
			value: plugin.settings.builtinRSSFetchEnabled,
			onChange: async (value) => {
				plugin.settings.builtinRSSFetchEnabled = value;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});

		createToggleField({
			container,
			name: t('settings.builtinJavaScript'),
			desc: t('settings.builtinJavaScriptDesc'),
			value: plugin.settings.builtinJavaScriptEnabled,
			onChange: async (value) => {
				plugin.settings.builtinJavaScriptEnabled = value;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
			experimental: true,
		});
	}

	private renderWebFetchLimits(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createTextField({
			container,
			name: t('settings.webFetchSoftLimit'),
			desc: t('settings.webFetchSoftLimitDesc'),
			placeholder: '5',
			value: String(plugin.settings.webFetchSoftLimit),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.webFetchSoftLimit = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});

		createTextField({
			container,
			name: t('settings.webFetchHardLimit'),
			desc: t('settings.webFetchHardLimitDesc'),
			placeholder: '12',
			value: String(plugin.settings.webFetchHardLimit),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.webFetchHardLimit = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});
	}

	private renderArtifactStore(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createSettingsGroupHeading(container, {
			name: t('settings.artifactStore'),
			desc: t('settings.artifactStoreDesc'),
			advancedOnly: true,
		});

		createTextField({
			container,
			name: t('settings.artifactStoreTotalBytesKb'),
			desc: t('settings.artifactStoreTotalBytesKbDesc'),
			placeholder: '1024',
			value: String(plugin.settings.artifactStoreTotalBytesKb),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.artifactStoreTotalBytesKb = isNaN(num) ? 0 : num;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});

		createTextField({
			container,
			name: t('settings.artifactStoreSingleArtifactKb'),
			desc: t('settings.artifactStoreSingleArtifactKbDesc'),
			placeholder: '128',
			value: String(plugin.settings.artifactStoreSingleArtifactKb),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.artifactStoreSingleArtifactKb = isNaN(num) ? 0 : num;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});

		createTextField({
			container,
			name: t('settings.artifactStoreTtlMinutes'),
			desc: t('settings.artifactStoreTtlMinutesDesc'),
			placeholder: '30',
			value: String(plugin.settings.artifactStoreTtlMinutes),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.artifactStoreTtlMinutes = isNaN(num) ? -1 : num;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});
	}

	private renderToolConfirmMode(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createDropdownField({
			container,
			name: t('settings.toolConfirmMode'),
			desc: t('settings.toolConfirmModeDesc'),
			options: {
				'auto': t('settings.toolConfirmModeAuto'),
				'always': t('settings.toolConfirmModeAlways'),
			},
			value: plugin.settings.toolConfirmMode,
			onChange: async (value) => {
				plugin.settings.toolConfirmMode = value as 'auto' | 'always';
				await plugin.saveSettings();
			},
		});
	}

	private renderCapabilityToggles(container: HTMLElement): void {
		const { plugin } = this.ctx;

		new Setting(container)
			.setName(t('settings.allowedCapabilities'))
			.setDesc(t('settings.allowedCapabilitiesDesc'));

		const row = container.createDiv({ cls: 'oap-capabilities-row' });

		for (const cap of ALL_TOOL_CAPABILITIES) {
			const keys = CAPABILITY_I18N[cap];
			const label = row.createEl('label', { cls: 'oap-capability-item' });
			setTooltip(label, t(keys.desc), { placement: 'top' });

			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = plugin.settings.allowedCapabilities.includes(cap);

			label.createSpan({ cls: 'oap-capability-label', text: t(keys.label) });

			input.addEventListener('change', () => {
				const current = new Set(plugin.settings.allowedCapabilities);
				if (input.checked) {
					current.add(cap);
				} else {
					current.delete(cap);
				}
				plugin.settings.allowedCapabilities = ALL_TOOL_CAPABILITIES.filter(c => current.has(c));
				void plugin.saveSettings();
			});
		}
	}

	// ─────────────────────────────────────────────────────────────────────
	// Upload config
	// ─────────────────────────────────────────────────────────────────────

	private renderUploadConfig(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const uploadConfigs = plugin.settings.uploadConfigs;

		createSettingsGroupHeading(container, {
			name: t('settings.uploadConfig'),
		});

		// ── Upload tab bar (always visible, even with 0 configs) ──
		const editingId = this.getEditingUploadId();
		const editingUpload = uploadConfigs.length > 0
			? (uploadConfigs.find(c => c.id === editingId) || uploadConfigs[0]!)
			: null;
		if (editingUpload) {
			this.editingUploadId = editingUpload.id;
		}

		const tabBarResult = createTabBar({
			container,
			items: uploadConfigs.map(c => ({
				id: c.id,
				name: c.name,
				tooltip: c.name || 'Unnamed',
			})),
			activeId: plugin.settings.activeUploadId,
			editingId: editingUpload?.id ?? '',
			onTabClick: (id) => {
				this.editingUploadId = id;
				refreshSection(this);
			},
			activeDotTooltip: t('settings.uploadConfig'),
			extraClass: 'oap-upload-tabs',
			onAdd: async () => {
				const newConfig = createDefaultUploadConfig();
				newConfig.name = `Upload ${uploadConfigs.length + 1}`;
				uploadConfigs.push(newConfig);
				plugin.settings.activeUploadId = newConfig.id;
				this.editingUploadId = newConfig.id;
				await plugin.saveSettings();
				this.ctx.onProfilesChanged?.();
				refreshSection(this);
			},
			addTooltip: t('settings.addUploadConfig'),
			onDelete: editingUpload ? async () => {
				if (uploadConfigs.length <= 1) return;
				const idx = uploadConfigs.findIndex(c => c.id === editingUpload.id);
				uploadConfigs.splice(idx, 1);
				if (plugin.settings.activeUploadId === editingUpload.id) {
					plugin.settings.activeUploadId = uploadConfigs[0]!.id;
				}
				this.editingUploadId = uploadConfigs[0]!.id;
				await plugin.saveSettings();
				this.ctx.onProfilesChanged?.();
				refreshSection(this);
			} : undefined,
			deleteTooltip: t('settings.deleteUploadConfigDesc'),
			disableDelete: !editingUpload || uploadConfigs.length <= 1,
		});

		// Editor (only when a config exists)
		if (editingUpload) {
			this.renderUploadEditor(
				container,
				editingUpload,
				tabBarResult.refreshTabLabel,
			);
		}
	}

	private getEditingUploadId(): string {
		const { plugin } = this.ctx;
		if (this.editingUploadId) {
			const exists = plugin.settings.uploadConfigs.some(c => c.id === this.editingUploadId);
			if (exists) return this.editingUploadId;
		}
		return plugin.settings.activeUploadId
			|| plugin.settings.uploadConfigs[0]?.id
			|| '';
	}

	private renderUploadEditor(
		container: HTMLElement,
		config: UploadConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin } = this.ctx;

		createTextField({
			container,
			name: t('settings.uploadName'),
			placeholder: t('settings.uploadNamePlaceholder'),
			value: config.name,
			onChange: async (value) => {
				config.name = value || 'Unnamed';
				await plugin.saveSettings();
				refreshTabLabel(config.id, config.name, config.name);
				this.ctx.onProfilesChanged?.();
			},
		});

		createDropdownField({
			container,
			name: t('settings.uploadProvider'),
			desc: t('settings.uploadProviderDesc'),
			options: {
				'bailian-oss': t('settings.uploadProviderBailianOss'),
			},
			value: config.provider,
			onChange: async (value) => {
				config.provider = value as UploadProviderType;
				await plugin.saveSettings();
			},
		});

		createApiKeyField({
			container,
			app,
			name: t('common.apiKey'),
			desc: t('settings.uploadApiKeyDesc'),
			value: config.apiKey,
			onChange: async (value) => {
				config.apiKey = value;
				await plugin.saveSettings();
			},
		});
	}

	// ─────────────────────────────────────────────────────────────────────
	// Main render
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Tool / sub-agent retriever top-K knobs.
	 *
	 * These two settings live at the top of the Tools section because they
	 * directly cap how many tools (and how many sub-agents in multi-agent
	 * mode) reach the model on each turn. The retrievers are hybrid
	 * BM25 + cosine when an embedding is configured, BM25-only otherwise —
	 * but the upper-bound cap applies in either case, so the controls
	 * belong with tool surface tuning rather than embedding configuration.
	 *
	 * Bounds are enforced at the use-site (ChatStream._getBestMatchedTools
	 * and the orchestrator) so the UI just clamps to a sensible range here.
	 */
	private renderRetrieverTopK(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createTextField({
			container,
			name: t('settings.toolFilterTopK'),
			desc: t('settings.toolFilterTopKDesc'),
			placeholder: String(DEFAULT_TOOL_FILTER_TOP_K),
			value: String(plugin.settings.toolFilterTopK),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.toolFilterTopK =
					isNaN(num) ? DEFAULT_TOOL_FILTER_TOP_K
					: Math.max(1, Math.min(30, num));
				await plugin.saveSettings();
			},
		});

		createTextField({
			container,
			name: t('settings.subAgentFilterTopK'),
			desc: t('settings.subAgentFilterTopKDesc'),
			placeholder: String(DEFAULT_SUB_AGENT_FILTER_TOP_K),
			value: String(plugin.settings.subAgentFilterTopK),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.subAgentFilterTopK =
					isNaN(num) ? DEFAULT_SUB_AGENT_FILTER_TOP_K
					: Math.max(1, Math.min(8, num));
				await plugin.saveSettings();
			},
		});
	}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const mcpServers = plugin.settings.mcpServers;

		this.renderRetrieverTopK(container);

		this.renderBuiltinToolToggles(container);

		this.renderWebFetchLimits(container);

		this.renderToolConfirmMode(container);

		this.renderCapabilityToggles(container);

		this.renderArtifactStore(container);

		// ── MCP Servers ──
		createSettingsGroupHeading(container, {
			name: t('settings.mcpServers'),
		});

		// Reset per-render refs.
		this.editorStatusBtn = null;
		this.editorStatusServerId = null;
		this.tabDots.clear();
		this.editorToolsSignature = null;

		// Resolve which server is being edited.
		const editingId = this.getEditingServerId();
		const editingServer = mcpServers.find(s => s.id === editingId) || mcpServers[0];
		if (editingServer) {
			this.editingServerId = editingServer.id;
		}

		// ── Tab bar ──
		const tabBarResult = createTabBar({
			container,
			items: mcpServers.map(s => {
				const label = s.name.trim() || t('settings.mcpServerNameFallback');
				return {
					id: s.id,
					name: label,
					tooltip: s.url || label,
				};
			}),
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
				void plugin.mcpManager?.addServer(config);
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

		// Augment each tab with a small status dot.
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

		// ── Upload ──
		this.renderUploadConfig(container);

		// Subscribe to MCP state changes.
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
		this.editorToolsSignature = null;
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
		void Promise.resolve().then(() => {
			this.updateScheduled = false;
			this.applyStatusUpdates();
		});
	}

	private applyStatusUpdates(): void {
		const { plugin, refreshSection } = this.ctx;
		const manager = plugin.mcpManager;
		if (!manager) return;

		const configured = plugin.settings.mcpServers ?? [];
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

		for (const [serverId, dot] of this.tabDots) {
			applyStatusToTabDot(dot, manager.getServerState(serverId));
		}

		if (this.editorStatusBtn && this.editorStatusServerId) {
			applyStatusToButton(
				this.editorStatusBtn,
				manager.getServerState(this.editorStatusServerId),
			);
		}

		if (this.editorStatusServerId && this.editorToolsSignature !== null) {
			const editingServer = configured.find(s => s.id === this.editorStatusServerId);
			if (editingServer) {
				const sig = computeToolsSignature(editingServer.tools);
				if (sig !== this.editorToolsSignature) {
					refreshSection(this);
				}
			}
		}
	}

	private renderEditor(
		container: HTMLElement,
		server: MCPServerConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin, refreshSection } = this.ctx;
		const state = plugin.mcpManager?.getServerState(server.id);

		let nameWarningEl: HTMLElement | null = null;
		let slugInfoEl: HTMLElement | null = null;

		const headerSetting = new Setting(container)
			.setName(t('settings.mcpServerName'))
			.addText(text => text
				.setValue(server.name)
				.setPlaceholder(t('settings.mcpServerName'))
				.onChange(async (value) => {
					server.name = value;
					await plugin.saveSettings();
					const label = server.name.trim() || t('settings.mcpServerNameFallback');
					refreshTabLabel(server.id, label, server.url || label);
					this.refreshNameWarning(nameWarningEl, server.name);
					this.refreshSlugInfo(slugInfoEl, server);
				}))
			.addToggle(toggle => toggle
				.setValue(server.enabled)
				.onChange(async (value) => {
					server.enabled = value;
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

		const statusBtn = headerSetting.controlEl.createEl('button', {
			cls: 'oap-settings-mcp-status clickable-icon',
		});
		applyStatusToButton(statusBtn, state);
		statusBtn.addEventListener('click', () => {
			const currentState = plugin.mcpManager?.getServerState(server.id);
			void copyToClipboard(resolveStatusTooltip(currentState));
		});
		this.editorStatusBtn = statusBtn;
		this.editorStatusServerId = server.id;

		nameWarningEl = container.createDiv({ cls: 'oap-mcp-name-warning' });
		this.refreshNameWarning(nameWarningEl, server.name);

		const slugSetting = new Setting(container)
			.setName(t('settings.mcpServerSlug'))
			.setDesc(t('settings.mcpServerSlugDesc'));

		const slugValueEl = slugSetting.controlEl.createEl('code', {
			cls: 'oap-mcp-slug-value',
		});
		slugInfoEl = slugSetting.descEl.createDiv({ cls: 'oap-mcp-slug-info' });

		slugSetting.addExtraButton(btn => btn
			.setIcon('refresh-cw')
			.setTooltip(t('settings.mcpSlugRegenerate'))
			.onClick(async () => {
				await this.handleRegenerateSlug(server);
				slugValueEl.setText(server.slug ?? '');
				this.refreshSlugInfo(slugInfoEl, server);
				refreshSection(this);
			}));

		slugValueEl.setText(server.slug ?? '');
		this.refreshSlugInfo(slugInfoEl, server);

		if (isAdvancedSettingsVisible()) {
			markSettingAdvanced(slugSetting);
		} else {
			slugSetting.settingEl.addClass('oap-setting--advanced-collapsed');
		}

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

		new Setting(container)
			.setName(t('common.apiKey'))
			.addComponent(el => new SecretComponent(app, el)
				.setValue(server.apiKey)
				.onChange(async (value) => {
					server.apiKey = value;
					await plugin.saveSettings();
				}));

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

		this.renderToolsList(container, server);
	}

	private refreshNameWarning(el: HTMLElement | null, name: string): void {
		if (!el) return;
		const empty = !name || !name.trim();
		el.toggleClass('is-visible', empty);
		if (empty) {
			el.setText(t('settings.mcpServerNameEmptyWarning'));
		} else {
			el.empty();
		}
	}

	private refreshSlugInfo(el: HTMLElement | null, server: MCPServerConfig): void {
		if (!el) return;
		el.empty();
		const { plugin } = this.ctx;
		const slug = server.slug ?? '';
		const preview = el.createDiv({ cls: 'oap-mcp-slug-preview' });
		preview.createSpan({
			cls: 'oap-mcp-slug-preview__label',
			text: t('settings.mcpSlugPreviewLabel'),
		});
		preview.createEl('code', {
			cls: 'oap-mcp-slug-preview__value',
			text: slug ? `mcp_${slug}_*` : '—',
		});

		const expected = plugin.mcpManager?.previewSlugForServer(server.id) ?? '';
		if (expected && expected !== slug) {
			const note = el.createDiv({ cls: 'oap-mcp-slug-divergence' });
			note.setText(t('settings.mcpSlugDivergenceNote', { suggested: expected }));
		}
	}

	private async handleRegenerateSlug(server: MCPServerConfig): Promise<void> {
		const { app, plugin } = this.ctx;
		const manager = plugin.mcpManager;
		if (!manager) return;

		const oldSlug = server.slug ?? '';
		const newSlug = manager.previewSlugForServer(server.id);
		if (!newSlug || newSlug === oldSlug) return;

		const toolNames = (server.tools ?? []).map(t => t.name);
		const { confirmed } = await new RegenerateSlugConfirmModal(
			app, oldSlug, newSlug, toolNames,
		).waitForResult();
		if (!confirmed) return;

		await manager.regenerateSlug(server.id);
	}

	private renderToolsList(container: HTMLElement, server: MCPServerConfig): void {
		const { plugin } = this.ctx;
		const tools = server.tools ?? [];
		this.editorToolsSignature = computeToolsSignature(tools);

		if (tools.length === 0) {
			container.createDiv({
				cls: 'oap-mcp-tools-empty',
				text: t('settings.mcpToolsEmpty'),
			});
			return;
		}

		for (const tool of tools) {
			const setting = new Setting(container)
				.setName(tool.name)
				.addToggle(toggle => toggle
					.setValue(tool.enabled)
					.onChange(async (value) => {
						tool.enabled = value;
						setting.settingEl.toggleClass('is-disabled', !value);
						await plugin.mcpManager?.setToolEnabled(server.id, tool.name, value);
						this.editorToolsSignature = computeToolsSignature(server.tools ?? []);
					}));

			setting.settingEl.addClass('oap-mcp-tool');
			if (!tool.enabled) setting.settingEl.addClass('is-disabled');

			const descText = tool.description?.trim();
			if (descText) {
				setting.setDesc(descText);
			} else {
				setting.setDesc(t('settings.mcpToolNoDescription'));
				setting.descEl.addClass('is-placeholder');
			}
		}
	}
}

function computeToolsSignature(tools: MCPToolConfig[] | undefined): string {
	if (!tools || tools.length === 0) return '';
	return tools
		.map(t => `${t.name}\u0001${t.enabled ? '1' : '0'}\u0001${t.description ?? ''}`)
		.join('\u0002');
}
