import { t } from "../../i18n";
import { createDefaultSpeechToTextConfig } from "../defaults";
import { DefaultDashScopeShortModel, DefaultDashScopeLongModel } from "../types";
import type { DashScopeRegion, SpeechToTextApiScheme, SpeechToTextConfig } from "../types";
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
				'DashScope': 'DashScope',
			},
			value: config.apiScheme,
			onChange: async (value) => {
				config.apiScheme = value as SpeechToTextApiScheme;
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// Scheme-specific fields
		switch (config.apiScheme) {
			case 'DashScope':
				this.renderDashScopeFields(container, config, app, plugin, refreshSection);
				break;
		}
	}

	private renderDashScopeFields(
		container: HTMLElement,
		config: SpeechToTextConfig,
		app: SectionContext['app'],
		plugin: SectionContext['plugin'],
		refreshSection: SectionContext['refreshSection'],
	): void {
		// Region selector
		createDropdownField({
			container,
			name: t('settings.sttRegion'),
			desc: t('settings.sttRegionDesc'),
			options: {
				'cn-beijing': t('settings.sttRegionCnBeijing'),
				'us-east-1': t('settings.sttRegionUsEast1'),
				'ap-southeast-1': t('settings.sttRegionApSoutheast1'),
				'eu-central-1': t('settings.sttRegionEuCentral1'),
			},
			value: config.region,
			onChange: async (value) => {
				config.region = value as DashScopeRegion;
				// Clear workspaceId when switching to regions that don't need it
				if (value === 'cn-beijing' || value === 'us-east-1') {
					config.workspaceId = '';
				}
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// Workspace ID (only for Singapore and Frankfurt)
		if (config.region === 'ap-southeast-1' || config.region === 'eu-central-1') {
			createTextField({
				container,
				name: t('settings.sttWorkspaceId'),
				desc: t('settings.sttWorkspaceIdDesc'),
				placeholder: '',
				value: config.workspaceId || '',
				onChange: async (value) => {
					config.workspaceId = value;
					await plugin.saveSettings();
				},
			});
		}

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

		// Short audio model
		createTextField({
			container,
			name: t('settings.sttShortModel'),
			desc: t('settings.sttShortModelDesc'),
			placeholder: DefaultDashScopeShortModel,
			value: config.shortModel,
			onChange: async (value) => {
				config.shortModel = value || DefaultDashScopeShortModel;
				await plugin.saveSettings();
			},
		});

		// Long audio model
		createTextField({
			container,
			name: t('settings.sttLongModel'),
			desc: t('settings.sttLongModelDesc'),
			placeholder: DefaultDashScopeLongModel,
			value: config.longModel,
			onChange: async (value) => {
				config.longModel = value || DefaultDashScopeLongModel;
				await plugin.saveSettings();
			},
		});
	}
}