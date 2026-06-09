import { t } from "../../i18n";
import { createDefaultSpeechToTextConfig } from "../defaults";
import { DefaultQwenASRModel } from "../types";
import type { SpeechToTextApiScheme, SpeechToTextConfig } from "../types";
import {
	createApiKeyField,
	createDropdownField,
	createTabBar,
	createTextField,
} from "../../components/settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { SPEECH_TO_TEXT_SECTION_ID } from "../section-ids";

export class SpeechToTextSettingsSection implements SettingsSection {
	readonly titleKey = SPEECH_TO_TEXT_SECTION_ID;

	private editingSttId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const sttConfigs = plugin.settings.speechToTextConfigs;

		if (sttConfigs.length > 0) {
			const editingId = this.getEditingSttId();
			const editingStt = sttConfigs.find(c => c.id === editingId) || sttConfigs[0]!;
			if (editingStt) {
				this.editingSttId = editingStt.id;
			}

			const tabBarResult = createTabBar({
				container,
				items: sttConfigs.map(c => ({
					id: c.id,
					name: c.name,
					tooltip: c.name || 'Unnamed',
				})),
				activeId: plugin.settings.activeSpeechToTextId,
				editingId: editingStt.id,
				onTabClick: (id) => {
					this.editingSttId = id;
					refreshSection(this);
				},
				activeDotTooltip: t('settings.speechToTextConfig'),
				extraClass: 'oap-stt-tabs',
				onAdd: async () => {
					const newConfig = createDefaultSpeechToTextConfig();
					newConfig.name = `STT ${sttConfigs.length + 1}`;
					sttConfigs.push(newConfig);
					plugin.settings.activeSpeechToTextId = newConfig.id;
					this.editingSttId = newConfig.id;
					await plugin.saveSettings();
					this.ctx.onProfilesChanged?.();
					refreshSection(this);
				},
				addTooltip: t('settings.addSpeechToTextConfig'),
				onDelete: async () => {
					if (sttConfigs.length <= 1) return;
					const idx = sttConfigs.findIndex(c => c.id === editingStt.id);
					sttConfigs.splice(idx, 1);
					if (plugin.settings.activeSpeechToTextId === editingStt.id) {
						plugin.settings.activeSpeechToTextId = sttConfigs[0]!.id;
					}
					this.editingSttId = sttConfigs[0]!.id;
					await plugin.saveSettings();
					this.ctx.onProfilesChanged?.();
					refreshSection(this);
				},
				deleteTooltip: t('settings.deleteSpeechToTextConfigDesc'),
				disableDelete: sttConfigs.length <= 1,
			});

			this.renderSttEditor(
				container,
				editingStt,
				tabBarResult.refreshTabLabel,
			);
		}
	}

	private getEditingSttId(): string {
		const { plugin } = this.ctx;
		if (this.editingSttId) {
			const exists = plugin.settings.speechToTextConfigs.some(c => c.id === this.editingSttId);
			if (exists) return this.editingSttId;
		}
		return plugin.settings.activeSpeechToTextId
			|| plugin.settings.speechToTextConfigs[0]?.id
			|| '';
	}

	private renderSttEditor(
		container: HTMLElement,
		config: SpeechToTextConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin, refreshSection } = this.ctx;

		// Config name
		createTextField({
			container,
			name: t('settings.sttConfigName'),
			placeholder: t('settings.sttConfigNamePlaceholder'),
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
				'qwen-asr': 'Qwen ASR (DashScope)',
			},
			value: config.apiScheme,
			onChange: async (value) => {
				config.apiScheme = value as SpeechToTextApiScheme;
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// Base URL
		createTextField({
			container,
			name: t('settings.baseUrl'),
			desc: t('settings.sttBaseUrlDesc'),
			placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
			value: config.baseUrl || '',
			onChange: async (value) => {
				config.baseUrl = value;
				await plugin.saveSettings();
			},
		});

		// API Key
		createApiKeyField({
			container,
			app,
			name: t('common.apiKey'),
			desc: t('settings.sttApiKeyDesc'),
			value: config.apiKey,
			onChange: async (value) => {
				config.apiKey = value;
				await plugin.saveSettings();
			},
		});

		// Model
		const modelPlaceholder = getSttModelPlaceholder(config.apiScheme);
		createTextField({
			container,
			name: t('common.model'),
			desc: t('settings.sttModelDesc'),
			placeholder: modelPlaceholder,
			value: config.model,
			onChange: async (value) => {
				config.model = value || modelPlaceholder;
				await plugin.saveSettings();
			},
		});
	}
}

function getSttModelPlaceholder(scheme: SpeechToTextApiScheme): string {
	switch (scheme) {
		case 'qwen-asr':
		default:
			return DefaultQwenASRModel;
	}
}
