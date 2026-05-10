import { DropdownComponent, Setting } from "obsidian";
import { t } from "../../i18n";
import { createDefaultImageGenConfig } from "../../settings/defaults";
import { DefaultGeminiImageModel } from "../../settings/types";
import type { ImageGenApiScheme, ImageGenConfig } from "../../settings/types";
import {
	createApiKeyField,
	createDropdownField,
	createTabBar,
	createTextField,
	refreshDropdownOptions,
	scrollActiveTabIntoView,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";

export class ImageGenSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.imageGenSection';

	private editingImageGenId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection, containerEl } = this.ctx;
		const imageGenConfigs = plugin.settings.imageGenConfigs;

		// ── Active image gen selector ──
		let activeImageGenDropdown: DropdownComponent;
		new Setting(container)
			.setName(t('settings.imageGenConfig'))
			.setDesc(t('settings.imageGenConfigDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
				activeImageGenDropdown = dropdown;
				for (const c of imageGenConfigs) {
					dropdown.addOption(c.id, c.name || 'Unnamed');
				}
				dropdown.setValue(plugin.settings.activeImageGenId);
				dropdown.onChange(async (value: string) => {
					plugin.settings.activeImageGenId = value;
					await plugin.saveSettings();
					refreshSection(this);
					scrollActiveTabIntoView(containerEl, '.oap-image-tabs .oap-profile-tabs__scroll');
				});
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
					refreshSection(this);
				},
				deleteTooltip: t('settings.deleteImageGenConfigDesc'),
				disableDelete: imageGenConfigs.length <= 1,
			});

			// Helper: refresh active image gen dropdown
			const refreshActiveImageGenDropdown = () => {
				if (!activeImageGenDropdown) return;
				refreshDropdownOptions(activeImageGenDropdown, imageGenConfigs);
			};

			// ── Image Gen config editor ──
			this.renderImageGenEditor(
				container,
				editingImageGen,
				tabBarResult.refreshTabLabel,
				refreshActiveImageGenDropdown,
			);
		}
	}

	/** Get the ID of the image gen config currently being edited in the settings tab */
	private getEditingImageGenId(): string {
		const { plugin } = this.ctx;
		if (this.editingImageGenId) {
			const exists = plugin.settings.imageGenConfigs.some(c => c.id === this.editingImageGenId);
			if (exists) return this.editingImageGenId!;
		}
		return plugin.settings.activeImageGenId
			|| plugin.settings.imageGenConfigs[0]?.id
			|| '';
	}

	private renderImageGenEditor(
		container: HTMLElement,
		config: ImageGenConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
		refreshDropdown: () => void,
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
				refreshDropdown();
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
			name: t('settings.imageGenApiKey'),
			desc: t('settings.imageGenApiKeyDesc'),
			value: config.apiKey,
			onChange: async (value) => {
				config.apiKey = value;
				await plugin.saveSettings();
			},
		});

		// Model
		const modelPlaceholder = getImageGenModelPlaceholder(config.apiScheme);
		createTextField({
			container,
			name: t('settings.imageGenModel'),
			desc: t('settings.imageGenModelDesc'),
			placeholder: modelPlaceholder,
			value: config.model,
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
		case 'gemini':
		default:
			return DefaultGeminiImageModel;
	}
}
