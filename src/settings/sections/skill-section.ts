import { Notice, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import {
	DEFAULT_SKILL_FILTER_TOP_K,
	DEFAULT_SKILL_HINT_THRESHOLD,
	DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
} from "../defaults";
import { retrieve, type RetrievalResult } from "../../services/retriever";
import { buildSkillEmbeddingText } from "../../skills/skill-catalogue";
import { createEmbeddingConfig } from "../../services/chat-factory";
import { createTextField, isAdvancedSettingsVisible } from "../../components/settings-components";
import { SkillDetailsModal } from "./skill-details-modal";
import type { NoteAssistantPluginSettings } from "../types";
import type { SkillDefinition } from "../../skills/skill-loader";
import type { SectionContext, SettingsSection } from "./types";

export class SkillSettingsSection implements SettingsSection {
	readonly titleKey = 'settings.skills';

	constructor(private readonly ctx: SectionContext) {}

	renderHeaderActions(container: HTMLElement): void {
		const { plugin, refreshSection } = this.ctx;

		// Show details button (only when skills are loaded)
		const allSkills = plugin.skillManager.getAllSkills();
		if (allSkills.length > 0) {
			const detailsBtn = container.createEl('button', {
				cls: 'clickable-icon oap-settings-header-action-btn oap-settings-header-action-btn--has-badge',
			});
			setIcon(detailsBtn, 'list');
			setTooltip(detailsBtn, t('settings.skillShowDetails'));
			// Count badge — show enabled count
			const enabledCount = allSkills.filter(s => !s.disabled).length;
			detailsBtn.createEl('span', {
				cls: 'oap-settings-header-action-badge',
				text: enabledCount > 99 ? '99+' : String(enabledCount),
			});
			detailsBtn.addEventListener('click', () => {
				new SkillDetailsModal(plugin.app, allSkills).open();
			});
		}

		const reloadBtn = container.createEl('button', {
			cls: 'clickable-icon oap-settings-header-action-btn',
		});
		setIcon(reloadBtn, 'refresh-cw');
		setTooltip(reloadBtn, t('settings.reloadSkills'));
		reloadBtn.addEventListener('click', () => {
			reloadBtn.classList.add('is-loading');
			// Use `.finally` so the spinner is always cleared even if the
			// reload rejects; otherwise the button would be stuck spinning.
			void plugin.reloadSkills()
				.then(() => {
					refreshSection(this);
					new Notice(t('settings.skillsReloaded'));
				})
				.finally(() => {
					reloadBtn.classList.remove('is-loading');
				});
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
				removeBtn.addEventListener('click', () => {
					skillPaths.splice(idx, 1);
					void (async () => {
						await plugin.saveSettings();
						await plugin.reloadSkills();
						refreshSection(this);
					})();
				});
			}
		// Async: check directory existence and mark invalid chips
			void (async () => {
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

		addBtn.addEventListener('click', () => { void commitPath(); });
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void commitPath();
			}
		});

		// Show matching tuning + trigger tester when skills are loaded
		const loadedSkills = plugin.skillManager.getSkills();
		if (loadedSkills.length > 0) {
			// ── Matching tuning + trigger tester ──
			//
			// All four threshold knobs sit immediately above the trigger
			// tester so editing a value and clicking "Test" gives users
			// instant feedback on how the new value re-bands their skills.
			// Co-locating them in the Skills section (rather than buried
			// in Embedding settings) also keeps the conceptually-related
			// surfaces — "what controls skill matching" + "what would
			// match right now" — in one mental unit.
			this.renderMatchingTuning(container);
			this.renderTriggerTester(container, loadedSkills);
		}
	}

	/**
	 * Render the three matching-tuning fields:
	 *
	 *   1. catalogue size cap (`skillFilterTopK`)
	 *   2. strong-hint floor (`skillHintThreshold`)
	 *   3. auto-inject floor (`skillAutoInjectThreshold`)
	 *
	 * Validation mirrors the use-site clamping in `skill-catalogue.ts`
	 * (range + ordering rules) so what the user types here is exactly
	 * what the catalogue builder will apply at runtime.
	 *
	 * Lives in this section (not Embedding) because the trigger tester
	 * is the only meaningful way to pick concrete numbers — every
	 * embedding model has a different score distribution, and the
	 * "right" threshold is "wherever your relevant skills score, plus
	 * a small buffer".
	 *
	 * Both threshold fields gate cosine-similarity bands and therefore
	 * only fire when an embedding profile is active — without embedding
	 * the retriever still ranks skills (via BM25) and produces a
	 * shortlist, but neither escalation triggers because there is no
	 * stable similarity scale to threshold against.
	 */
	private renderMatchingTuning(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createTextField({
			container,
			name: t('settings.skillFilterTopK'),
			desc: t('settings.skillFilterTopKDesc'),
			placeholder: String(DEFAULT_SKILL_FILTER_TOP_K),
			value: String(plugin.settings.skillFilterTopK),
			advanced: true,
			onChange: async (value) => {
				const num = parseInt(value, 10);
				plugin.settings.skillFilterTopK =
					isNaN(num) ? DEFAULT_SKILL_FILTER_TOP_K
					: Math.max(1, Math.min(30, num));
				await plugin.saveSettings();
			},
		});

		createTextField({
			container,
			name: t('settings.skillHintThreshold'),
			desc: t('settings.skillHintThresholdDesc'),
			placeholder: String(DEFAULT_SKILL_HINT_THRESHOLD),
			value: String(plugin.settings.skillHintThreshold),
			advanced: true,
			onChange: async (value) => {
				const num = parseFloat(value);
				plugin.settings.skillHintThreshold =
					isNaN(num) ? DEFAULT_SKILL_HINT_THRESHOLD
					: Math.max(0, Math.min(1, num));
				await plugin.saveSettings();
			},
		});

		createTextField({
			container,
			name: t('settings.skillAutoInjectThreshold'),
			desc: t('settings.skillAutoInjectThresholdDesc'),
			placeholder: String(DEFAULT_SKILL_AUTO_INJECT_THRESHOLD),
			value: String(plugin.settings.skillAutoInjectThreshold),
			advanced: true,
			onChange: async (value) => {
				const num = parseFloat(value);
				plugin.settings.skillAutoInjectThreshold =
					isNaN(num) ? DEFAULT_SKILL_AUTO_INJECT_THRESHOLD
					: Math.max(0, Math.min(1, num));
				await plugin.saveSettings();
			},
		});
	}

	/**
	 * Render the "test a trigger" panel.
	 *
	 * The panel runs the SAME retriever the runtime uses (BM25 fused
	 * with embedding cosine via RRF when embedding is configured;
	 * BM25-only otherwise) and feeds it the identical candidate
	 * composition ({@link buildSkillEmbeddingText}). Result rows
	 * therefore reflect the actual ordering a real chat turn would
	 * produce — including the case where BM25 promotes an exact-name
	 * match above a higher-cosine semantic match.
	 *
	 * The panel always renders fully interactive (no `disabled` state on
	 * either the input or the button). Embedding-readiness is re-evaluated
	 * at click time, not render time — that way the user can toggle
	 * embedding on/off in another settings section and the tester will
	 * just work on the next click, without depending on a cross-section
	 * re-render notification. Without embedding the tester degrades to
	 * BM25-only and surfaces a banner explaining that hint / auto-inject
	 * bands cannot be evaluated under that mode.
	 */
	private renderTriggerTester(
		container: HTMLElement,
		skills: SkillDefinition[],
	): void {
		const { plugin } = this.ctx;

		const wrap = container.createEl('div', {
			cls: 'oap-settings-skill-tester',
		});
		if (!isAdvancedSettingsVisible()) {
			wrap.addClass('oap-setting--advanced-collapsed');
		}
		wrap.createEl('div', {
			cls: 'oap-settings-skill-tester-title',
			text: t('settings.skillTesterTitle'),
		});
		wrap.createEl('div', {
			cls: 'oap-settings-skill-tester-desc',
			text: t('settings.skillTesterDesc'),
		});

		const row = wrap.createEl('div', {
			cls: 'oap-settings-skill-tester-row',
		});
		const queryInput = row.createEl('input', {
			cls: 'oap-settings-skill-tester-input',
			attr: {
				type: 'text',
				placeholder: t('settings.skillTesterPlaceholder'),
			},
		});
		const runBtn = row.createEl('button', {
			cls: 'oap-settings-skill-tester-btn',
			text: t('settings.skillTesterRun'),
		});

		const resultsEl = wrap.createEl('div', {
			cls: 'oap-settings-skill-tester-results',
		});

		const runTest = async () => {
			const query = queryInput.value.trim();
			if (!query) return;

			// Re-read on every click so toggling embedding in another
			// settings section (or another window) is picked up without
			// needing a tab refresh.
			const embeddingConfig = createEmbeddingConfig(plugin);

			runBtn.setAttr('disabled', 'true');
			runBtn.setText(t('settings.skillTesterRunning'));
			resultsEl.empty();

			try {
				await runRetrieveAndRender({
					query,
					skills,
					embeddingConfig: embeddingConfig ?? null,
					resultsEl,
					// Snapshot every relevant knob at click time so the
					// result table reflects the user's *current*
					// settings (thresholds AND catalog cap) without
					// requiring a section re-render.
					bandThresholds: resolveBandThresholds(plugin.settings),
					topK: Math.max(1, plugin.settings.skillFilterTopK | 0),
				});
			} catch (err) {
				console.error('SkillTester: retriever failed', err);
				resultsEl.createEl('div', {
					cls: 'oap-settings-skill-tester-error',
					text: t('settings.skillTesterFailed'),
				});
			} finally {
				runBtn.removeAttribute('disabled');
				runBtn.setText(t('settings.skillTesterRun'));
			}
		};

		runBtn.addEventListener('click', () => { void runTest(); });
		queryInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				void runTest();
			}
		});
	}
}

