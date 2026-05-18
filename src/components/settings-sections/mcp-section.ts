import { SecretComponent, Setting, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { MCPManager } from "../../services/mcp/mcp-manager";
import type { MCPServerConfig, MCPServerState, MCPToolConfig } from "../../services/mcp/mcp-types";
import { copyToClipboard } from "../../utils/clipboard";
import { RegenerateSlugConfirmModal } from "../../modals/regenerate-slug-confirm-modal";
import {
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
	/**
	 * Signature of the tools list currently shown in the editor. Used to
	 * detect server-side tool changes (after a (re)connect) and trigger a
	 * full re-render so the displayed list stays in sync.
	 */
	private editorToolsSignature: string | null = null;
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
		this.editorToolsSignature = null;

		// Resolve which server is being edited.
		const editingId = this.getEditingServerId();
		const editingServer = mcpServers.find(s => s.id === editingId) || mcpServers[0];
		if (editingServer) {
			this.editingServerId = editingServer.id;
		}

		// ── Tab bar (always rendered so the "+" Add button is available even
		//    when there are no servers yet) ──
		// Empty display names are allowed (with a non-blocking warning in
		// the editor) — render the i18n fallback label here so the tab
		// is still visible/clickable.
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
				// Intentionally not awaited: addServer() performs a
				// network handshake that can take seconds. The UI shows
				// the new server immediately and the status dot will
				// update via the onChange listener once connection
				// settles (or fails).
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

		// If the tools list of the currently-edited server changed (e.g.
		// after a successful (re)connect synced new tools into the
		// config), do a full re-render so the list stays accurate.
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

		// ── Header row: name + enabled toggle + reconnect + status ──
		// Refs we update on every name keystroke so the empty-name
		// warning and slug-divergence indicator stay in sync without
		// having to re-render the whole editor (which would steal focus
		// from the input).
		let nameWarningEl: HTMLElement | null = null;
		let slugInfoEl: HTMLElement | null = null;

		const headerSetting = new Setting(container)
			.setName(t('settings.mcpServerName'))
			.addText(text => text
				.setValue(server.name)
				.setPlaceholder(t('settings.mcpServerName'))
				.onChange(async (value) => {
					// Persist the raw user input (no "Unnamed" fallback) —
					// the empty-name warning is non-blocking and the
					// renderer below handles display fallback.
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

		// Status icon with tooltip — also clickable to copy details.
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

		// ── Empty-name warning (under the name field, non-blocking) ──
		// Rendered as a sibling of the Setting row so it inherits the
		// row's horizontal padding via the explicit class.
		nameWarningEl = container.createDiv({ cls: 'oap-mcp-name-warning' });
		this.refreshNameWarning(nameWarningEl, server.name);

		// ── Slug preview / Regenerate row ────────────────────────────
		// Shown right after the name so the link between display name
		// and tool-id is visually obvious. Slug is read-only (the user
		// can only "regenerate" it explicitly).
		const slugSetting = new Setting(container)
			.setName(t('settings.mcpServerSlug'))
			.setDesc(t('settings.mcpServerSlugDesc'));

		const slugValueEl = slugSetting.controlEl.createEl('code', {
			cls: 'oap-mcp-slug-value',
		});
		// Tool-id preview line is rendered below the setting (full-width)
		// so long ids don't squeeze the Regenerate button off-screen.
		slugInfoEl = container.createDiv({ cls: 'oap-mcp-slug-info' });

		slugSetting.addExtraButton(btn => btn
			.setIcon('copy')
			.setTooltip(t('settings.mcpSlugCopy'))
			.onClick(() => {
				void copyToClipboard(server.slug ?? '');
			}));
		slugSetting.addExtraButton(btn => btn
			.setIcon('refresh-cw')
			.setTooltip(t('settings.mcpSlugRegenerate'))
			.onClick(async () => {
				await this.handleRegenerateSlug(server);
				// Pull the (possibly) updated slug back into the UI.
				slugValueEl.setText(server.slug ?? '');
				this.refreshSlugInfo(slugInfoEl, server);
				refreshSection(this);
			}));

		slugValueEl.setText(server.slug ?? '');
		this.refreshSlugInfo(slugInfoEl, server);

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
			.setName(t('common.apiKey'))
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

		// ── Tools list ──
		// Persisted, synced from the server on each successful connect.
		// Users can individually toggle which tools are exposed to the model.
		this.renderToolsList(container, server);
	}

	/**
	 * Update the empty-name warning element under the name field.
	 *
	 * Non-blocking by design: an empty display name is allowed (so users
	 * can hit "Add" first and finish naming later) but discouraged
	 * because anywhere the name is shown will then have to fall back to
	 * a generic placeholder.
	 */
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

	/**
	 * Refresh the "Tool ID: mcp_<slug>_*" preview line plus the
	 * divergence hint shown when the user has renamed the server but
	 * not regenerated its slug.
	 */
	private refreshSlugInfo(el: HTMLElement | null, server: MCPServerConfig): void {
		if (!el) return;
		el.empty();
		const { plugin } = this.ctx;
		const slug = server.slug ?? '';
		// Tool-id preview — what Skill files would reference.
		const preview = el.createDiv({ cls: 'oap-mcp-slug-preview' });
		preview.createSpan({
			cls: 'oap-mcp-slug-preview__label',
			text: t('settings.mcpSlugPreviewLabel'),
		});
		preview.createEl('code', {
			cls: 'oap-mcp-slug-preview__value',
			text: slug ? `mcp_${slug}_*` : '—',
		});

		// Divergence indicator: only shown when name and slug have
		// drifted apart and a regenerate would actually change something.
		const expected = plugin.mcpManager?.previewSlugForServer(server.id) ?? '';
		if (expected && expected !== slug) {
			const note = el.createDiv({ cls: 'oap-mcp-slug-divergence' });
			note.setText(t('settings.mcpSlugDivergenceNote', { suggested: expected }));
		}
	}

	/**
	 * Prompt the user to confirm regenerating a server's slug, then
	 * execute. No-op (returns silently) when the resulting slug would
	 * equal the current one — there is nothing to confirm in that case.
	 */
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

	/**
	 * Render the per-server tool list. Records a signature of the tools
	 * shown so {@link applyStatusUpdates} can detect server-side changes
	 * (e.g. after a (re)connect) and trigger a full re-render.
	 */
	private renderToolsList(container: HTMLElement, server: MCPServerConfig): void {
		const { plugin } = this.ctx;
		const tools = server.tools ?? [];
		this.editorToolsSignature = computeToolsSignature(tools);

		// Render tools at the same nesting level as other server fields so
		// horizontal alignment matches. No section header — the tool rows
		// (or the empty-state hint) speak for themselves.
		if (tools.length === 0) {
			container.createDiv({
				cls: 'oap-mcp-tools-empty',
				text: t('settings.mcpToolsEmpty'),
			});
			return;
		}

		for (const tool of tools) {
			// One Setting per tool: name on the left, description as desc,
			// toggle on the right. Setting's standard layout keeps things
			// visually consistent with the rest of the settings page.
			const setting = new Setting(container)
				.setName(tool.name)
				.addToggle(toggle => toggle
					.setValue(tool.enabled)
					.onChange(async (value) => {
						tool.enabled = value;
						setting.settingEl.toggleClass('is-disabled', !value);
						await plugin.mcpManager?.setToolEnabled(server.id, tool.name, value);
						// Refresh our local signature so the change-detection
						// in applyStatusUpdates doesn't trigger a redundant
						// re-render after our own toggle.
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

/**
 * Compute a compact signature of a tools list so we can detect changes
 * (additions/removals/description updates/enabled toggles) cheaply.
 */
function computeToolsSignature(tools: MCPToolConfig[] | undefined): string {
	if (!tools || tools.length === 0) return '';
	return tools
		.map(t => `${t.name}\u0001${t.enabled ? '1' : '0'}\u0001${t.description ?? ''}`)
		.join('\u0002');
}
