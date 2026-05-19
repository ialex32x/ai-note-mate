import { t } from '../../../i18n';
import type { TipContext, TipDefinition } from '../types';

/**
 * Default directory we add to `skillSearchPaths` when the user accepts
 * this tip. Matches the placeholder used in the Skills settings section
 * so the seeded path looks the same as one the user would type by hand.
 */
const DEFAULT_SKILL_DIR = 'Skills';

function hasConfiguredSkillPath(ctx: TipContext): boolean {
    return ctx.plugin.settings.skillSearchPaths
        .filter(p => p.trim().length > 0)
        .length > 0;
}

/**
 * Onboarding tip: seed the user's first skill. The execute flow adds
 * the `Skills` directory to `skillSearchPaths`, reloads the skill
 * catalogue, then submits a prompt asking the assistant to author a
 * starter skill (the "list orphan non-note files" example, generalised
 * for any user vault).
 *
 * Hidden once the user has any non-empty skill path configured — that's
 * the "I already know about skills" signal we use to keep the tip from
 * nagging existing users.
 */
export const createFirstSkillTip: TipDefinition = {
    id: 'create-first-skill',
    titleKey: 'tips.createFirstSkill.title',
    bodyKey: 'tips.createFirstSkill.body',
    available: (ctx) => !hasConfiguredSkillPath(ctx),
    disqualified: (ctx) => hasConfiguredSkillPath(ctx),
    preview: () => ({
        description: t('tips.createFirstSkill.previewDesc'),
        settingsChanges: [
            {
                label: t('tips.createFirstSkill.settingsLabel'),
                after: DEFAULT_SKILL_DIR,
            },
        ],
        prompt: t('tips.createFirstSkill.prompt'),
    }),
    execute: async (ctx) => {
        const paths = ctx.plugin.settings.skillSearchPaths;
        // Defensive: if a path somehow got added between preview and
        // execute (e.g. user opened settings in another tab), skip the
        // settings mutation but still send the prompt — the prompt is
        // still useful when at least one search path exists.
        if (!paths.includes(DEFAULT_SKILL_DIR)) {
            paths.push(DEFAULT_SKILL_DIR);
            await ctx.plugin.saveSettings();
            await ctx.plugin.reloadSkills();
        }
        await ctx.sessionView.sendPromptForTip(t('tips.createFirstSkill.prompt'));
    },
};
