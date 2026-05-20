import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { MemoryStoreError } from '../../memory';
import type { TipContext, TipDefinition } from '../types';

/**
 * Onboarding tip: seed the memory note.
 *
 * Conditions for surfacing:
 *   - Memory feature is enabled.
 *   - A memory note path is configured (non-empty after trim).
 *   - The configured path does NOT currently resolve to an existing
 *     file (folder collision or simple "not yet created").
 *
 * Try-it flow goes through the standard preview/confirm gate. On
 * confirm we hand off to {@link MemoryStore.upsert} — which internally
 * calls {@link MemoryStore.ensureFile} so the note is created from the
 * default template, then the seed entry is appended below that intro.
 * Doing both in one `upsert` call (rather than `ensureFile` + a
 * separate write) keeps the work serialised on the store's write
 * mutex and means a partially-created file can never linger.
 *
 * The seeded entry is intentionally crafted as a SELF-DOCUMENTING
 * example: it's a critical (`[!]`) memory whose body contains an
 * Obsidian callout demonstrating how users can annotate entries with
 * notes that the assistant never sees. The placeholder line below the
 * callout shows what an actual model-visible body looks like (and
 * tells the model the user hasn't filled in identity info yet, so it
 * is encouraged to ask in upcoming turns).
 */

/** Logical heading of the seed entry. Localised — users see this in their note. */
const SEED_HEADING_KEY = 'tips.seedMemoryNote.entryHeading';
/** Multi-line body of the seed entry, including the callout annotation. */
const SEED_BODY_KEY = 'tips.seedMemoryNote.entryBody';

function memoryPath(ctx: TipContext): string {
    return ctx.plugin.settings.memoryNotePath?.trim() ?? '';
}

function shouldOffer(ctx: TipContext): boolean {
    // All three gates must be satisfied: feature on, path set, file
    // absent. We deliberately use `findFile()` (read-only lookup)
    // instead of `ensureFile()` here — checking eligibility must
    // NEVER have the side effect of creating the file.
    if (!ctx.plugin.settings.memoryEnabled) return false;
    if (!memoryPath(ctx)) return false;
    return ctx.plugin.memoryStore.findFile() === null;
}

export const seedMemoryNoteTip: TipDefinition = {
    id: 'seed-memory-note',
    titleKey: 'tips.seedMemoryNote.title',
    bodyKey: 'tips.seedMemoryNote.body',
    available: shouldOffer,
    disqualified: (ctx) => !shouldOffer(ctx),
    preview: (ctx) => ({
        // Per spec the preview blurb is intentionally minimal: it
        // tells the user *what* will be created and *where*, and
        // nothing else. Detailed feature explanation lives in
        // `body` already so the confirm step stays scannable.
        description: t('tips.seedMemoryNote.previewDesc', { path: memoryPath(ctx) }),
    }),
    execute: async (ctx) => {
        const heading = t(SEED_HEADING_KEY);
        const body = t(SEED_BODY_KEY);
        try {
            // `upsert` → `ensureFile` will lay down the default
            // template, then the entry is appended below that intro.
            // `critical: true` puts the [!] marker on the heading so
            // the entry is injected on every turn — matching the
            // "this is what a critical memory looks like" framing of
            // the seed content.
            await ctx.plugin.memoryStore.upsert(heading, true, body);
        } catch (err) {
            // Surface the user-facing path so the failure is
            // actionable (most failures here are "configured path
            // already collides with a folder").
            const msg = err instanceof MemoryStoreError ? err.message : String(err);
            new Notice(t('tips.seedMemoryNote.failed', { msg }));
            // Re-throw so the tip framework's "execution failed"
            // handler also logs to the dev console — keeps debugging
            // consistent with other tips.
            throw err;
        }
        new Notice(t('settings.memoryCreated', { path: memoryPath(ctx) }));

        // Open the freshly seeded note in a NEW tab (the `true`
        // third arg → `openInNewLeaf`) so the user can immediately
        // skim the template + seed entry, without disturbing the
        // note they currently have focused. `findFile()` is a cheap
        // synchronous lookup; after a successful upsert it always
        // returns a TFile, but we still null-guard in case the user
        // (or another plugin) yanked the file between writes.
        const file = ctx.plugin.memoryStore.findFile();
        if (file) {
            await ctx.plugin.app.workspace.openLinkText(file.path, '', true);
        }
    },
};
