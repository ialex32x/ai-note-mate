import { DropdownComponent, Setting } from "obsidian";
import { t } from "../../i18n";
import type { EmbeddingProviderType } from "../../services/providers";
import {
	createDefaultEmbeddingConfig,
	DEFAULT_TOOL_FILTER_SIMILARITY_THRESHOLD,
	DEFAULT_TOOL_FILTER_TOP_K,
} from "../../settings/defaults";
import type { EmbeddingConfig } from "../../settings/types";
import {
	createApiKeyField,
	createDropdownField,
	createTabBar,
	createTextField,
	createToggleField,
	refreshDropdownOptions,
	scrollActiveTabIntoView,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";

export class EmbeddingSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.embeddingSection';

	private editingEmbeddingId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection, containerEl } = this.ctx;
		const embeddingConfigs = plugin.settings.embeddingConfigs;

		// Embedding enabled toggle. Marked experimental at the master switch
		// rather than on every sub-setting: this is the single entry point
		// users see before opting in, so the flask badge here is enough to
		// communicate the status of the entire embedding subsystem (active
		// config selection, tool-filter knobs, etc.).
		createToggleField({
			container,
			name: t('settings.embeddingEnabled'),
			desc: t('settings.embeddingEnabledDesc'),
			value: plugin.settings.embeddingEnabled,
			onChange: async (value) => {
				plugin.settings.embeddingEnabled = value;
				await plugin.saveSettings();
			},
			experimental: true,
		});

		// ── Tool filter tuning (global, applies whenever embedding is used
		//    to gate on-demand tools). Bounds are validated at the use-site
		//    (ChatStream._getBestMatchedTools) so we don't need range UI here
		//    beyond a sensible placeholder + light input parsing.
		createTextField({
			container,
			name: t('settings.toolFilterSimilarityThreshold'),
			desc: t('settings.toolFilterSimilarityThresholdDesc'),
			placeholder: String(DEFAULT_TOOL_FILTER_SIMILARITY_THRESHOLD),
			value: String(plugin.settings.toolFilterSimilarityThreshold),
			onChange: async (value) => {
				const num = parseFloat(value);
				plugin.settings.toolFilterSimilarityThreshold =
					isNaN(num) ? DEFAULT_TOOL_FILTER_SIMILARITY_THRESHOLD
					: Math.max(0, Math.min(1, num));
				await plugin.saveSettings();
			},
		});

		createTextField({
			container,
			name: t('settings.toolFilterTopK'),
			desc: t('settings.toolFilterTopKDesc'),
			placeholder: String(DEFAULT_TOOL_FILTER_TOP_K),
			value: String(plugin.settings.toolFilterTopK),
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.toolFilterTopK =
					isNaN(num) ? DEFAULT_TOOL_FILTER_TOP_K
					: Math.max(1, Math.min(30, num));
				await plugin.saveSettings();
			},
		});

		// ── Active embedding selector ──
		let activeEmbeddingDropdown: DropdownComponent;
		{
			new Setting(container)
				.setName(t('settings.embeddingConfig'))
				.setDesc(t('settings.embeddingConfigDesc'))
				.addDropdown((dropdown: DropdownComponent) => {
					activeEmbeddingDropdown = dropdown;
					for (const c of embeddingConfigs) {
						dropdown.addOption(c.id, c.name || 'Unnamed');
					}
					dropdown.setValue(plugin.settings.activeEmbeddingId);
					dropdown.onChange(async (value: string) => {
						plugin.settings.activeEmbeddingId = value;
						await plugin.saveSettings();
						refreshSection(this);
						scrollActiveTabIntoView(containerEl, '.oap-embedding-tabs .oap-profile-tabs__scroll');
					});
				});
		}

		// ── Embedding tab bar ──
		if (embeddingConfigs.length > 0) {
			const editingId = this.getEditingEmbeddingId();
			const editingEmbedding = embeddingConfigs.find(c => c.id === editingId) || embeddingConfigs[0]!;
			if (editingEmbedding) {
				this.editingEmbeddingId = editingEmbedding.id;
			}

			const tabBarResult = createTabBar({
				container,
				items: embeddingConfigs.map(c => ({
					id: c.id,
					name: c.name,
					tooltip: c.name || 'Unnamed',
				})),
				activeId: plugin.settings.activeEmbeddingId,
				editingId: editingEmbedding.id,
				onTabClick: (id) => {
					this.editingEmbeddingId = id;
					refreshSection(this);
				},
				activeDotTooltip: t('settings.embeddingConfig'),
				extraClass: 'oap-embedding-tabs',
				onAdd: async () => {
					const newConfig = createDefaultEmbeddingConfig();
					newConfig.name = `Embedding ${embeddingConfigs.length + 1}`;
					embeddingConfigs.push(newConfig);
					plugin.settings.activeEmbeddingId = newConfig.id;
					this.editingEmbeddingId = newConfig.id;
					await plugin.saveSettings();
					refreshSection(this);
				},
				addTooltip: t('settings.addEmbeddingConfig'),
				onDelete: async () => {
					if (embeddingConfigs.length <= 1) return;
					const idx = embeddingConfigs.findIndex(c => c.id === editingEmbedding.id);
					embeddingConfigs.splice(idx, 1);
					if (plugin.settings.activeEmbeddingId === editingEmbedding.id) {
						plugin.settings.activeEmbeddingId = embeddingConfigs[0]!.id;
					}
					this.editingEmbeddingId = embeddingConfigs[0]!.id;
					await plugin.saveSettings();
					refreshSection(this);
				},
				deleteTooltip: t('settings.deleteEmbeddingConfigDesc'),
				disableDelete: embeddingConfigs.length <= 1,
			});

			// Helper: refresh active embedding dropdown
			const refreshActiveEmbeddingDropdown = () => {
				if (activeEmbeddingDropdown == null) return;
				refreshDropdownOptions(activeEmbeddingDropdown, embeddingConfigs);
			};

			// ── Embedding config editor ──
			this.renderEmbeddingEditor(
				container,
				editingEmbedding,
				tabBarResult.refreshTabLabel,
				refreshActiveEmbeddingDropdown,
			);
		}
	}

	/** Get the ID of the embedding config currently being edited in the settings tab */
	private getEditingEmbeddingId(): string {
		const { plugin } = this.ctx;
		if (this.editingEmbeddingId) {
			const exists = plugin.settings.embeddingConfigs.some(c => c.id === this.editingEmbeddingId);
			if (exists) return this.editingEmbeddingId;
		}
		return plugin.settings.activeEmbeddingId
			|| plugin.settings.embeddingConfigs[0]?.id
			|| '';
	}

	private renderEmbeddingEditor(
		container: HTMLElement,
		config: EmbeddingConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
		refreshDropdown: () => void,
	): void {
		const { app, plugin, refreshSection } = this.ctx;

		// Config name
		createTextField({
			container,
			name: t('settings.embeddingName'),
			placeholder: t('settings.embeddingNamePlaceholder'),
			value: config.name,
			onChange: async (value) => {
				config.name = value || 'Unnamed';
				await plugin.saveSettings();
				refreshTabLabel(config.id, config.name, config.name);
				refreshDropdown();
			},
		});

		// Provider type
		createDropdownField({
			container,
			name: t('settings.provider'),
			desc: t('settings.embeddingProviderDesc'),
			options: {
				'openai': 'OpenAI Compatible',
				'gemini': 'Google Gemini',
			},
			value: config.type,
			onChange: async (value) => {
				config.type = value as EmbeddingProviderType;
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// Base URL (OpenAI only)
		if (config.type === 'openai') {
			createTextField({
				container,
				name: t('settings.baseUrl'),
				desc: t('settings.embeddingBaseUrlDesc'),
				placeholder: t('settings.baseUrlPlaceholder'),
				value: config.baseUrl,
				onChange: async (value) => {
					config.baseUrl = value;
					await plugin.saveSettings();
				},
			});
		}

		// API Key
		createApiKeyField({
			container,
			app,
			name: t('settings.apiKey'),
			desc: t('settings.embeddingApiKeyDesc'),
			value: config.apiKey,
			onChange: async (value) => {
				config.apiKey = value;
				await plugin.saveSettings();
			},
		});

		// Model
		const modelPlaceholder = config.type === 'gemini' ? 'text-embedding-004' : 'text-embedding-3-small';
		createTextField({
			container,
			name: t('settings.embeddingModel'),
			desc: t('settings.embeddingModelDesc'),
			placeholder: modelPlaceholder,
			value: config.model,
			onChange: async (value) => {
				config.model = value || modelPlaceholder;
				await plugin.saveSettings();
			},
		});
	}
}
