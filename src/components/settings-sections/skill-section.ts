import { Notice, setIcon, setTooltip } from "obsidian";
import { t } from "../../i18n";
import { getActiveEmbeddingConfig } from "../../settings";
import { getGlobalEmbedder } from "../../services/embedder";
import { cosineSimilarity } from "../../services/text-embedding";
import {
	SKILL_AUTO_INJECT_THRESHOLD,
	SKILL_HINT_THRESHOLD,
} from "../../skills/skill-catalogue";
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

			// ── Trigger tester (only meaningful when embedding is configured) ──
			//
			// Lets the user paste a hypothetical user query and see the
			// cosine similarity ranking against every loaded skill. The
			// most common authoring complaint is "the AI doesn't pick my
			// skill" — this surface lets users see *why* (poor wording,
			// missing when_to_use, etc.) without leaving the settings
			// view. Rendered before the per-skill list so the input is
			// visible without scrolling on small viewports.
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
	 * Render the "test a trigger" panel. The panel is always shown so
	 * users know the feature exists; when embedding isn't configured we
	 * render a disabled input + explanatory hint instead of silently
	 * omitting it.
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

		const embeddingConfig = getActiveEmbeddingConfig(plugin.settings);
		const embedder = getGlobalEmbedder();
		const ready = Boolean(embeddingConfig && embedder);

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
		if (!ready) {
			queryInput.setAttr('disabled', 'true');
			runBtn.setAttr('disabled', 'true');
			setTooltip(runBtn, t('settings.skillTesterNotReady'));
		}

		const resultsEl = wrap.createEl('div', {
			cls: 'oap-settings-skill-tester-results',
		});

		const runTest = async () => {
			const query = queryInput.value.trim();
			if (!query || !embeddingConfig || !embedder) return;

			runBtn.setAttr('disabled', 'true');
			runBtn.setText(t('settings.skillTesterRunning'));
			resultsEl.empty();

			try {
				const apiKey = plugin.app.secretStorage.getSecret(embeddingConfig.apiKey)
					?? embeddingConfig.apiKey;
				if (!apiKey) {
					new Notice(t('settings.skillTesterNoApiKey'));
					return;
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

				renderTesterResults(resultsEl, scored);
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
 * Render the trigger-tester result list. Each row shows the skill name,
 * the rounded similarity score, and a tone indicator matching the
 * three-band escalation used by the catalogue at runtime (auto-inject /
 * hint / plain) so users can immediately see *what would happen* with
 * the current query.
 */
function renderTesterResults(
	container: HTMLElement,
	scored: Array<{ skill: SkillDefinition; similarity: number }>,
): void {
	if (scored.length === 0) {
		container.createEl('div', {
			cls: 'oap-settings-skill-tester-empty',
			text: t('settings.skillTesterNoSkills'),
		});
		return;
	}

	for (const { skill, similarity } of scored) {
		const band = bandForSimilarity(similarity);
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

function bandForSimilarity(s: number): SimilarityBand {
	if (s >= SKILL_AUTO_INJECT_THRESHOLD) return 'auto-inject';
	if (s >= SKILL_HINT_THRESHOLD) return 'hint';
	if (s >= 0.2) return 'plain';
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