/**
 * Run the shared retriever against the query + skill set, then render
 * the result rows.
 *
 * The retriever and candidate composition are byte-for-byte identical
 * to what {@link buildSkillSystemPromptForQuery} uses at chat time, so
 * the panel's ordering is the ordering a real turn would produce —
 * including the (occasionally unintuitive) case where BM25 promotes an
 * exact-name match above a higher-cosine semantic match.
 *
 * Skills that produced no signal (BM25-only mode + zero term overlap)
 * are appended at the bottom of the result table so the count always
 * matches the loaded skill count.
 *
 * Throws on any error; the caller is responsible for the generic
 * "retriever failed" fallback row.
 */
async function runRetrieveAndRender(opts: {
	query: string;
	skills: SkillDefinition[];
	embeddingConfig: ReturnType<typeof createEmbeddingConfig> | null;
	resultsEl: HTMLElement;
	bandThresholds: BandThresholds;
	topK: number;
}): Promise<void> {
	const { query, skills, embeddingConfig, resultsEl, bandThresholds, topK } = opts;

	const candidateTexts = skills.map(buildSkillEmbeddingText);
	const ranked = await retrieve(query, candidateTexts, {
		embeddingConfig: embeddingConfig ?? null,
	});

	renderTesterResults(resultsEl, skills, ranked, bandThresholds, topK, !!embeddingConfig);
}

