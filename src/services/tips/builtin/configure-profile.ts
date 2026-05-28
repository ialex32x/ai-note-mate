import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { isActiveProfileConfigured } from '../../../settings';
import { openPluginSettings } from '../../../utils/open-plugin-settings';
import { PROFILE_SECTION_ID } from '../../../settings/section-ids';
import type { TipContext, TipDefinition } from '../types';

function isProfileUsable(ctx: TipContext): boolean {
    return isActiveProfileConfigured(ctx.plugin.app, ctx.plugin.settings);
}

/**
 * Onboarding tip: guide the user to fill in Base URL, model, and API key on
 * the active Profile. "Try it" opens Settings → Profile with no confirmation
 * step — the action is harmless and self-explanatory.
 */
export const configureProfileTip: TipDefinition = {
    id: 'configure-profile',
    titleKey: 'tips.configureProfile.title',
    bodyKey: 'tips.configureProfile.body',
    available: (ctx) => !isProfileUsable(ctx),
    disqualified: (ctx) => isProfileUsable(ctx),
    execute: async (ctx) => {
        const ok = openPluginSettings(
            ctx.plugin.app,
            ctx.plugin.manifest.id,
            PROFILE_SECTION_ID,
        );
        if (!ok) {
            new Notice(t('tips.configureProfile.openFailed'));
        }
    },
};
