import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { isActiveImageGenConfigured } from '../../../settings';
import { openPluginSettings } from '../../../utils/open-plugin-settings';
import { IMAGE_GEN_SECTION_ID } from '../../../settings/section-ids';
import type { TipDefinition } from '../types';

/**
 * Onboarding tip: guide the user to set up an image generation provider
 * (API scheme, key, model) so the text-to-image tool becomes available.
 * "Try it" opens Settings → Image with no confirmation step — the action
 * is harmless and self-explanatory.
 */
export const configureImageGenTip: TipDefinition = {
    id: 'configure-image-gen',
    titleKey: 'tips.configureImageGen.title',
    bodyKey: 'tips.configureImageGen.body',
    available: (ctx) => !isActiveImageGenConfigured(ctx.plugin.app, ctx.plugin.settings),
    disqualified: (ctx) => isActiveImageGenConfigured(ctx.plugin.app, ctx.plugin.settings),
    execute: async (ctx) => {
        const ok = openPluginSettings(
            ctx.plugin.app,
            ctx.plugin.manifest.id,
            IMAGE_GEN_SECTION_ID,
        );
        if (!ok) {
            new Notice(t('tips.configureImageGen.openFailed'));
        }
    },
};
