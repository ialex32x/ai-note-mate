import { Modal, setTooltip } from "obsidian";
import { t } from "../../i18n";
import type { SkillDefinition } from "../../skills/skill-loader";

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

/**
 * Modal that displays the full list of loaded skills with their name,
 * location, lint badges, description, and whenToUse. Disabled skills
 * are dimmed and marked with a badge.
 */
export class SkillDetailsModal extends Modal {
	constructor(
		app: import('obsidian').App,
		private readonly skills: SkillDefinition[],
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('oap-skill-details-modal');

		this.setTitle(t('settings.skillDetailsTitle'));

		const listEl = contentEl.createEl('div', {
			cls: 'oap-settings-skill-list',
		});
		for (const skill of this.skills) {
			const itemEl = listEl.createEl('div', {
				cls: 'oap-settings-skill-item',
			});
			if (skill.disabled) {
				itemEl.addClass('oap-settings-skill-item--disabled');
			}
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
			// Collect all badges: lints first, then disabled status
			type Badge = { cls: string; label: string; tooltip: string };
			const badges: Badge[] = [];
			for (const lint of lints) {
				badges.push({
					cls: `oap-settings-skill-badge oap-settings-skill-badge--${lint.level}`,
					label: t(lint.labelKey),
					tooltip: t(lint.tooltipKey),
				});
			}
			if (skill.disabled) {
				badges.push({
					cls: 'oap-settings-skill-badge oap-settings-skill-badge--disabled',
					label: t('settings.skillDisabledBadge'),
					tooltip: t('settings.skillDisabledBadgeTooltip'),
				});
			}
			if (badges.length > 0) {
				const badgeRow = itemEl.createEl('div', {
					cls: 'oap-settings-skill-badges',
				});
				for (const b of badges) {
					const badge = badgeRow.createEl('span', {
						cls: b.cls,
						text: b.label,
					});
					setTooltip(badge, b.tooltip);
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

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.removeClass('oap-skill-details-modal');
	}
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
