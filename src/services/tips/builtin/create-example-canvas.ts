import { t } from '../../../i18n';
import type { TipDefinition } from '../types';
import { inboxPath, resolveInboxFolder } from './_inbox';
import { isPromptInputEmpty } from './_input';

const EXAMPLE_CANVAS_FILENAME = 'example.canvas';

/**
 * Onboarding tip: introduce Obsidian's Canvas feature with a concrete
 * starter file (`example.canvas`) that lays out a small visual map of
 * the vault — a central title card surrounded by group nodes per
 * top-level folder, each holding a couple of recently-modified notes,
 * connected to the centre with edges. The location tracks the user's
 * "Default location for new notes" config (the closest thing to an
 * "inbox" Obsidian exposes), falling back to the vault root.
 *
 * Shown while the chat input is empty until the user runs or dismisses
 * it. We don't gate on existing `.canvas` files — a "vault overview"
 * canvas is often useful even when the user already has other canvases.
 *
 * Like the Bases tip, the prompt is parked in the input editor via
 * `fillPromptDraft` rather than submitted directly. Canvas layouts
 * tend to need user-specific tweaks (which folders to include, how
 * many notes per group, etc.), and a manual review step makes that
 * easy without forcing a re-run.
 */
export const createExampleCanvasTip: TipDefinition = {
    id: 'create-example-canvas',
    titleKey: 'tips.createExampleCanvas.title',
    bodyKey: 'tips.createExampleCanvas.body',
    available: (ctx) => isPromptInputEmpty(ctx),
    disqualified: (ctx) => !isPromptInputEmpty(ctx),
    preview: (ctx) => {
        const target = inboxPath(resolveInboxFolder(ctx), EXAMPLE_CANVAS_FILENAME);
        return {
            description: t('tips.createExampleCanvas.previewDesc', { path: target }),
            prompt: t('tips.createExampleCanvas.prompt', { path: target }),
        };
    },
    execute: async (ctx) => {
        const target = inboxPath(resolveInboxFolder(ctx), EXAMPLE_CANVAS_FILENAME);
        ctx.sessionView.fillPromptDraft(t('tips.createExampleCanvas.prompt', { path: target }));
    },
};
