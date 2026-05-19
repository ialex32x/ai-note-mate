import { t } from '../../../i18n';
import type { TipDefinition } from '../types';
import { inboxPath, resolveInboxFolder } from './_inbox';

const EXAMPLE_BASE_FILENAME = 'example.base';

/**
 * Onboarding tip: introduce Obsidian's Bases feature with a concrete
 * starter file (`example.base`) that filters to "orphan small notes"
 * — Markdown notes with no incoming links, under 5 KB. The location
 * tracks the user's "Default location for new notes" config (the
 * closest thing to an "inbox" Obsidian exposes), falling back to the
 * vault root.
 *
 * Always available until the user runs or dismisses it: even users
 * with existing `.base` files often welcome a fresh "list orphan
 * small notes" base as a maintenance helper, so we don't gate on the
 * presence of other base files.
 *
 * Unlike create-first-skill (which submits the prompt directly), this
 * tip parks the prompt in the input editor via `fillPromptDraft`, so
 * the user can review and tweak the request — Bases syntax can vary
 * by version and people often want to adjust thresholds or columns
 * before sending.
 */
export const createExampleBaseTip: TipDefinition = {
    id: 'create-example-base',
    titleKey: 'tips.createExampleBase.title',
    bodyKey: 'tips.createExampleBase.body',
    available: () => true,
    disqualified: () => false,
    preview: (ctx) => {
        const target = inboxPath(resolveInboxFolder(ctx), EXAMPLE_BASE_FILENAME);
        return {
            description: t('tips.createExampleBase.previewDesc', { path: target }),
            prompt: t('tips.createExampleBase.prompt', { path: target }),
        };
    },
    execute: async (ctx) => {
        const target = inboxPath(resolveInboxFolder(ctx), EXAMPLE_BASE_FILENAME);
        ctx.sessionView.fillPromptDraft(t('tips.createExampleBase.prompt', { path: target }));
    },
};
