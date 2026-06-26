import { DropdownComponent, Notice, Setting, TFile, TFolder, normalizePath, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import type { TextGenConfig } from "../types";
import { SystemPromptModal } from "../../modals/system-prompt-modal";
import { TemplatePreviewModal } from "../../modals/template-preview-modal";
import {
	createSettingsGroupHeading,
	createTextField,
	createToggleField,
	isAdvancedSettingsVisible,
	markSettingAdvanced,
	markSettingDeprecated,
	markSettingRequiresSessionRestart,
} from "../../components/settings-components";
import type { SectionContext, SettingsSection } from "./types";
import { openPluginSettings } from "../../utils/open-plugin-settings";
import { TEXT_GEN_SECTION_ID, EMBEDDING_SECTION_ID, IMAGE_GEN_SECTION_ID, SPEECH_TO_TEXT_SECTION_ID } from "../section-ids";

export class GlobalSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.globalSection';

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshAll } = this.ctx;

		// System prompt (display-only with edit button)
		this.renderSystemPromptField(container);

		// AGENT.md path (file-based alternative to Initial Prompt)
		this.renderAgentMdPathField(container);

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
		this.renderActiveSpeechToTextSelector(container);

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
		markSettingDeprecated(setting);
	}

	/** Default template for newly-created AGENT.md. */
	private static get AGENT_MD_TEMPLATE(): string {
		return t('settings.agentMdTemplate');
	}

	private renderAgentMdPathField(container: HTMLElement): void {
		const { app, plugin, refreshSection } = this.ctx;
		const agentMdPath = plugin.settings.agentMdPath;
		const fileExists = this._findAgentMdFile() !== null;

		// Cache the extra button's DOM element so the onChange handler
		// can update its icon/tooltip in-place instead of calling
		// refreshSection() which would destroy and recreate the text
		// input, causing focus loss on every keystroke.
		let actionBtnEl: HTMLElement | null = null;
		const updateActionBtn = (path: string) => {
			if (!actionBtnEl) return;
			const trimmed = path.trim();
			const exists = trimmed
				? app.vault.getAbstractFileByPath(normalizePath(trimmed)) instanceof TFile
				: false;
			setIcon(actionBtnEl, exists ? 'external-link' : 'file-plus-2');
			setTooltip(actionBtnEl, exists
				? t('settings.agentMdOpenNote')
				: t('settings.agentMdCreateDefault'));
		};

		const pathSetting = new Setting(container)
			.setName(t('settings.agentMdPath'))
			.setDesc(t('settings.agentMdPathDesc'))
			.addText(text => {
				text.setPlaceholder(t('settings.agentMdPathPlaceholder'));
				text.setValue(agentMdPath);
				text.onChange(async (value) => {
					const trimmed = value.trim();
					plugin.settings.agentMdPath = trimmed;
					await plugin.saveSettings();
					// Refresh cached content so next session creation can pick it up.
					void plugin.refreshAgentMd();
					// Update the action button in-place instead of
					// re-rendering the whole section (avoids focus loss).
					updateActionBtn(trimmed);
				});
			});

		// "Create default" / "Open" toggle button
		pathSetting.addExtraButton(btn => {
			actionBtnEl = btn.extraSettingsEl;
			btn.setIcon(fileExists ? 'external-link' : 'file-plus-2');
			btn.setTooltip(
				fileExists
					? t('settings.agentMdOpenNote')
					: t('settings.agentMdCreateDefault'),
			);
			btn.onClick(async () => {
				const existing = this._findAgentMdFile();
				if (existing) {
					await app.workspace.openLinkText(existing.path, '', true);
					return;
				}
				try {
					const file = await this._ensureAgentMdFile();
					new Notice(t('settings.agentMdCreated', { path: file.path }));
					// Refresh the runtime cache so new sessions use the file.
					void plugin.refreshAgentMd();
					refreshSection(this);
				} catch (err) {
					new Notice(
						err instanceof Error ? err.message : String(err),
					);
				}
			});
		});

		markSettingRequiresSessionRestart(pathSetting);
	}

	/** Find the AGENT.md file (if any) based on the configured path. */
	private _findAgentMdFile(): TFile | null {
		const { plugin } = this.ctx;
		const raw = plugin.settings.agentMdPath?.trim() ?? '';
		if (!raw) return null;
		const path = normalizePath(raw);
		const af = this.ctx.app.vault.getAbstractFileByPath(path);
		return af instanceof TFile ? af : null;
	}

	/** Ensure AGENT.md exists, creating it with the default template. */
	private async _ensureAgentMdFile(): Promise<TFile> {
		const { app, plugin } = this.ctx;
		const raw = plugin.settings.agentMdPath?.trim() ?? '';
		if (!raw) throw new Error('AGENT.md path is empty.');

		const path = normalizePath(raw);
		const existing = app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		if (existing) {
			throw new Error(`"${path}" exists but is not a file.`);
		}

		// Create missing parent folders.
		const parts = path.split('/');
		if (parts.length > 1) {
			const parentPath = parts.slice(0, -1).join('/');
			const parent = app.vault.getAbstractFileByPath(parentPath);
			if (!parent) {
				await app.vault.createFolder(parentPath);
			} else if (!(parent instanceof TFolder)) {
				throw new Error(`Parent "${parentPath}" exists but is not a folder.`);
			}
		}

		return app.vault.create(path, GlobalSettingsSection.AGENT_MD_TEMPLATE);
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

	private renderActiveSpeechToTextSelector(container: HTMLElement): void {
		const { plugin, refreshAll } = this.ctx;
		const sttConfigs = plugin.settings.speechToTextConfigs;

		const setting = new Setting(container)
			.setName(t('settings.speechToTextConfig'))
			.setDesc(t('settings.speechToTextConfigDesc'))
			.addDropdown((dropdown: DropdownComponent) => {
				for (const c of sttConfigs) {
					dropdown.addOption(c.id, c.name || 'Unnamed');
				}
				dropdown.setValue(plugin.settings.activeSpeechToTextId);
				dropdown.onChange(async (value: string) => {
					plugin.settings.activeSpeechToTextId = value;
					await plugin.saveSettings();
					refreshAll();
				});
			});
		this.addJumpToSectionButton(setting, SPEECH_TO_TEXT_SECTION_ID);
	}
}

/** Build a display label for a profile (name + provider/model). */
export function getProfileLabel(p: TextGenConfig): string {
	if (p.provider === 'gemini') return `${p.name} (Gemini)`;
	if (p.provider === 'anthropic') return `${p.name} (Anthropic)`;
	return `${p.name} (${p.model})`;
}
