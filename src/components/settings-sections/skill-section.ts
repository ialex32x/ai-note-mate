import { Notice, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { getActiveEmbeddingConfig } from "../../settings";
import {
	DEFAULT_SKILL_FILTER_SIMILARITY_THRESHOLD,
	DEFAULT_SKILL_FILTER_TOP_K,
	DEFAULT_SKILL_HINT_THRESHOLD,
	DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
} from "../../settings/defaults";
import { getGlobalEmbedder } from "../../services/embedder";
import { cosineSimilarity } from "../../services/text-embedding";
import { createTextField } from "../settings-components";
import type { EmbeddingConfig, NoteAssistantPluginSettings } from "../../settings/types";
import type { SkillDefinition } from "../../skills/skill-loader";
import type { SectionContext, SettingsSection } from "./types";

/**
 * Authoring quality issues we surface as inline badges so users notice
 * weak skill metadata before complaining about poor recall. Each lint
 * has a stable id (used as a CSS modifier hook + i18n key suffix) and a
 * `level` controlling the badge tone.
 */
type SkillLint = {
	id: 'no-when-to-use' | 'no-triggers' | 'description-too-short';
	level: 'warn' | 'info';
	labelKey: string;
	tooltipKey: string;
};

/**
 * Minimum description length below which we flag the skill as
 * "description-too-short". 30 chars roughly corresponds to a single
 * substantive phrase ("Reformats project notes to the team style") —
 * shorter than that and both the embedder and the model have very
 * little to latch onto.
 */
const SHORT_DESCRIPTION_THRESHOLD = 30;

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

		// Show loaded skills count
		const loadedSkills = plugin.skillManager.getSkills();
		if (loadedSkills.length > 0) {
			container.createEl('div', {
				cls: 'oap-settings-status',
				text: t('settings.skillsLoaded', { count: loadedSkills.length }),
			});

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

			// List detected skills with name, description, and lint badges
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

				const lints = computeSkillLints(skill);
				if (lints.length > 0) {
					const badgeRow = itemEl.createEl('div', {
						cls: 'oap-settings-skill-badges',
					});
					for (const lint of lints) {
						const badge = badgeRow.createEl('span', {
							cls: `oap-settings-skill-badge oap-settings-skill-badge--${lint.level}`,
							text: t(lint.labelKey),
						});
						setTooltip(badge, t(lint.tooltipKey));
					}
				}

				itemEl.createEl('div', {
					cls: 'oap-settings-skill-desc',
					text: skill.description,
				});
				if (skill.whenToUse) {
					itemEl.createEl('div', {
						cls: 'oap-settings-skill-when',
						text: `${t('settings.skillWhenToUseLabel')}: ${skill.whenToUse}`,
					});
				}
			}
		}
	}

	/**
	 * Render the four matching-tuning fields:
	 *
	 *   1. catalogue similarity floor (`skillFilterSimilarityThreshold`)
	 *   2. catalogue size cap (`skillFilterTopK`)
	 *   3. strong-hint floor (`skillHintThreshold`)
	 *   4. auto-inject floor (`skillAutoInjectThreshold`)
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
	 */
	private renderMatchingTuning(container: HTMLElement): void {
		const { plugin } = this.ctx;

		createTextField({
			container,
			name: t('settings.skillFilterSimilarityThreshold'),
			desc: t('settings.skillFilterSimilarityThresholdDesc'),
			placeholder: String(DEFAULT_SKILL_FILTER_SIMILARITY_THRESHOLD),
			value: String(plugin.settings.skillFilterSimilarityThreshold),
			onChange: async (value) => {
				const num = parseFloat(value);
				plugin.settings.skillFilterSimilarityThreshold =
					isNaN(num) ? DEFAULT_SKILL_FILTER_SIMILARITY_THRESHOLD
					: Math.max(0, Math.min(1, num));
				await plugin.saveSettings();
			},
		});

		createTextField({
			container,
			name: t('settings.skillFilterTopK'),
			desc: t('settings.skillFilterTopKDesc'),
			placeholder: String(DEFAULT_SKILL_FILTER_TOP_K),
			value: String(plugin.settings.skillFilterTopK),
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
	 * The panel always renders fully interactive (no `disabled` state on
	 * either the input or the button). Embedding-readiness is re-evaluated
	 * at click time, not render time — that way the user can toggle
	 * embedding on/off in another settings section and the tester will
	 * just work on the next click, without depending on a cross-section
	 * re-render notification.
	 *
	 * The trade-off (vs. statically disabling the button) is that the
	 * user only learns embedding isn't ready when they click; we surface
	 * a clear `Notice()` in that case so it doesn't feel like a silent
	 * no-op.
	 */
	private renderTriggerTester(
		container: HTMLElement,
		skills: SkillDefinition[],
	): void {
		const { plugin } = this.ctx;

		const wrap = container.createEl('div', {
			cls: 'oap-settings-skill-tester',
		});
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

			// Re-read everything fresh on each click so toggling embedding
			// in another section (or even in another window) is picked up
			// without needing a settings-tab refresh.
			const embeddingConfig = getActiveEmbeddingConfig(plugin.settings);
			const embedder = getGlobalEmbedder();
			if (!embeddingConfig || !embedder) {
				new Notice(t('settings.skillTesterNotReady'));
				return;
			}

			runBtn.setAttr('disabled', 'true');
			runBtn.setText(t('settings.skillTesterRunning'));
			resultsEl.empty();

			try {
				await runEmbedAndScore({
					plugin,
					embedder,
					embeddingConfig,
					query,
					skills,
					resultsEl,
					// Snapshot the user's current thresholds so the
					// result rows show bands that match what would
					// actually happen at runtime. Re-reading on each
					// click means changes to the settings take effect
					// without re-rendering the section.
					bandThresholds: resolveBandThresholds(plugin.settings),
				});
			} catch (err) {
				console.error('SkillTester: embed failed', err);
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
 * Embed `query` plus each skill's representative text, score them by
 * cosine similarity, and render the result rows. Extracted so the
 * outer flow stays focused on UI state (button text, disabled flag,
 * error placement) and this function owns the embedding pipeline.
 *
 * Throws on any error after surfacing a `Notice` for user-actionable
 * cases (missing API key) — the caller is responsible for the generic
 * "embedding failed" fallback row.
 */
async function runEmbedAndScore(opts: {
	plugin: import("../../main").default;
	embedder: NonNullable<ReturnType<typeof getGlobalEmbedder>>;
	embeddingConfig: EmbeddingConfig;
	query: string;
	skills: SkillDefinition[];
	resultsEl: HTMLElement;
	bandThresholds: BandThresholds;
}): Promise<void> {
	const { plugin, embedder, embeddingConfig, query, skills, resultsEl, bandThresholds } = opts;

	const apiKey = plugin.app.secretStorage.getSecret(embeddingConfig.apiKey)
		?? embeddingConfig.apiKey;
	if (!apiKey) {
		new Notice(t('settings.skillTesterNoApiKey'));
		throw new Error('SkillTester: no API key');
	}

	await embedder.updateConfig({
		type: embeddingConfig.type,
		apiKey,
		baseURL: embeddingConfig.baseUrl,
		model: embeddingConfig.model,
	});

	const texts = [
		query,
		...skills.map(skillEmbeddingText),
	];
	const vectors = await embedder.embed(texts);
	const queryVec = vectors[0]!;
	const scored = skills.map((s, i) => ({
		skill: s,
		similarity: cosineSimilarity(queryVec, vectors[i + 1]!),
	})).sort((a, b) => b.similarity - a.similarity);

	renderTesterResults(resultsEl, scored, bandThresholds);
}

/**
 * Same composition as `buildSkillEmbeddingText` in skill-catalogue.ts.
 * Duplicated rather than imported to avoid an import cycle (skills →
 * catalogue → embedder → settings → skills) and because the function
 * is trivial.
 */
function skillEmbeddingText(skill: SkillDefinition): string {
	const parts: string[] = [skill.name];
	if (skill.description) parts.push(skill.description);
	if (skill.whenToUse) parts.push(skill.whenToUse);
	if (skill.triggers && skill.triggers.length > 0) {
		parts.push(skill.triggers.join(', '));
	}
	return parts.filter(Boolean).join('\n');
}

/**
 * Compute every lint that currently applies to a skill. Ordered most
 * actionable → least actionable so the user reads the right one first
 * when the list is truncated by available width.
 */
function computeSkillLints(skill: SkillDefinition): SkillLint[] {
	const out: SkillLint[] = [];
	if (!skill.whenToUse) {
		out.push({
			id: 'no-when-to-use',
			level: 'warn',
			labelKey: 'settings.skillLintNoWhenToUseLabel',
			tooltipKey: 'settings.skillLintNoWhenToUseTooltip',
		});
	}
	if (!skill.triggers || skill.triggers.length === 0) {
		out.push({
			id: 'no-triggers',
			level: 'info',
			labelKey: 'settings.skillLintNoTriggersLabel',
			tooltipKey: 'settings.skillLintNoTriggersTooltip',
		});
	}
	if (skill.description.length < SHORT_DESCRIPTION_THRESHOLD) {
		out.push({
			id: 'description-too-short',
			level: 'warn',
			labelKey: 'settings.skillLintShortDescLabel',
			tooltipKey: 'settings.skillLintShortDescTooltip',
		});
	}
	return out;
}

/**
 * Snapshot of the three thresholds that decide which band a similarity
 * score falls into. Captured at the moment a test fires so the result
 * rows reflect the user's *current* settings, not whatever was active
 * when the settings tab was first opened.
 */
interface BandThresholds {
	/** Floor for inclusion in the catalogue at all. */
	filter: number;
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
	const filter = clamp01(
		settings.skillFilterSimilarityThreshold ?? DEFAULT_SKILL_FILTER_SIMILARITY_THRESHOLD,
	);
	const hint = clamp01(
		settings.skillHintThreshold ?? DEFAULT_SKILL_HINT_THRESHOLD,
	);
	const autoInject = Math.max(
		hint,
		clamp01(
			settings.skillAutoInjectThreshold ?? DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
		),
	);
	return { filter, hint, autoInject };
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(1, n));
}

/**
 * Render the trigger-tester result list. Each row shows the skill name,
 * the rounded similarity score, and a tone indicator matching the
 * three-band escalation used by the catalogue at runtime (auto-inject /
 * hint / plain) so users can immediately see *what would happen* with
 * the current query under their current threshold settings.
 */
function renderTesterResults(
	container: HTMLElement,
	scored: Array<{ skill: SkillDefinition; similarity: number }>,
	thresholds: BandThresholds,
): void {
	if (scored.length === 0) {
		container.createEl('div', {
			cls: 'oap-settings-skill-tester-empty',
			text: t('settings.skillTesterNoSkills'),
		});
		return;
	}

	for (const { skill, similarity } of scored) {
		const band = bandForSimilarity(similarity, thresholds);
		const row = container.createEl('div', {
			cls: `oap-settings-skill-tester-result oap-settings-skill-tester-result--${band}`,
		});
		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-name',
			text: skill.name,
		});
		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-sim',
			text: similarity.toFixed(3),
		});
		row.createEl('span', {
			cls: 'oap-settings-skill-tester-result-band',
			text: t(bandLabelKey(band)),
		});
	}
}

type SimilarityBand = 'auto-inject' | 'hint' | 'plain' | 'below-threshold';

function bandForSimilarity(s: number, thresholds: BandThresholds): SimilarityBand {
	if (s >= thresholds.autoInject) return 'auto-inject';
	if (s >= thresholds.hint) return 'hint';
	if (s >= thresholds.filter) return 'plain';
	return 'below-threshold';
}

function bandLabelKey(band: SimilarityBand): string {
	switch (band) {
		case 'auto-inject': return 'settings.skillTesterBandAutoInject';
		case 'hint': return 'settings.skillTesterBandHint';
		case 'plain': return 'settings.skillTesterBandPlain';
		case 'below-threshold': return 'settings.skillTesterBandBelow';
	}
}
