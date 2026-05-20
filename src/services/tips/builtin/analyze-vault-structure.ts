import { t } from '../../../i18n';
import type { TipDefinition } from '../types';
import { isPromptInputEmpty } from './_input';

/**
 * Onboarding tip: ask the assistant to walk the user through their vault
 * structure. The prompt is parked in the input editor via `fillPromptDraft`
 * so the user can review before sending. Shown only while the chat input
 * is empty, until the user runs or dismisses the tip once.
 */
export const analyzeVaultStructureTip: TipDefinition = {
    id: 'analyze-vault-structure',
    titleKey: 'tips.analyzeVault.title',
    bodyKey: 'tips.analyzeVault.body',
    available: (ctx) => isPromptInputEmpty(ctx),
    disqualified: (ctx) => !isPromptInputEmpty(ctx),
    preview: () => ({
        description: t('tips.analyzeVault.previewDesc'),
        prompt: t('tips.analyzeVault.prompt'),
    }),
    execute: async (ctx) => {
        ctx.sessionView.fillPromptDraft(t('tips.analyzeVault.prompt'));
    },
};
