import { Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import { SystemPromptModal } from "../../modals/system-prompt-modal";
import { TemplatePreviewModal } from "../../modals/template-preview-modal";
import {
	createToggleField,
	isAdvancedSettingsVisible,
	markSettingAdvanced,
	markSettingRequiresSessionRestart,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";

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

		// Reset usage tips (action-only row, not a real config value).
		// Clearing `knownTipIds` makes every previously-dismissed/run tip
		// eligible again in the input toolbar popover. The button itself
		// is disabled when the list is already empty so the row keeps
		// the "what does it do" affordance even before any tip is run.
		this.renderResetTipsRow(container);

		// ── Custom menu path ─────────────────────────────────────
		this.renderCustomMenuPathField(container);
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
}
