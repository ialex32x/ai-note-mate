import { Setting, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { SystemPromptModal } from "../../modals/system-prompt-modal";
import {
	applyAdvancedOnlyGroupHeading,
	createDropdownField,
	createTextField,
	createToggleField,
	markSettingRequiresSessionRestart,
} from "../settings-components";
import { ALL_TOOL_CAPABILITIES, type ToolCapability } from "../../services/llm-provider";
import type { SectionContext, SettingsSection } from "./types";

/**
 * Label / description i18n keys for each capability in the global settings UI.
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

export class GlobalSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.globalSection';

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshAll } = this.ctx;

		// System prompt (display-only with edit button)
		this.renderSystemPromptField(container);

		createToggleField({
			container,
			name: t('settings.showAdvanced'),
			desc: t('settings.showAdvancedDesc'),
			value: plugin.settings.showAdvanced,
			onChange: async (value) => {
				plugin.settings.showAdvanced = value;
				await plugin.saveSettings();
				refreshAll();
			},
		});

		// Enter to send toggle
		createToggleField({
			container,
			name: t('settings.enterToSend'),
			desc: t('settings.enterToSendDesc'),
			value: plugin.settings.enterToSend,
			onChange: async (value) => {
				plugin.settings.enterToSend = value;
				await plugin.saveSettings();
			},
		});

		// Built-in web search tool toggle
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

		// Built-in web fetch tool toggle
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

		// Per-turn budget for web_fetch_url. Both knobs are session-restart
		// dependent because `maxCallsPerTurn` is captured into the tool
		// definition at registration time (createWebFetchTools), not read
		// per call. Values <= 0 fall back to plugin defaults at use-site
		// (see resolveBudget in web-fetch-toolcall.ts).
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

		// Built-in RSS fetch tool toggle
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

		// Built-in JavaScript tool toggle
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

		// ── Sub-agent return cache (artifact store) ─────────────────────────
		// All three knobs are read once at SessionRuntime construction
		// (see runtime-factory.ts). Existing runtimes are NOT re-tuned —
		// users are warned via the session-restart hint.
		const artifactStoreHeading = new Setting(container)
			.setName(t('settings.artifactStore'))
			.setDesc(t('settings.artifactStoreDesc'))
			.setHeading();
		applyAdvancedOnlyGroupHeading(artifactStoreHeading);

		createTextField({
			container,
			name: t('settings.artifactStoreTotalBytesKb'),
			desc: t('settings.artifactStoreTotalBytesKbDesc'),
			placeholder: '1024',
			value: String(plugin.settings.artifactStoreTotalBytesKb),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				// `< 1` falls back to default at use-site (deriveArtifactStoreOptions);
				// store the user's literal here so the UI reflects what they typed,
				// even if it's a sentinel like 0.
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
				// Negative falls back to default; 0 explicitly disables TTL
				// (see deriveArtifactStoreOptions). NaN → -1 so the helper
				// reads it as "use default".
				plugin.settings.artifactStoreTtlMinutes = isNaN(num) ? -1 : num;
				await plugin.saveSettings();
			},
			sessionRestartRequired: true,
		});

		// Tool confirm mode dropdown
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

		// Allowed tool capabilities (flat list of checkboxes).
		this.renderCapabilityToggles(container);
	}

	private renderCapabilityToggles(container: HTMLElement): void {
		const { plugin } = this.ctx;

		// Title + description on their own Setting row, then a separate row
		// below containing label-only checkboxes distributed evenly across
		// the full width. Descriptions are surfaced via Obsidian's tooltip.
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
				// Preserve canonical order.
				plugin.settings.allowedCapabilities = ALL_TOOL_CAPABILITIES.filter(c => current.has(c));
				void plugin.saveSettings();
			});
		}
	}

	private renderSystemPromptField(container: HTMLElement): void {
		const { app, plugin, refreshSection } = this.ctx;
		const systemPrompt = plugin.settings.systemPrompt;

		// Build tooltip with truncated prompt preview (max 100 chars)
		let tooltip = t('settings.editInitialPrompt');
		if (systemPrompt && systemPrompt.trim()) {
			const truncated = systemPrompt.length > 100
				? systemPrompt.substring(0, 100) + '…'
				: systemPrompt;
			tooltip = truncated;
		}

		const setting = new Setting(container)
			.setName(t('settings.initialPrompt'))
			.setDesc(t('settings.initialPromptDesc'))
			.addButton(btn => btn
				.setIcon('pencil')
				.setTooltip(tooltip)
				.onClick(() => {
					const modal = new SystemPromptModal(app, plugin.settings.systemPrompt);
					modal.onSave = async (value: string) => {
						plugin.settings.systemPrompt = value;
						await plugin.saveSettings();
						refreshSection(this); // Refresh to update tooltip
					};
					modal.open();
				}));

		markSettingRequiresSessionRestart(setting);
	}
}
