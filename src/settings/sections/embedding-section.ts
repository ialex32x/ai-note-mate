import { Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import type { EmbeddingProviderType } from "../../services/providers";
import { createDefaultEmbeddingConfig } from "../defaults";
import type { EmbeddingConfig } from "../types";
import {
	createApiKeyField,
	createDropdownField,
	createStatusIcon,
	createTabBar,
	createTextField,
} from "../../components/settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { EMBEDDING_SECTION_ID } from "../section-ids";
import { createEmbeddings } from "../../services/text-embedding";
import { resolveSecret } from "../../utils/secret-helper";

export class EmbeddingSettingsSection implements SettingsSection {
	readonly titleKey = EMBEDDING_SECTION_ID;

	private editingEmbeddingId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const embeddingConfigs = plugin.settings.embeddingConfigs;

		// Tool / sub-agent retriever top-K knobs live in the Tools section
		// since they cap how many tools and sub-agents reach the model on
		// each turn (the retrievers themselves run hybrid BM25 + cosine when
		// an embedding is configured, BM25-only otherwise — but the cap
		// belongs with tool surface tuning, not embedding configuration).
		//
		// Skill-specific embedding knobs (filter threshold / topK /
		// strong-hint floor / auto-inject floor) live in the Skills
		// section so they sit alongside the trigger tester — adjusting
		// a threshold and re-running the tester gives immediate
		// feedback on the new value's effect.

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
					this.ctx.onProfilesChanged?.();
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
					this.ctx.onProfilesChanged?.();
					refreshSection(this);
				},
				deleteTooltip: t('settings.deleteEmbeddingConfigDesc'),
				disableDelete: embeddingConfigs.length <= 1,
			});
			this.ctx.registerCleanup(tabBarResult.dispose);

			// ── Embedding config editor ──
			this.renderEmbeddingEditor(
				container,
				editingEmbedding,
				tabBarResult.refreshTabLabel,
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
				this.ctx.onProfilesChanged?.();
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
			name: t('common.apiKey'),
			desc: t('settings.embeddingApiKeyDesc'),
			value: config.apiKey,
			onChange: async (value) => {
				config.apiKey = value;
				await plugin.saveSettings();
			},
		});

		// Model + Test button + status on the same row
		const modelPlaceholder = config.type === 'gemini' ? 'text-embedding-004' : 'text-embedding-3-small';
		const modelSetting = new Setting(container)
			.setName(t('common.model'))
			.setDesc(t('settings.embeddingModelDesc'))
			.addText(text => text
				.setPlaceholder(modelPlaceholder)
				.setValue(config.model)
				.onChange(async (value) => {
					config.model = value || modelPlaceholder;
					await plugin.saveSettings();
				}))
			.addButton(btn => btn
				.setIcon('play')
				.onClick(async () => {
					const apiKey = resolveSecret(app, config.apiKey);
					if (!apiKey) {
						new Notice(t('status.apiKeyRequired'));
						return;
					}

					statusIcon.el.removeClass('oap-embedding-status--hidden');
					statusIcon.setState('loading', t('status.checking'));

					try {
						const result = await createEmbeddings({
							type: config.type,
							baseURL: config.baseUrl,
							apiKey,
							model: config.model,
						}, ['test']);

						if (result.length > 0 && result[0]!.length > 0) {
							statusIcon.setState('success', t('status.ok'));
						} else {
							statusIcon.setState('error', t('status.errorLabel'));
						}
					} catch (e) {
						console.error('Embedding test failed:', e);
						const msg = e instanceof Error ? e.message : String(e);
						statusIcon.setState('error', `${t('status.errorLabel')}: ${msg}`);
					}
				}));

		const statusIcon = createStatusIcon({
			container: modelSetting.controlEl,
			classPrefix: 'oap-embedding-status',
		});
		statusIcon.el.addClass('oap-embedding-status--hidden');
	}
}
