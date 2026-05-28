import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { isActiveProfileConfigured } from '../../../settings';
import { openPluginSettings } from '../../../utils/open-plugin-settings';
import { TEXT_GEN_SECTION_ID } from '../../../settings/section-ids';
import type { TipContext, TipDefinition } from '../types';

function isTextGenAvailable(ctx: TipContext): boolean {
    return isActiveProfileConfigured(ctx.plugin.app, ctx.plugin.settings);
}

/**
 * Onboarding tip: guide the user to fill in Base URL, model, and API key on
 * the active Profile. "Try it" opens Settings → Profile with no confirmation
 * step — the action is harmless and self-explanatory.
 */
export const configureTextGenTip: TipDefinition = {
    id: 'configure-text-gen',
    titleKey: 'tips.configureTextGen.title',
    bodyKey: 'tips.configureTextGen.body',
    available: (ctx) => !isTextGenAvailable(ctx),
    disqualified: (ctx) => isTextGenAvailable(ctx),
    execute: async (ctx) => {
        const ok = openPluginSettings(
            ctx.plugin.app,
            ctx.plugin.manifest.id,
            TEXT_GEN_SECTION_ID,
        );
        if (!ok) {
            new Notice(t('tips.configureTextGen.openFailed'));
        }
    },
};
