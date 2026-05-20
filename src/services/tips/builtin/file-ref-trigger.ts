import { t } from '../../../i18n';
import type { TipDefinition } from '../types';
import { isPromptInputEmpty } from './_input';

/**
 * Onboarding tip: teach that typing `[[` in the chat input opens the
 * file-reference picker (same as the @ toolbar button). "Try it" parks a
 * starter prompt ending with `[[` so the user can pick a note and send.
 */
export const fileRefTriggerTip: TipDefinition = {
    id: 'file-ref-trigger',
    titleKey: 'tips.fileRefTrigger.title',
    bodyKey: 'tips.fileRefTrigger.body',
    available: (ctx) => isPromptInputEmpty(ctx),
    disqualified: (ctx) => !isPromptInputEmpty(ctx),
    execute: async (ctx) => {
        const filled = ctx.sessionView.fillPromptDraft(t('tips.fileRefTrigger.draft'));
        if (!filled) return;
        // Defer one frame so setContent + popover teardown finish before
        // CodeMirror runs startCompletion (same rAF deferral as @ button).
        window.requestAnimationFrame(() => {
            ctx.sessionView.triggerFileRefSuggest();
        });
    },
};