/**
 * Snapshot of the two cosine thresholds that decide which escalation
 * band a similarity score falls into. Captured at the moment a test
 * fires so the result rows reflect the user's *current* settings,
 * not whatever was active when the settings tab was first opened.
 *
 * Note: the catalogue filter floor was removed — the retriever now
 * ranks by RRF-fused BM25 + embedding and there is no fixed score
 * threshold for "in the catalogue at all". Every skill in the
 * shortlist ends up in one of the three bands below.
 */
interface BandThresholds {
	/** Floor for the strong-hint band. */
	hint: number;
	/** Floor for the auto-inject band. */
	autoInject: number;
}

/**
 * Resolve the live band thresholds from settings, applying the same
 * clamping + ordering rules the runtime catalogue builder applies.
 * Mirrors the logic in `skill-catalogue.ts` so the tester never
 * disagrees with what actually happens in a real prompt.
 */
function resolveBandThresholds(
	settings: NoteAssistantPluginSettings,
): BandThresholds {
	const hint = clamp01(
		settings.skillHintThreshold ?? DEFAULT_SKILL_HINT_THRESHOLD,
	);
	const autoInject = Math.max(
		hint,
		clamp01(
			settings.skillAutoInjectThreshold ?? DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
		),
	);
	return { hint, autoInject };
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

/**
 * Render the trigger-tester result table.
 *
 * Layout per row (top-down ordering matches the retriever ranking):
 *
 *     #1  manage_todos   BM25 1.84   cos 0.62   [strong hint]    ← top row
 *     #2  task_planner   BM25 0.92   cos 0.78   [listed]
 *     #3  note_summary       —       cos 0.45   [listed]
 *     ────────────────── topK cutoff ──────────────────
 *     #4  code_reviewer      —       cos 0.32   [filtered out]
 *     —   unused_skill       —           —      [no signal]
 *
 * Each row encodes two independent signals:
 *
 *   1. **Whether the skill makes it into the runtime catalogue**
 *      (driven by `skillFilterTopK`): rows with `rank > topK`, and
 *      rows that produced no signal at all (no BM25 hit AND no
 *      cosine), share the `filtered-out` band. Either way the model
 *      never sees them, so the same demoted styling applies.
 *
 *   2. **What escalation the top-1 row will trigger**
 *      (driven by `skillHintThreshold` / `skillAutoInjectThreshold`,
 *      both cosine-based): only the very first row can realistically
 *      escalate at runtime — that's where the `--top` modifier and
 *      the strong-hint / auto-inject bands live. Subsequent in-catalog
 *      rows all show `listed` regardless of their cosine, because
 *      that's what actually happens: hint / auto-inject is a
 *      single-skill decision tied to the catalogue's top entry.
 *
 * When `hasEmbedding` is `false` a banner above the rows clarifies
 * that hint / auto-inject bands cannot be evaluated under BM25-only
 * mode — every in-catalog row falls into the `listed` band by
 * definition.
 */
function renderTesterResults(
	container: HTMLElement,
	skills: SkillDefinition[],
	ranked: RetrievalResult[],
	thresholds: BandThresholds,
	topK: number,
	hasEmbedding: boolean,
): void {
	if (skills.length === 0) {
		container.createEl('div', {
			cls: 'oap-settings-skill-tester-empty',
			text: t('settings.skillTesterNoSkills'),
		});
		return;
	}

	if (!hasEmbedding) {
		container.createEl('div', {
			cls: 'oap-settings-skill-tester-banner',
			text: t('settings.skillTesterBm25OnlyBanner'),
		});
	}

	const scoredIndices = new Set(ranked.map(r => r.index));
	type Row = {
		skill: SkillDefinition;
		rank: number | null;
		bm25: number | null;
		cosine: number | null;
	};
	const rows: Row[] = ranked.map((r, i) => ({
		skill: skills[r.index]!,
		rank: i + 1,
		bm25: r.bm25Score ?? null,
		cosine: r.cosineSimilarity ?? null,
	}));
	for (let i = 0; i < skills.length; i++) {
		if (scoredIndices.has(i)) continue;
		rows.push({
			skill: skills[i]!,
			rank: null,
			bm25: null,
			cosine: null,
		});
	}

	for (let i = 0; i < rows.length; i++) {
		const { skill, rank, bm25, cosine } = rows[i]!;
		const band = resolveRowBand({ rowIndex: i, rank, cosine, topK, thresholds });
		const classes = [
			'oap-settings-skill-tester-result',
			`oap-settings-skill-tester-result--${band}`,
		];
		// Mark the runtime-decisive row (rank #1 with a real score) so
		// users can immediately spot which entry the hint /
		// auto-inject gates would actually evaluate.
		if (i === 0 && rank !== null) {
			classes.push('oap-settings-skill-tester-result--top');
		}
		const row = container.createEl('div', { cls: classes.join(' ') });

		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-rank',
			text: rank !== null ? `#${rank}` : '—',
		});
		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-name',
			text: skill.name,
		});
		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-bm25',
			text: bm25 !== null ? `BM25 ${bm25.toFixed(2)}` : '—',
		});
		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-cosine',
			text: cosine !== null ? `cos ${cosine.toFixed(3)}` : '—',
		});
		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-band',
			text: t(bandLabelKey(band)),
		});
	}
}

