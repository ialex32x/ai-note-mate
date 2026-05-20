import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { isActiveProfileConfigured } from '../../../settings';
import type { TipContext, TipDefinition } from '../types';

/** Anchor id of the Profile section in the plugin settings tab. */
const PROFILE_SECTION_ID = 'settings.profileSection';

interface ObsidianSettingShim {
    open(): void;
    openTabById(id: string): void;
    activeTab: { scrollToSection?: (id: string) => void } | null | undefined;
}

function getSettingShim(ctx: TipContext): ObsidianSettingShim | null {
    const app = ctx.plugin.app as unknown as { setting?: ObsidianSettingShim };
    return app.setting ?? null;
}

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
        const setting = getSettingShim(ctx);
        if (!setting) {
            new Notice(t('tips.configureProfile.openFailed'));
            return;
        }
        setting.open();
        setting.openTabById(ctx.plugin.manifest.id);
        window.requestAnimationFrame(() => {
            setting.activeTab?.scrollToSection?.(PROFILE_SECTION_ID);
        });
    },
};
