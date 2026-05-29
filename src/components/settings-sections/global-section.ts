import { DropdownComponent, Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import type { TextGenConfig } from "../../settings/types";
import { SystemPromptModal } from "../../modals/system-prompt-modal";
import { TemplatePreviewModal } from "../../modals/template-preview-modal";
import {
	createSettingsGroupHeading,
	createTextField,
	createToggleField,
	isAdvancedSettingsVisible,
	markSettingAdvanced,
	markSettingExperimental,
	markSettingRequiresSessionRestart,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { openPluginSettings } from "../../utils/open-plugin-settings";
import { TEXT_GEN_SECTION_ID, EMBEDDING_SECTION_ID, IMAGE_GEN_SECTION_ID } from "../../settings/section-ids";

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

		// ── Active config selectors ─────────────────────────────────
		// These selectors determine which profile/config is actively used
		// across the plugin. They are placed in General so users can see
		// the key active choices at a glance without scrolling.
		this.renderActiveProfileSelector(container);
		this.renderSummarizerSelector(container);
		this.renderInsightsProfileSelector(container);
		this.renderActiveEmbeddingSelector(container);
		this.renderActiveImageGenSelector(container);
		this.renderActiveUploadSelector(container);

		// Reset usage tips (action-only row, not a real config value).
		// Clearing `knownTipIds` makes every previously-dismissed/run tip
		// eligible again in the input toolbar popover. The button itself
		// is disabled when the list is already empty so the row keeps
		// the "what does it do" affordance even before any tip is run.
		this.renderResetTipsRow(container);

		// ── Custom menu path ─────────────────────────────────────
		this.renderCustomMenuPathField(container);

		// ── Save-as-note directory ───────────────────────────────
		this.renderSaveAsNoteDirField(container);

		// ── Follow-up & insight extraction ───────────────────────
		// Placed at the end of General because these toggles tune
		// post-reply behaviour (insight cards / next-step chips) and
		// are not tied to any specific LLM profile.
		this.renderFollowUpGroup(container);
	}

	private renderFollowUpGroup(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createSettingsGroupHeading(container, {
			name: t('settings.followUpSection'),
		});

		createToggleField({
			container,
			name: t('settings.insightExtraction'),
			desc: t('settings.insightExtractionDesc'),
			value: plugin.settings.insightExtractionEnabled,
			onChange: async (value) => {
				plugin.settings.insightExtractionEnabled = value;
				await plugin.saveSettings();
			},
		});

		createTextField({
			container,
			name: t('settings.insightExtractionMinReplyChars'),
			desc: t('settings.insightExtractionMinReplyCharsDesc'),
			placeholder: '400',
			value: String(plugin.settings.insightExtractionMinReplyChars),
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.insightExtractionMinReplyChars =
					isNaN(num) || num < 0 ? 0 : num;
				await plugin.saveSettings();
			},
		});

		createToggleField({
			container,
			name: t('settings.followUpSuggestions'),
			desc: t('settings.followUpSuggestionsDesc'),
			value: plugin.settings.followUpSuggestionsEnabled,
			onChange: async (value) => {
				plugin.settings.followUpSuggestionsEnabled = value;
				await plugin.saveSettings();
			},
		});

		createToggleField({
			container,
			name: t('settings.followUpSuggestionsStructured'),
			desc: t('settings.followUpSuggestionsStructuredDesc'),
			value: plugin.settings.followUpSuggestionsStructured,
			onChange: async (value) => {
				plugin.settings.followUpSuggestionsStructured = value;
				await plugin.saveSettings();
			},
		});

		createToggleField({
			container,
			name: t('settings.followUpSuggestionsAutoSend'),
			desc: t('settings.followUpSuggestionsAutoSendDesc'),
			value: plugin.settings.followUpSuggestionsAutoSend,
			onChange: async (value) => {
				plugin.settings.followUpSuggestionsAutoSend = value;
				await plugin.saveSettings();
			},
		});
	}

	private renderResetTipsRow(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const known = plugin.settings.knownTipIds;
		const hasKnown = known.length > 0;

		const setting = new Setting(container)
			.setName(t('settings.resetTips'))
			.setDesc(t('settings.resetTipsDesc'))
			.addButton(btn => {
				btn.setButtonText(t('settings.resetTipsBtn'))
					.setIcon('rotate-ccw')
					.setDisabled(!hasKnown)
					.onClick(async () => {
						// Defensive: the button is already disabled when
						// the list is empty, but recompute here so a stale
						// click (e.g. while the section is mid-refresh)
						// can't trigger a no-op save + Notice.
						if (plugin.settings.knownTipIds.length === 0) return;
						plugin.settings.knownTipIds = [];
						await plugin.saveSettings();
						new Notice(t('settings.resetTipsDone'));
						refreshSection(this);
					});
			});

		// Mirrors the advanced-handling baked into `applySettingIndicators`:
		// when advanced is on, decorate the row with the badge + hint;
		// otherwise hide it via the shared collapse class so toggling
		// "Show advanced" makes the row appear/disappear without rebuild.
		if (isAdvancedSettingsVisible()) {
			markSettingAdvanced(setting);
		} else {
			setting.settingEl.addClass('oap-setting--advanced-collapsed');
		}
	}

	private renderCustomMenuPathField(container: HTMLElement): void {
		const { app, plugin, refreshSection } = this.ctx;

		const fileExists = plugin.customMenuService.findFile() !== null;

		const pathSetting = new Setting(container)
			.setName(t('settings.customizeMenuNotePath'))
			.setDesc(t('settings.customizeMenuNotePathDesc'))
			.addText(text => {
				text.setPlaceholder(t('settings.customizeMenuNotePathPlaceholder'));
				text.setValue(plugin.settings.customMenuNotePath);
				text.onChange(async (value) => {
					plugin.settings.customMenuNotePath = value.trim();
					await plugin.saveSettings();
					void plugin.customMenuService.refresh();
				});
			});

		pathSetting.addExtraButton(btn => {
			btn.setIcon('file-plus-2');
			btn.setTooltip(
				fileExists
					? t('settings.customizeOpenNote')
					: t('settings.customizeCreateDefault'),
			);
			btn.onClick(async () => {
				const existing = plugin.customMenuService.findFile();
				if (existing) {
					await plugin.app.workspace.openLinkText(existing.path, '', true);
					return;
				}
				try {
					const file = await plugin.customMenuService.ensureFile();
					new Notice(t('settings.customizeCreated', { path: file.path }));
					refreshSection(this);
				} catch (err) {
					new Notice(
						err instanceof Error ? err.message : String(err),
					);
				}
			});
		});

		pathSetting.addExtraButton(btn => {
			btn.setIcon('eye');
			btn.setTooltip(t('settings.customizePreviewTemplate'));
			btn.onClick(() => {
				new TemplatePreviewModal(app).open();
			});
		});
	}

	private renderSaveAsNoteDirField(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createTextField({
			container,
			name: t('settings.saveAsNoteDir'),
			desc: t('settings.saveAsNoteDirDesc'),
			placeholder: t('settings.saveAsNoteDirPlaceholder'),
			value: plugin.settings.saveAsNoteDir,
			onChange: async (value) => {
				plugin.settings.saveAsNoteDir = value.trim();
				await plugin.saveSettings();
			},
		});
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

	// ── Active config selectors ─────────────────────────────────────

	/**
	 * Add a jump-to-section button to a Setting row.
	 * Clicking it opens the plugin settings and scrolls to the
	 * specified section (defaults to Profile).
	 */
	private addJumpToSectionButton(setting: Setting, sectionId: string = TEXT_GEN_SECTION_ID): void {
		const { app } = this.ctx;
		setting.addExtraButton(btn => {
			btn.setIcon('external-link');
			btn.setTooltip(t('settings.goToProfileSection'));
			btn.onClick(() => {
				openPluginSettings(app, this.ctx.plugin.manifest.id, sectionId);
			});
		});
	}

	private renderActiveProfileSelector(container: HTMLElement): void {
		const { plugin, refreshAll } = this.ctx;
		const profiles = plugin.settings.profiles;

		const setting = new Setting(container)
			.setName(t('settings.profile'))
			.setDesc(t('settings.profileDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
				for (const p of profiles) {
					dropdown.addOption(p.id, getProfileLabel(p));
				}
				dropdown.setValue(plugin.settings.activeProfileId);
				dropdown.onChange(async (value: string) => {
					plugin.settings.activeProfileId = value;
					await plugin.saveSettings();
					refreshAll();
				});
			});
		this.addJumpToSectionButton(setting);
	}

	private renderSummarizerSelector(container: HTMLElement): void {
		const { plugin } = this.ctx;
		const profiles = plugin.settings.profiles;

		const setting = new Setting(container)
			.setName(t('settings.summarizer'))
			.setDesc(t('settings.summarizerDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
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
		this.addJumpToSectionButton(setting);
	}

	private renderInsightsProfileSelector(container: HTMLElement): void {
		const { plugin } = this.ctx;
		const profiles = plugin.settings.profiles;

		const setting = new Setting(container)
			.setName(t('settings.insightsProfile'))
			.setDesc(t('settings.insightsProfileDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
				for (const p of profiles) {
					dropdown.addOption(p.id, getProfileLabel(p));
				}
				const insightsId = plugin.settings.insightsProfileId
					&& profiles.some(p => p.id === plugin.settings.insightsProfileId)
					? plugin.settings.insightsProfileId
					: plugin.settings.activeProfileId;
				dropdown.setValue(insightsId);
				dropdown.onChange(async (value: string) => {
					plugin.settings.insightsProfileId = value;
					await plugin.saveSettings();
				});
			});
		this.addJumpToSectionButton(setting);
	}

	private renderActiveEmbeddingSelector(container: HTMLElement): void {
		const { plugin, refreshAll } = this.ctx;
		const embeddingConfigs = plugin.settings.embeddingConfigs;

		const setting = new Setting(container)
			.setName(t('settings.embeddingConfig'))
			.setDesc(t('settings.embeddingConfigDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
				dropdown.addOption('', t('settings.embeddingNone'));
				for (const c of embeddingConfigs) {
					dropdown.addOption(c.id, c.name || 'Unnamed');
				}
				dropdown.setValue(plugin.settings.activeEmbeddingId);
				dropdown.onChange(async (value: string) => {
					plugin.settings.activeEmbeddingId = value;
					await plugin.saveSettings();
					refreshAll();
				});
			});
		this.addJumpToSectionButton(setting, EMBEDDING_SECTION_ID);
	}

	private renderActiveImageGenSelector(container: HTMLElement): void {
		const { plugin, refreshAll } = this.ctx;
		const imageGenConfigs = plugin.settings.imageGenConfigs;

		const setting = new Setting(container)
			.setName(t('settings.imageGenConfig'))
			.setDesc(t('settings.imageGenConfigDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
				for (const c of imageGenConfigs) {
					dropdown.addOption(c.id, c.name || 'Unnamed');
				}
				dropdown.setValue(plugin.settings.activeImageGenId);
				dropdown.onChange(async (value: string) => {
					plugin.settings.activeImageGenId = value;
					await plugin.saveSettings();
					refreshAll();
				});
			});
		this.addJumpToSectionButton(setting, IMAGE_GEN_SECTION_ID);
	}

	private renderActiveUploadSelector(container: HTMLElement): void {
		const { plugin, refreshAll } = this.ctx;
		const uploadConfigs = plugin.settings.uploadConfigs;

		const setting = new Setting(container)
			.setName(t('settings.uploadConfig'))
			.setDesc(t('settings.uploadConfigDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
				for (const c of uploadConfigs) {
					dropdown.addOption(c.id, c.name || 'Unnamed');
				}
				dropdown.setValue(plugin.settings.activeUploadId);
				dropdown.onChange(async (value: string) => {
					plugin.settings.activeUploadId = value;
					await plugin.saveSettings();
					refreshAll();
				});
			});

		// Mark as experimental (always shown).
		markSettingExperimental(setting);

		// Advanced: show badge when advanced settings are visible, hide otherwise.
		if (isAdvancedSettingsVisible()) {
			markSettingAdvanced(setting);
		} else {
			setting.settingEl.addClass('oap-setting--advanced-collapsed');
		}
	}
}

/** Build a display label for a profile (name + provider/model). */
export function getProfileLabel(p: TextGenConfig): string {
	return `${p.name} (${p.provider === 'gemini' ? 'Gemini' : p.model})`;
}
