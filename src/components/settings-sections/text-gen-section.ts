import { Setting } from "obsidian";
import { t } from "../../i18n";
import type { LLMProviderType } from "../../services/providers";
import { createLLMProvider } from "../../services/providers";
import {
	ALL_MODALITY_CAPABILITIES,
	ALL_THINKING_LEVELS,
	type ModalityCapability,
	type ThinkingLevel,
} from "../../services/llm-provider";
import { createDefaultProfile, generateId } from "../../settings/defaults";
import type { TextGenConfig } from "../../settings/types";
import {
	createSettingsGroupHeading,
	createApiKeyField,
	createDropdownField,
	createModelFieldWithSelector,
	createTabBar,
	createTextField,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { getProfileLabel } from "./global-section";
import { resolveSecret } from "../../utils/secret-helper";
import { TEXT_GEN_SECTION_ID } from "../../settings/section-ids";

export class TextGenSettingsSection implements SettingsSection {
	readonly titleKey = TEXT_GEN_SECTION_ID;

	private editingProfileId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const profiles = plugin.settings.profiles;

		// Determine which profile is being edited
		const editingId = this.getEditingProfileId();
		const editingProfile = profiles.find(p => p.id === editingId) || profiles[0]!;
		if (editingProfile) {
			this.editingProfileId = editingProfile.id;
		}

		// ── Tab bar ──
		const tabBarResult = createTabBar({
			container,
			items: profiles.map(p => ({
				id: p.id,
				name: p.name,
				tooltip: getProfileLabel(p),
			})),
			activeId: plugin.settings.activeProfileId,
			editingId: editingProfile.id,
			onTabClick: (id) => {
				this.editingProfileId = id;
				refreshSection(this);
			},
			activeDotTooltip: t('settings.profile'),
			onAdd: async () => {
				const newProfile = createDefaultProfile();
				newProfile.name = `Profile ${profiles.length + 1}`;
				profiles.push(newProfile);
				this.editingProfileId = newProfile.id;
				await plugin.saveSettings();
				this.ctx.onProfilesChanged?.();
				refreshSection(this);
			},
			addTooltip: t('settings.addProfile'),
			onDuplicate: async () => {
				const newProfile: TextGenConfig = {
					...editingProfile,
					id: generateId(),
					name: `${editingProfile.name} (copy)`,
					// Deep-copy array fields so subsequent edits don't mutate the source profile
					modalities: [...(editingProfile.modalities ?? [])],
				};
				profiles.push(newProfile);
				this.editingProfileId = newProfile.id;
				await plugin.saveSettings();
				this.ctx.onProfilesChanged?.();
				refreshSection(this);
			},
			duplicateTooltip: t('settings.duplicateProfile'),
			onDelete: async () => {
				if (profiles.length <= 1) return;
				const idx = profiles.findIndex(p => p.id === editingProfile.id);
				profiles.splice(idx, 1);
				if (plugin.settings.activeProfileId === editingProfile.id) {
					plugin.settings.activeProfileId = profiles[0]!.id;
				}
				if (plugin.settings.summarizerProfileId === editingProfile.id) {
					plugin.settings.summarizerProfileId = profiles[0]!.id;
				}
				if (plugin.settings.insightsProfileId === editingProfile.id) {
					plugin.settings.insightsProfileId = '';
				}
				this.editingProfileId = profiles[0]!.id;
				await plugin.saveSettings();
				this.ctx.onProfilesChanged?.();
				refreshSection(this);
			},
			deleteTooltip: t('settings.deleteProfileDesc'),
			disableDelete: profiles.length <= 1,
		});

		// ── Profile editor fields ──
		this.renderProfileEditor(
			container,
			editingProfile,
			tabBarResult.refreshTabLabel,
		);
	}

	/** Get the ID of the profile currently being edited in the settings tab */
	private getEditingProfileId(): string {
		const { plugin } = this.ctx;
		if (this.editingProfileId) {
			const exists = plugin.settings.profiles.some(p => p.id === this.editingProfileId);
			if (exists) return this.editingProfileId;
		}
		return plugin.settings.activeProfileId
			|| plugin.settings.profiles[0]?.id
			|| '';
	}

	private renderProfileEditor(
		container: HTMLElement,
		profile: TextGenConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { plugin, refreshSection } = this.ctx;

		// Provider type
		createDropdownField({
			container,
			name: t('settings.provider'),
			desc: t('settings.providerDesc'),
			options: {
				'openai': 'OpenAI Compatible',
				'gemini': 'Google Gemini',
			},
			value: profile.provider,
			onChange: async (value) => {
				profile.provider = value as LLMProviderType;
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// Profile name
		createTextField({
			container,
			name: t('settings.profileName'),
			desc: t('settings.profileNameDesc'),
			value: profile.name,
			onChange: async (value) => {
				profile.name = value || 'Unnamed';
				await plugin.saveSettings();
				refreshTabLabel(profile.id, profile.name, getProfileLabel(profile));
				this.ctx.onProfilesChanged?.();
			},
		});

		// ── Provider-specific fields ──
		if (profile.provider === 'openai') {
			this.renderOpenAIProfileFields(container, profile, refreshTabLabel);
		} else if (profile.provider === 'gemini') {
			this.renderGeminiProfileFields(container, profile, refreshTabLabel);
		}

		// Modality capabilities (image / audio / video / pdf)
		// Rendered as a single horizontal row of label-only checkboxes that
		// mirrors the global "allowed capabilities" row exactly — same visual
		// rhythm, same DOM shape, same CSS classes (`oap-capabilities-row` /
		// `oap-capability-item` / `oap-capability-label`). Reusing the class
		// set avoids duplicating ~40 lines of LESS for what is effectively the
		// same control. The shared description sits on the title Setting row
		// above; per-modality tooltips are intentionally omitted because the
		// labels ("Image input" / "PDF input" / ...) are already self-evident.
		new Setting(container)
			.setName(t('settings.modalities'))
			.setDesc(t('settings.modalitiesDesc'));

		const modalityLabels: Record<ModalityCapability, string> = {
			image: t('settings.modalityImage'),
			audio: t('settings.modalityAudio'),
			video: t('settings.modalityVideo'),
			pdf: t('settings.modalityPdf'),
		};

		const modalityRow = container.createDiv({ cls: 'oap-capabilities-row' });
		for (const cap of ALL_MODALITY_CAPABILITIES) {
			const label = modalityRow.createEl('label', { cls: 'oap-capability-item' });
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = profile.modalities?.includes(cap) ?? false;
			label.createSpan({ cls: 'oap-capability-label', text: modalityLabels[cap] });
			input.addEventListener('change', () => {
				const set = new Set(profile.modalities ?? []);
				if (input.checked) set.add(cap); else set.delete(cap);
				// Preserve canonical ordering for stable diffs in data.json
				profile.modalities = ALL_MODALITY_CAPABILITIES.filter(c => set.has(c));
				void plugin.saveSettings();
			});
		}

		// Max tokens
		createTextField({
			container,
			name: t('settings.maxTokens'),
			desc: t('settings.maxTokensDesc'),
			placeholder: '0',
			value: String(profile.maxTokens),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				profile.maxTokens = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
		});

		// Thinking / reasoning effort.
		//
		// Provider-agnostic: each provider translates the chosen tier to its
		// native API (OpenAI `reasoning_effort`, Gemini `thinkingBudget`, …).
		// See ThinkingLevel in services/llm-provider.ts for the mapping.
		const thinkingLabels: Record<ThinkingLevel, string> = {
			auto: t('settings.thinkingLevelAuto'),
			off: t('settings.thinkingLevelOff'),
			low: t('settings.thinkingLevelLow'),
			medium: t('settings.thinkingLevelMedium'),
			high: t('settings.thinkingLevelHigh'),
		};
		const thinkingOptions: Record<string, string> = {};
		for (const lvl of ALL_THINKING_LEVELS) {
			thinkingOptions[lvl] = thinkingLabels[lvl];
		}
		createDropdownField({
			container,
			name: t('settings.thinkingLevel'),
			desc: t('settings.thinkingLevelDesc'),
			options: thinkingOptions,
			value: profile.thinkingLevel ?? 'auto',
			onChange: async (value) => {
				profile.thinkingLevel = value as ThinkingLevel;
				await plugin.saveSettings();
			},
		});

		// ── Context compression (per-profile tuning) ──
		// Section divider — same DOM shape as the modalities title above
		// (a Setting row with name+desc only, no control), so the editor
		// keeps a consistent rhythm.
		createSettingsGroupHeading(container, {
			name: t('settings.contextCompression'),
			advancedOnly: true,
		});

		// Compression threshold (0 = use plugin default)
		createTextField({
			container,
			name: t('settings.contextCompressionThreshold'),
			desc: t('settings.contextCompressionThresholdDesc'),
			placeholder: '0',
			value: String(profile.contextCompressionThreshold),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				profile.contextCompressionThreshold = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
		});

		// Sliding window size (0 = use plugin default)
		createTextField({
			container,
			name: t('settings.slidingWindowSize'),
			desc: t('settings.slidingWindowSizeDesc'),
			placeholder: '0',
			value: String(profile.slidingWindowSize),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				profile.slidingWindowSize = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
		});

		// Max summaries threshold (0 = use plugin default)
		createTextField({
			container,
			name: t('settings.maxSummariesThreshold'),
			desc: t('settings.maxSummariesThresholdDesc'),
			placeholder: '0',
			value: String(profile.maxSummariesThreshold),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				profile.maxSummariesThreshold = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
		});
	}

	private renderOpenAIProfileFields(
		container: HTMLElement,
		profile: TextGenConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin } = this.ctx;

		// Base URL
		createTextField({
			container,
			name: t('settings.baseUrl'),
			desc: t('settings.baseUrlDesc'),
			placeholder: t('settings.baseUrlPlaceholder'),
			value: profile.baseUrl,
			onChange: async (value) => {
				profile.baseUrl = value;
				await plugin.saveSettings();
			},
		});

		// Model (with refresh and select from list)
		this.renderModelField(container, profile, refreshTabLabel);

		// API Key
		createApiKeyField({
			container,
			app,
			name: t('common.apiKey'),
			desc: t('settings.apiKeyDesc'),
			value: profile.apiKey,
			onChange: async (value) => {
				profile.apiKey = value;
				await plugin.saveSettings();
			},
		});
	}

	private renderGeminiProfileFields(
		container: HTMLElement,
		profile: TextGenConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
	): void {
		const { app, plugin } = this.ctx;

		// API Key
		createApiKeyField({
			container,
			app,
			name: t('common.apiKey'),
			desc: t('settings.geminiApiKeyDesc'),
			value: profile.apiKey,
			onChange: async (value) => {
				profile.apiKey = value;
				await plugin.saveSettings();
			},
		});

		// Model (with refresh and select from list)
		this.renderModelField(container, profile, refreshTabLabel, 'gemini-2.5-flash');
	}

	/**
	 * Render the model field with a refresh-and-pick button. Delegates to
	 * the shared {@link createModelFieldWithSelector} so the Profile and
	 * Image Generation sections stay in sync.
	 */
	private renderModelField(
		container: HTMLElement,
		profile: TextGenConfig,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
		modelPlaceholder?: string,
	): void {
		const { app, plugin } = this.ctx;

		createModelFieldWithSelector({
			container,
			app,
			desc: t('settings.modelDesc'),
			placeholder: modelPlaceholder,
			value: profile.model,
			getApiKey: () => profile.apiKey,
			listModels: () => createLLMProvider(profile.provider, {
				apiKey: resolveSecret(app, profile.apiKey),
				baseURL: profile.provider === 'openai' ? profile.baseUrl : undefined,
				model: profile.model,
			}).listModels(),
			onChange: async (value) => {
				profile.model = value;
				await plugin.saveSettings();
				refreshTabLabel(profile.id, profile.name, getProfileLabel(profile));
				this.ctx.onProfilesChanged?.();
			},
		});
	}
}
