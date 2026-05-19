import { t } from '../../../i18n';
import type { TipDefinition } from '../types';

/**
 * Onboarding tip: ask the assistant to walk the user through their vault
 * structure. Pure prompt dispatch — no settings mutation, always
 * available until the user dismisses or runs it once.
 */
export const analyzeVaultStructureTip: TipDefinition = {
    id: 'analyze-vault-structure',
    titleKey: 'tips.analyzeVault.title',
    bodyKey: 'tips.analyzeVault.body',
    available: () => true,
    disqualified: () => false,
    preview: () => ({
        description: t('tips.analyzeVault.previewDesc'),
        prompt: t('tips.analyzeVault.prompt'),
    }),
    execute: async (ctx) => {
        await ctx.sessionView.sendPromptForTip(t('tips.analyzeVault.prompt'));
    },
};
