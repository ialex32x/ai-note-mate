import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * Modal dialog that previews the default menu note template and
 * documents the available H2 suffixes and template variables.
 */
export class TemplatePreviewModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.addClass('oap-template-preview-modal');

		this.setTitle(t('settings.customizeTemplatePreviewHeading'));

		// ── Default template section ──────────────────────────────
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: t('settings.customizeTemplatePreviewDesc'),
		});

		const wrap = contentEl.createDiv({
			cls: 'oap-customize-template-preview',
		});
		wrap.createEl('pre', {
			cls: 'oap-customize-template-preview__code',
			text: t('settings.customizeMenuDefaultTemplate'),
		});

		// ── H2 suffixes & template variables section ─────────────
		contentEl.createEl('h4', {
			text: t('settings.customizeVariablesHeading'),
		});

		const vars: Array<{ placeholder: string; descKey: string }> = [
			{ placeholder: '[icon]', descKey: 'settings.customizeVarIcon' },
			{ placeholder: '[.ext, …]', descKey: 'settings.customizeVarFileExtensions' },
			{ placeholder: '{{filepath}}', descKey: 'settings.customizeVarFilepath' },
			{ placeholder: '{{selection}}', descKey: 'settings.customizeVarSelection' },
			{ placeholder: '{{blockquote}}', descKey: 'settings.customizeVarBlockquote' },
		];

		const table = contentEl.createEl('table', {
			cls: 'oap-customize-variables-table',
		});
		for (const v of vars) {
			const row = table.createEl('tr');
			row.createEl('td', { cls: 'oap-customize-var-name' }).setText(v.placeholder);
			row.createEl('td', { cls: 'oap-customize-var-desc' }).setText(t(v.descKey));
		}
	}

	onClose() {
		const { contentEl, modalEl } = this;
		contentEl.empty();
		modalEl.removeClass('oap-template-preview-modal');
	}
}
