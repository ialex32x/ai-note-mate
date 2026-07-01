import { t } from "../../i18n";
import { listImageGenModels } from "../../services/image-gen";
import { createDefaultImageGenConfig } from "../defaults";
import { DefaultGeminiImageModel } from "../types";
import type { ImageGenApiScheme, ImageGenConfig } from "../types";
import {
	createApiKeyField,
	createDropdownField,
	createModelFieldWithSelector,
	createSliderField,
	createTabBar,
	createTextField,
} from "../../components/settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { IMAGE_GEN_SECTION_ID } from "../section-ids";
import { getDefaultSeedreamModel } from "../../services/image-gen/list-models";

export class ImageGenSettingsSection implements SettingsSection {
	readonly titleKey = IMAGE_GEN_SECTION_ID;

	private editingImageGenId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const imageGenConfigs = plugin.settings.imageGenConfigs;

		// ── Global image quality slider ──
		createSliderField({
			container,
			name: t('settings.imageQuality'),
			desc: t('settings.imageQualityDesc'),
			value: plugin.settings.imageQuality,
			min: 10,
			max: 100,
			step: 5,
			onChange: async (value) => {
				plugin.settings.imageQuality = value;
				await plugin.saveSettings();
			},
		});

		// ── Image Gen tab bar ──
		if (imageGenConfigs.length > 0) {
			const editingId = this.getEditingImageGenId();
			const editingImageGen = imageGenConfigs.find(c => c.id === editingId) || imageGenConfigs[0]!;
			if (editingImageGen) {
				this.editingImageGenId = editingImageGen.id;
			}

			const tabBarResult = createTabBar({
				container,
				items: imageGenConfigs.map(c => ({
					id: c.id,
					name: c.name,
					tooltip: c.name || 'Unnamed',
				})),
				activeId: plugin.settings.activeImageGenId,
				editingId: editingImageGen.id,
				onTabClick: (id) => {
					this.editingImageGenId = id;
					refreshSection(this);
				},
				activeDotTooltip: t('settings.imageGenConfig'),
				extraClass: 'oap-image-tabs',
				onAdd: async () => {
					const newConfig = createDefaultImageGenConfig();
					newConfig.name = `Image Gen ${imageGenConfigs.length + 1}`;
					imageGenConfigs.push(newConfig);
					plugin.settings.activeImageGenId = newConfig.id;
					this.editingImageGenId = newConfig.id;
					await plugin.saveSettings();
					this.ctx.onProfilesChanged?.();
					refreshSection(this);
				},
				addTooltip: t('settings.addImageGenConfig'),
				onDelete: async () => {
					if (imageGenConfigs.length <= 1) return;
					const idx = imageGenConfigs.findIndex(c => c.id === editingImageGen.id);
					imageGenConfigs.splice(idx, 1);
					if (plugin.settings.activeImageGenId === editingImageGen.id) {
						plugin.settings.activeImageGenId = imageGenConfigs[0]!.id;
					}
					this.editingImageGenId = imageGenConfigs[0]!.id;
					await plugin.saveSettings();
					this.ctx.onProfilesChanged?.();
					refreshSection(this);
				},
				deleteTooltip: t('settings.deleteImageGenConfigDesc'),
				disableDelete: imageGenConfigs.length <= 1,
			});

			// ── Image Gen config editor ──
			this.renderImageGenEditor(
				container,
				editingImageGen,
				tabBarResult.refreshTabLabel,
			);
		}
	}

	/** Get the ID of the image gen config currently being edited in the settings tab */
	private getEditingImageGenId(): string {
		const { plugin } = this.ctx;
		if (this.editingImageGenId) {
			const exists = plugin.settings.imageGenConfigs.some(c => c.id === this.editingImageGenId);
			if (exists) return this.editingImageGenId;
		}
		return plugin.settings.activeImageGenId
			|| plugin.settings.imageGenConfigs[0]?.id
			|| '';
	}

	private renderImageGenEditor(
		container: HTMLElement,
		config: ImageGenConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin, refreshSection } = this.ctx;

		// Config name
		createTextField({
			container,
			name: t('settings.imageGenName'),
			placeholder: t('settings.imageGenNamePlaceholder'),
			value: config.name,
			onChange: async (value) => {
				config.name = value || 'Unnamed';
				await plugin.saveSettings();
				refreshTabLabel(config.id, config.name, config.name);
				this.ctx.onProfilesChanged?.();
			},
		});

		// API scheme selector
		createDropdownField({
			container,
			name: t('settings.apiScheme'),
			desc: t('settings.apiSchemeDesc'),
			options: {
				'gemini': 'Google Gemini',
				'qwen': 'Qwen Image',
				'openai': 'OpenAI Compatible',
				'seedream': 'Seedream (Ark)',
			},
			value: config.apiScheme,
			onChange: async (value) => {
				config.apiScheme = value as ImageGenApiScheme;
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// Base URL (OpenAI only)
		if (config.apiScheme === 'openai') {
			createTextField({
				container,
				name: t('settings.baseUrl'),
				desc: t('settings.imageGenBaseUrlDesc'),
				placeholder: 'https://api.openai.com/v1',
				value: config.baseUrl || '',
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
			desc: t('settings.imageGenApiKeyDesc'),
			value: config.apiKey,
			onChange: async (value) => {
				config.apiKey = value;
				await plugin.saveSettings();
			},
		});

		// Model — text input + refresh-and-pick button. Reuses the shared
		// helper used by the Profile section so the two surfaces behave
		// identically (loading state, error notice, picker modal).
		const modelPlaceholder = getImageGenModelPlaceholder(config.apiScheme);
		createModelFieldWithSelector({
			container,
			app,
			desc: t('settings.imageGenModelDesc'),
			placeholder: modelPlaceholder,
			value: config.model,
			getApiKey: () => config.apiKey,
			listModels: () => listImageGenModels(app, config),
			onChange: async (value) => {
				config.model = value || modelPlaceholder;
				await plugin.saveSettings();
			},
		});
	}
}

function getImageGenModelPlaceholder(scheme: ImageGenApiScheme): string {
	switch (scheme) {
		case 'qwen':
			return 'qwen-image';
		case 'openai':
			return 'dall-e-3';
		case 'seedream':
			return getDefaultSeedreamModel();
		case 'gemini':
		default:
			return DefaultGeminiImageModel;
	}
}
