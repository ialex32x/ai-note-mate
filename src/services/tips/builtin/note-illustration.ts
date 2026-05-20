import { t } from '../../../i18n';
import { isActiveImageGenConfigured } from '../../../settings';
import type { TipContext, TipDefinition } from '../types';
import { activeNoteLacksImageEmbed, getActiveMarkdownFile } from './_active-note';
import { isPromptInputEmpty } from './_input';

function isNoteIllustrationTipEligible(ctx: TipContext): boolean {
    if (!isPromptInputEmpty(ctx)) return false;
    if (!isActiveImageGenConfigured(ctx.plugin.app, ctx.plugin.settings)) return false;
    if (!getActiveMarkdownFile(ctx.plugin.app)) return false;
    if (!activeNoteLacksImageEmbed(ctx.plugin.app)) return false;
    return true;
}

/**
 * Suggest generating a cover illustration for the note currently open in
 * the editor. "Try it" parks a starter prompt in the input box (no
 * confirmation step).
 */
export const noteIllustrationTip: TipDefinition = {
    id: 'note-illustration',
    titleKey: 'tips.noteIllustration.title',
    bodyKey: 'tips.noteIllustration.body',
    available: (ctx) => isNoteIllustrationTipEligible(ctx),
    disqualified: (ctx) => !isNoteIllustrationTipEligible(ctx),
    execute: async (ctx) => {
        const file = getActiveMarkdownFile(ctx.plugin.app);
        if (!file) return;
        const prompt = t('tips.noteIllustration.prompt', { name: file.name });
        ctx.sessionView.fillPromptDraft(prompt);
    },
};