type SimilarityBand = 'auto-inject' | 'hint' | 'plain' | 'filtered-out';

/**
 * Per-row band decision for the trigger-tester table. The decision
 * tree mirrors the runtime catalogue builder:
 *
 *   - Row with no signal (BM25 missed + embedding missed/unconfigured):
 *     `filtered-out`. The retriever wouldn't surface it either.
 *   - Row beyond the `topK` cutoff: `filtered-out`. Same outcome at
 *     runtime — the model never sees it.
 *   - Top-row (rank 1) with cosine ≥ auto-inject threshold:
 *     `auto-inject`. This is the only row that can actually trigger
 *     auto-inject at runtime.
 *   - Top-row with cosine ≥ hint threshold: `hint`. Same reasoning.
 *   - Anything else inside the catalogue: `plain` ("listed"). This
 *     deliberately ignores cosine for non-top rows — hint /
 *     auto-inject are single-skill decisions in the runtime; showing
 *     a high-cosine `#3` as `hint` would falsely suggest it would
 *     escalate, which it never does.
 */
function resolveRowBand(args: {
	rowIndex: number;
	rank: number | null;
	cosine: number | null;
	topK: number;
	thresholds: BandThresholds;
}): SimilarityBand {
	const { rowIndex, rank, cosine, topK, thresholds } = args;
	if (rank === null) return 'filtered-out';
	if (rank > topK) return 'filtered-out';
	if (rowIndex === 0 && cosine !== null) {
		if (cosine >= thresholds.autoInject) return 'auto-inject';
		if (cosine >= thresholds.hint) return 'hint';
	}
	return 'plain';
}

function bandLabelKey(band: SimilarityBand): string {
	switch (band) {
		case 'auto-inject': return 'settings.skillTesterBandAutoInject';
		case 'hint': return 'settings.skillTesterBandHint';
		case 'plain': return 'settings.skillTesterBandPlain';
		case 'filtered-out': return 'settings.skillTesterBandFilteredOut';
	}
}
