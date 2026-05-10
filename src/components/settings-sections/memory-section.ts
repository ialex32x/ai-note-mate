import { Setting, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { createToggleField } from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";

export class MemorySettingsSection implements SettingsSection {
	readonly titleKey = 'settings.memory';

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;

		// Memory enabled toggle
		createToggleField({
			container,
			name: t('settings.memoryEnabled'),
			desc: t('settings.memoryEnabledDesc'),
			value: plugin.settings.memoryEnabled,
			onChange: async (value) => {
				plugin.settings.memoryEnabled = value;
				await plugin.saveSettings();
			},
		});

		// Memories list
		const memories = plugin.settings.memories;
		if (memories.length > 0) {
			container.createEl('div', {
				cls: 'oap-settings-status',
				text: t('settings.memoryCount', { count: String(memories.length) }),
			});

			const memoriesList = container.createDiv({ cls: 'oap-settings-memory-list' });
			for (const memory of memories) {
				const item = memoriesList.createDiv({ cls: 'oap-settings-memory-item' });
				const header = item.createDiv({ cls: 'oap-settings-memory-item-header' });
				header.createEl('span', { cls: 'oap-settings-memory-key', text: memory.key });
				const timestamp = new Date(memory.timestamp).toLocaleString();
				header.createEl('span', { cls: 'oap-settings-memory-timestamp', text: timestamp });
				item.createEl('div', { cls: 'oap-settings-memory-value', text: memory.value });

				// Individual delete button (visible on hover)
				const deleteBtn = item.createEl('button', {
					cls: 'oap-settings-memory-delete-btn',
					attr: { 'aria-label': t('settings.deleteMemory') },
				});
				setIcon(deleteBtn, 'x');
				setTooltip(deleteBtn, t('settings.deleteMemory'));
				deleteBtn.addEventListener('click', () => {
					const idx = plugin.settings.memories.findIndex((m) => m.key === memory.key);
					if (idx >= 0) {
						plugin.settings.memories.splice(idx, 1);
						void plugin.saveSettings().then(() => {
							refreshSection(this);
						});
					}
				});
			}
		} else {
			container.createEl('div', {
				cls: 'oap-settings-empty',
				text: t('settings.memoriesEmpty'),
			});
		}

		// Clear memories button
		if (memories.length > 0) {
			new Setting(container)
				.setName(t('settings.clearMemories'))
				.setDesc(t('settings.clearMemoriesDesc'))
				.addButton(btn => btn
					.setButtonText(t('settings.clearMemoriesBtn'))
					.setIcon('trash')
					.setWarning()
				.onClick(async () => {
						plugin.settings.memories = [];
						await plugin.saveSettings();
						refreshSection(this);
					}));
		}
	}
}
