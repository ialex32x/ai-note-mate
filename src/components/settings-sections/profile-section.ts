import { DropdownComponent, Notice, Setting, setIcon } from "obsidian";
import { t } from "../../i18n";
import { ModelSelectorModal } from "../../modals/model-selector-modal";
import type { LLMProviderType } from "../../services/providers";
import { createLLMProvider } from "../../services/providers";
import {
	ALL_MODALITY_CAPABILITIES,
	type ModalityCapability,
} from "../../services/llm-provider";
import { createDefaultProfile, generateId } from "../../settings/defaults";
import type { ProviderProfile } from "../../settings/types";
import {
	createApiKeyField,
	createDropdownField,
	createTabBar,
	createTextField,
	refreshDropdownOptions,
	scrollActiveTabIntoView,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";

export class ProfileSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.profileSection';

	private editingProfileId: string | null = null;

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection, containerEl } = this.ctx;
		const profiles = plugin.settings.profiles;

		// Determine which profile is being edited
		const editingId = this.getEditingProfileId();
		const editingProfile = profiles.find(p => p.id === editingId) || profiles[0]!;
		if (editingProfile) {
			this.editingProfileId = editingProfile.id;
		}

		// ── Active profile selector ──
		let activeProfileDropdown: DropdownComponent;
		{
			new Setting(container)
				.setName(t('settings.profile'))
				.setDesc(t('settings.profileDesc'))
				.addDropdown((dropdown: DropdownComponent) => {
					activeProfileDropdown = dropdown;
					for (const p of profiles) {
						dropdown.addOption(p.id, getProfileLabel(p));
					}
					dropdown.setValue(plugin.settings.activeProfileId);
					dropdown.onChange(async (value: string) => {
						plugin.settings.activeProfileId = value;
						await plugin.saveSettings();
						refreshSection(this);
						scrollActiveTabIntoView(containerEl, '.oap-profile-tabs__scroll');
					});
				});
		}

		// ── Summarizer profile selector (shares profile list, kept together with active selector) ──
		let summarizerDropdown: DropdownComponent;
		{
			new Setting(container)
				.setName(t('settings.summarizer'))
				.setDesc(t('settings.summarizerDesc'))
				.addDropdown((dropdown: DropdownComponent) => {
					summarizerDropdown = dropdown;
					for (const p of profiles) {
						dropdown.addOption(p.id, getProfileLabel(p));
					}
					const summarizerId = plugin.settings.summarizerProfileId
						&& profiles.some(p => p.id === plugin.settings.summarizerProfileId)
						? plugin.settings.summarizerProfileId
						: plugin.settings.activeProfileId;
					dropdown.setValue(summarizerId);
					dropdown.onChange(async (value: string) => {
						plugin.settings.summarizerProfileId = value;
						await plugin.saveSettings();
					});
				});
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
				refreshSection(this);
			},
			addTooltip: t('settings.addProfile'),
			onDuplicate: async () => {
				const newProfile: ProviderProfile = {
					...editingProfile,
					id: generateId(),
					name: `${editingProfile.name} (copy)`,
					// Deep-copy array fields so subsequent edits don't mutate the source profile
					modalities: [...(editingProfile.modalities ?? [])],
				};
				profiles.push(newProfile);
				this.editingProfileId = newProfile.id;
				await plugin.saveSettings();
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
				this.editingProfileId = profiles[0]!.id;
				await plugin.saveSettings();
				refreshSection(this);
			},
			deleteTooltip: t('settings.deleteProfileDesc'),
			disableDelete: profiles.length <= 1,
		});

		// Helper: refresh both profile-list dropdowns in-place (active + summarizer)
		const refreshProfileDropdowns = () => {
			if (activeProfileDropdown) {
				refreshDropdownOptions(activeProfileDropdown, profiles, getProfileLabel);
			}
			if (summarizerDropdown) {
				refreshDropdownOptions(summarizerDropdown, profiles, getProfileLabel);
			}
		};

		// ── Profile editor fields ──
		this.renderProfileEditor(
			container,
			editingProfile,
			tabBarResult.refreshTabLabel,
			refreshProfileDropdowns,
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
		profile: ProviderProfile,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
		refreshDropdown: () => void,
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
				refreshDropdown();
			},
		});

		// ── Provider-specific fields ──
		if (profile.provider === 'openai') {
			this.renderOpenAIProfileFields(container, profile, refreshTabLabel, refreshDropdown);
		} else if (profile.provider === 'gemini') {
			this.renderGeminiProfileFields(container, profile, refreshTabLabel, refreshDropdown);
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
			input.addEventListener('change', async () => {
				const set = new Set(profile.modalities ?? []);
				if (input.checked) set.add(cap); else set.delete(cap);
				// Preserve canonical ordering for stable diffs in data.json
				profile.modalities = ALL_MODALITY_CAPABILITIES.filter(c => set.has(c));
				await plugin.saveSettings();
			});
		}

		// Max tokens
		createTextField({
			container,
			name: t('settings.maxTokens'),
			desc: t('settings.maxTokensDesc'),
			placeholder: '0',
			value: String(profile.maxTokens),
			onChange: async (value) => {
				const num = parseInt(value, 10);
				profile.maxTokens = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
		});

		// ── Context compression (per-profile tuning) ──
		// Section divider — same DOM shape as the modalities title above
		// (a Setting row with name+desc only, no control), so the editor
		// keeps a consistent rhythm.
		new Setting(container)
			.setName(t('settings.contextCompression'))
			.setHeading();

		// Compression threshold (0 = use plugin default)
		createTextField({
			container,
			name: t('settings.contextCompressionThreshold'),
			desc: t('settings.contextCompressionThresholdDesc'),
			placeholder: '0',
			value: String(profile.contextCompressionThreshold),
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
			onChange: async (value) => {
				const num = parseInt(value, 10);
				profile.maxSummariesThreshold = isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
		});
	}

	private renderOpenAIProfileFields(
		container: HTMLElement,
		profile: ProviderProfile,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
		refreshDropdown: () => void,
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
		this.renderModelField(container, profile, refreshTabLabel, refreshDropdown);

		// API Key
		createApiKeyField({
			container,
			app,
			name: t('settings.apiKey'),
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
		profile: ProviderProfile,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
		refreshDropdown: () => void,
	): void {
		const { app, plugin } = this.ctx;

		// API Key
		createApiKeyField({
			container,
			app,
			name: t('settings.apiKey'),
			desc: t('settings.geminiApiKeyDesc'),
			value: profile.apiKey,
			onChange: async (value) => {
				profile.apiKey = value;
				await plugin.saveSettings();
			},
		});

		// Model (with refresh and select from list)
		this.renderModelField(container, profile, refreshTabLabel, refreshDropdown, 'gemini-2.5-flash');
	}

	/**
	 * Render the model field with a refresh button that directly shows model selection.
	 * - Refresh: calls the provider's listModels API and shows a popup for selection
	 * - Selected model is directly written to profile.model field
	 */
	private renderModelField(
		container: HTMLElement,
		profile: ProviderProfile,
		refreshTabLabel: (id: string, name: string, tooltip?: string) => void,
		refreshDropdown: () => void,
		modelPlaceholder?: string,
	): void {
		const { plugin } = this.ctx;

		const setting = new Setting(container)
			.setName(t('settings.model'))
			.setDesc(t('settings.modelDesc'))
			.addText(text => {
				if (modelPlaceholder) {
					text.setPlaceholder(modelPlaceholder);
				}
				text.setValue(profile.model);
				text.onChange(async (value) => {
					profile.model = value;
					await plugin.saveSettings();
					refreshTabLabel(profile.id, profile.name, getProfileLabel(profile));
					refreshDropdown();
				});
			})
			.addButton(btn => btn
				.setIcon('refresh-cw')
				.setTooltip(t('settings.refreshModels'))
				.onClick(async () => {
					await this.refreshAndSelectModel(btn.buttonEl, profile, setting);
				}));
	}

	/** Create a temporary LLMProvider instance from a profile for listing models */
	private createProviderFromProfile(profile: ProviderProfile) {
		const { app } = this.ctx;
		return createLLMProvider(profile.provider, {
			apiKey: app.secretStorage.getSecret(profile.apiKey) ?? profile.apiKey,
			baseURL: profile.provider === 'openai' ? profile.baseUrl : undefined,
			model: profile.model,
		});
	}

	/** Refresh the list of available models and show selection popup */
	private async refreshAndSelectModel(
		btnEl: HTMLButtonElement,
		profile: ProviderProfile,
		setting: Setting,
	): Promise<void> {
		if (!profile.apiKey) {
			new Notice(t('settings.apiKeyRequired'));
			return;
		}

		setIcon(btnEl, 'loader-2');
		btnEl.classList.add('oap-spin');
		btnEl.disabled = true;

		try {
			const provider = this.createProviderFromProfile(profile);
			const models = await provider.listModels();

			if (models.length === 0) {
				new Notice(t('settings.noModelsAvailable'));
				return;
			}

			// Show model selection modal
			await this.showModelSuggester(btnEl, profile, setting, models);
		} catch (e) {
			console.error('Failed to list models:', e);
			new Notice(t('settings.refreshModelsFailed'));
		} finally {
			btnEl.classList.remove('oap-spin');
			setIcon(btnEl, 'refresh-cw');
			btnEl.disabled = false;
		}
	}

	/** Show a modal to select a model from the provided list */
	private async showModelSuggester(
		_btnEl: HTMLButtonElement,
		profile: ProviderProfile,
		setting: Setting,
		models: string[],
	): Promise<void> {
		const { app, plugin } = this.ctx;

		if (models.length === 0) {
			console.warn('no suggested model for', profile.name);
			return;
		}

		const selected = await new ModelSelectorModal(app, models, profile.model).waitForResult();
		if (selected) {
			profile.model = selected;
			await plugin.saveSettings();
			// Update the text input value
			const textInput = setting.controlEl.querySelector('input[type="text"]') as HTMLInputElement;
			if (textInput) {
				textInput.value = selected;
			}
		}
	}
}

/** Build a display label for a profile (name + provider/model). */
function getProfileLabel(p: ProviderProfile): string {
	return `${p.name} (${p.provider === 'gemini' ? 'Gemini' : p.model})`;
}
