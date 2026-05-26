import { Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import type { SectionContext, SettingsSection } from "./types";

/**
 * Customize settings panel — driven by the vault-note-backed
 * {@link CustomMenuService}.
 *
 * Layout (top → bottom):
 *   1. Note path field + dual-action button (create / open).
 *   2. Variable reference table.
 */
export class CustomizeSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.customize';

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;

		const fileExists = plugin.customMenuService.findFile() !== null;

		// ── Note path + helpers ──────────────────────────────────────
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

		// ── Variable reference ───────────────────────────────────────
		this.renderVariableReference(container);
	}

	/**
	 * Render a short reference table explaining the available template
	 * variables. Kept minimal so it doesn't overwhelm the settings panel;
	 * the actual examples live in the MENU.md template that users can
	 * create from their vault.
	 */
	private renderVariableReference(container: HTMLElement): void {
		container.createEl('h4', {
			text: t('settings.customizeVariablesHeading'),
		});

		const vars: Array<{ placeholder: string; descKey: string }> = [
			{ placeholder: '{{filepath}}', descKey: 'settings.customizeVarFilepath' },
			{ placeholder: '{{selection}}', descKey: 'settings.customizeVarSelection' },
			{ placeholder: '{{blockquote}}', descKey: 'settings.customizeVarBlockquote' },
		];

		const table = container.createEl('table', {
			cls: 'oap-customize-variables-table',
		});
		for (const v of vars) {
			const row = table.createEl('tr');
			row.createEl('td', { cls: 'oap-customize-var-name' }).setText(v.placeholder);
			row.createEl('td', { cls: 'oap-customize-var-desc' }).setText(t(v.descKey));
		}
	}
}
