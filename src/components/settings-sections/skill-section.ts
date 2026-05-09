import { Notice, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import type { SectionContext, SettingsSection } from "./types";

export class SkillSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.skills';

	constructor(private readonly ctx: SectionContext) {}

	renderHeaderActions(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;
		const reloadBtn = container.createEl('button', {
			cls: 'clickable-icon oap-settings-header-action-btn',
		});
		setIcon(reloadBtn, 'refresh-cw');
		setTooltip(reloadBtn, t('settings.reloadSkills'));
		reloadBtn.addEventListener('click', async () => {
			reloadBtn.classList.add('is-loading');
			await plugin.reloadSkills();
			reloadBtn.classList.remove('is-loading');
			refreshSection(this);
			new Notice(t('settings.skillsReloaded'));
		});
	}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;

		const skillPaths = plugin.settings.skillSearchPaths;

		if (skillPaths.length === 0) {
			container.createEl('div', {
				cls: 'oap-settings-empty',
				text: t('settings.skillsEmpty'),
			});
		}

		// Chip list for skill search directories
		if (skillPaths.length > 0) {
			const chipList = container.createEl('div', {
				cls: 'oap-settings-chip-list',
			});
			const { app } = plugin;
			const chipEls: HTMLElement[] = [];
			for (let idx = 0; idx < skillPaths.length; idx++) {
				const path = skillPaths[idx]!;
				const chip = chipList.createEl('div', {
					cls: 'oap-settings-chip',
				});
				chipEls.push(chip);
				chip.createEl('span', {
					cls: 'oap-settings-chip-label',
					text: path || t('settings.skillPathPlaceholder'),
				});
				const removeBtn = chip.createEl('button', {
					cls: 'oap-settings-chip-remove',
				});
				setIcon(removeBtn, 'x');
				setTooltip(removeBtn, t('settings.removeSkillPath'));
				removeBtn.addEventListener('click', async () => {
					skillPaths.splice(idx, 1);
					await plugin.saveSettings();
					await plugin.reloadSkills();
					refreshSection(this);
				});
			}
		// Async: check directory existence and mark invalid chips
			(async () => {
				for (let idx = 0; idx < skillPaths.length; idx++) {
					const path = skillPaths[idx]!;
					const exists = await app.vault.adapter.exists(path);
				if (!exists) {
						const chipEl = chipEls[idx];
						chipEl?.classList.add('oap-settings-chip--invalid');
						if (chipEl) setTooltip(chipEl, t('settings.skillPathNotExist'));
					}
				}
			})();
		}

		// Add path: inline input row
		const inputRow = container.createEl('div', {
			cls: 'oap-settings-chip-input-row',
		});
		const input = inputRow.createEl('input', {
			cls: 'oap-settings-chip-input',
			attr: {
				type: 'text',
				placeholder: t('settings.skillPathPlaceholder'),
			},
		});
		const addBtn = inputRow.createEl('button', {
			cls: 'oap-settings-chip-add-btn',
		});
		setIcon(addBtn, 'plus');
		setTooltip(addBtn, t('settings.addSkillPath'));

		const commitPath = async () => {
			const value = input.value.trim();
			if (!value) return;
			skillPaths.push(value);
			input.value = '';
			await plugin.saveSettings();
			await plugin.reloadSkills();
			refreshSection(this);
		};

		addBtn.addEventListener('click', () => commitPath());
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				commitPath();
			}
		});

		// Show loaded skills count
		const loadedSkills = plugin.skillManager.getSkills();
		if (loadedSkills.length > 0) {
			container.createEl('div', {
				cls: 'oap-settings-status',
				text: t('settings.skillsLoaded', { count: loadedSkills.length }),
			});

			// List detected skills with name and description
			const listEl = container.createEl('div', {
				cls: 'oap-settings-skill-list',
			});
			for (const skill of loadedSkills) {
				const itemEl = listEl.createEl('div', {
					cls: 'oap-settings-skill-item',
				});
				const nameRow = itemEl.createEl('div', {
					cls: 'oap-settings-skill-name-row',
				});
				nameRow.createEl('div', {
					cls: 'oap-settings-skill-name',
					text: skill.name,
				});
				nameRow.createEl('div', {
					cls: 'oap-settings-skill-location',
					text: skill.location,
				});
				itemEl.createEl('div', {
					cls: 'oap-settings-skill-desc',
					text: skill.description,
				});
			}
		}
	}
}
