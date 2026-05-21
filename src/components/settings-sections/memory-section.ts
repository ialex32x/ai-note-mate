import { Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import {
	createToggleField,
	isAdvancedSettingsVisible,
	markSettingAdvanced,
} from "../settings-components";
import type { SectionContext, SettingsSection } from "./types";
import {
	isMemoryConfigured,
	MemoryStoreError,
} from "../../services/memory";

/**
 * Memory settings panel — driven entirely by the vault-note-backed
 * {@link MemoryStore}.
 *
 * Layout (top → bottom):
 *   1. Master enable toggle (also gates the tools + the prompt prefix).
 *   2. Note path field + "Open" / "Create default" buttons.
 *   3. One-line entry-count status (lives directly under the path so the
 *      number is read as belonging to that path).
 *   4. Auto-extract toggle and its dependent thresholds.
 *   5. Recall tuning (critical budget, relevant top-K, similarity).
 *
 * Per-entry CRUD is intentionally NOT surfaced in settings — the memory
 * note is a plain markdown file in the user's vault and the user can
 * edit it directly (with full preview, search, link-graph, etc.). The
 * status row is a best-effort async read: errors render inline and
 * never bubble up so the rest of the section stays usable.
 */
export class MemorySettingsSection implements SettingsSection {
	readonly titleKey = 'settings.memory';

	constructor(private readonly ctx: SectionContext) {}

	render(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;

		// ── Master switch ────────────────────────────────────────────
		createToggleField({
			container,
			name: t('settings.memoryEnabled'),
			desc: t('settings.memoryEnabledDesc'),
			value: plugin.settings.memoryEnabled,
			onChange: async (value) => {
				plugin.settings.memoryEnabled = value;
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// ── Note path + helpers ──────────────────────────────────────
		const pathSetting = new Setting(container)
			.setName(t('settings.memoryNotePath'))
			.setDesc(t('settings.memoryNotePathDesc'))
			.addText(text => {
				text.setPlaceholder(t('settings.memoryNotePathPlaceholder'));
				text.setValue(plugin.settings.memoryNotePath);
				text.onChange(async (value) => {
					plugin.settings.memoryNotePath = value.trim();
					await plugin.saveSettings();
				});
			});

		pathSetting.addExtraButton(btn => {
			btn.setIcon('file-plus-2');
			btn.setTooltip(t('settings.memoryCreateDefault'));
			btn.onClick(async () => {
				try {
					const file = await plugin.memoryStore.ensureFile();
					new Notice(t('settings.memoryCreated', { path: file.path }));
					refreshSection(this);
				} catch (err) {
					this.handleStoreError(err);
				}
			});
		});

		pathSetting.addExtraButton(btn => {
			btn.setIcon('external-link');
			btn.setTooltip(t('settings.memoryOpenNote'));
			btn.onClick(async () => {
				const file = plugin.memoryStore.findFile();
				if (!file) {
					new Notice(t('settings.memoryNoteMissing'));
					return;
				}
				await plugin.app.workspace.openLinkText(file.path, '', true);
			});
		});

		// ── Entry count (positioned right under the path so the number
		//    is read as belonging to that path). One-line status only;
		//    full CRUD lives in the note itself. ─────────────────────
		this.renderStatusRow(container);

		// ── Auto-extract toggle ──────────────────────────────────────
		createToggleField({
			container,
			name: t('settings.memoryAutoExtract'),
			desc: t('settings.memoryAutoExtractDesc'),
			value: plugin.settings.memoryAutoExtract,
			onChange: async (value) => {
				plugin.settings.memoryAutoExtract = value;
				await plugin.saveSettings();
				refreshSection(this);
			},
		});

		// ── Auto-extract knobs (only when the toggle is on) ──────────
		// These are safety caps + a reply-length floor — sensible
		// defaults cover the common case, so we surface them only
		// when the user has opted into the advanced view to keep the
		// auto-extract sub-panel focused on the on/off decision.
		if (plugin.settings.memoryAutoExtract) {
			this.renderNumberField({
				container,
				name: t('settings.memoryExtractMaxUpserts'),
				desc: t('settings.memoryExtractMaxUpsertsDesc'),
				value: plugin.settings.memoryExtractMaxUpserts,
				min: 0,
				max: 10,
				advanced: true,
				onChange: async (n) => {
					plugin.settings.memoryExtractMaxUpserts = n;
					await plugin.saveSettings();
				},
			});
			this.renderNumberField({
				container,
				name: t('settings.memoryExtractMaxDeletes'),
				desc: t('settings.memoryExtractMaxDeletesDesc'),
				value: plugin.settings.memoryExtractMaxDeletes,
				min: 0,
				max: 5,
				advanced: true,
				onChange: async (n) => {
					plugin.settings.memoryExtractMaxDeletes = n;
					await plugin.saveSettings();
				},
			});
			this.renderNumberField({
				container,
				name: t('settings.memoryExtractMinReplyChars'),
				desc: t('settings.memoryExtractMinReplyCharsDesc'),
				value: plugin.settings.memoryExtractMinReplyChars,
				min: 0,
				max: 5000,
				advanced: true,
				onChange: async (n) => {
					plugin.settings.memoryExtractMinReplyChars = n;
					await plugin.saveSettings();
				},
			});
		}

		// ── Recall tuning (advanced) ─────────────────────────────────
		// These knobs interact with each other and with the embedding
		// model's score distribution; surface them only when the user
		// has explicitly opted into advanced settings to avoid
		// overwhelming the default panel.
		this.renderNumberField({
			container,
			name: t('settings.memoryCriticalMaxChars'),
			desc: t('settings.memoryCriticalMaxCharsDesc'),
			value: plugin.settings.memoryCriticalMaxChars,
			min: 0,
			max: 20000,
			advanced: true,
			onChange: async (n) => {
				plugin.settings.memoryCriticalMaxChars = n;
				await plugin.saveSettings();
			},
		});
		this.renderNumberField({
			container,
			name: t('settings.memoryRelevantTopK'),
			desc: t('settings.memoryRelevantTopKDesc'),
			value: plugin.settings.memoryRelevantTopK,
			min: 0,
			max: 30,
			advanced: true,
			onChange: async (n) => {
				plugin.settings.memoryRelevantTopK = n;
				await plugin.saveSettings();
			},
		});
	}

	/**
	 * One-line status row showing either the entry count, a "loading"
	 * placeholder, an "empty" message, a "disabled" hint, or an error
	 * message. Inserted directly under the path field so the number is
	 * read as belonging to that path.
	 *
	 * Best-effort: the async vault read must NOT throw to the caller —
	 * any failure is rendered inline and the rest of the section stays
	 * fully usable so the user can fix the path.
	 */
	private renderStatusRow(container: HTMLElement): void {
		const { plugin } = this.ctx;

		// Wrap the status line in a `.setting-item` so it inherits the
		// exact same horizontal padding / border-top / vertical padding
		// as the `Setting`-built rows above and below it (otherwise the
		// bare `<div>` sat slightly off the row gridline). The inner
		// `.oap-settings-status` keeps its original font/color so only
		// the alignment changes.
		const rowEl = container.createEl('div', {
			cls: 'setting-item oap-settings-memory-status-row',
		});
		const statusEl = rowEl.createEl('div', {
			cls: 'oap-settings-status oap-settings-memory-status',
		});

		if (!isMemoryConfigured(plugin)) {
			statusEl.setText(t('settings.memoryDisabledHint'));
			return;
		}

		statusEl.setText(t('settings.memoryLoading'));
		void (async () => {
			try {
				const entries = await plugin.memoryStore.refreshEntries();
				statusEl.setText(
					entries.length === 0
						? t('settings.memoriesEmpty')
						: t('settings.memoryCount', { count: String(entries.length) }),
				);
			} catch (err) {
				statusEl.setText(
					t('settings.memoryReadFailed', {
						msg: err instanceof Error ? err.message : String(err),
					}),
				);
			}
		})();
	}

	/**
	 * Numeric setting helper. We don't use `createNumberField` (none
	 * exists in `settings-components`) and the existing text-field
	 * factory doesn't enforce integer bounds — keeping the validation
	 * inline avoids muddying that module with memory-specific knobs.
	 *
	 * Mirrors `applySettingIndicators` for the `advanced` flag so the
	 * "show advanced" toggle hides / decorates these rows the same way
	 * as fields built via `createTextField` / `createToggleField`.
	 */
	private renderNumberField(opts: {
		container: HTMLElement;
		name: string;
		desc: string;
		value: number;
		min: number;
		max: number;
		advanced?: boolean;
		onChange: (n: number) => void | Promise<void>;
	}): void {
		const setting = new Setting(opts.container)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(opts.min);
				text.inputEl.max = String(opts.max);
				text.setValue(String(opts.value));
				text.onChange(async (raw) => {
					const parsed = Number.parseInt(raw, 10);
					if (!Number.isFinite(parsed)) return;
					const clamped = Math.max(opts.min, Math.min(opts.max, parsed));
					await opts.onChange(clamped);
				});
			});

		if (opts.advanced) {
			if (isAdvancedSettingsVisible()) {
				markSettingAdvanced(setting);
			} else {
				setting.settingEl.addClass('oap-setting--advanced-collapsed');
			}
		}
	}

	private handleStoreError(err: unknown): void {
		if (err instanceof MemoryStoreError) {
			new Notice(`Memory: ${err.message}`);
			return;
		}
		new Notice(`Memory: ${err instanceof Error ? err.message : String(err)}`);
	}
}
