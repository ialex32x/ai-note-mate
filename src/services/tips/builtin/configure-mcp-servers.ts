import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { hasMcpServersConfigured } from '../../../settings';
import type { TipContext, TipDefinition } from '../types';

/** Anchor id of the MCP section in the plugin settings tab. */
const MCP_SECTION_ID = 'settings.mcpServers';

interface ObsidianSettingShim {
    open(): void;
    openTabById(id: string): void;
    activeTab: { scrollToSection?: (id: string) => void } | null | undefined;
}

function getSettingShim(ctx: TipContext): ObsidianSettingShim | null {
    const app = ctx.plugin.app as unknown as { setting?: ObsidianSettingShim };
    return app.setting ?? null;
}

/**
 * Onboarding tip: guide the user to add MCP servers so external tools
 * can be exposed to the assistant. "Try it" opens Settings → MCP Servers
 * with no confirmation step — the action is harmless and self-explanatory.
 */
export const configureMcpServersTip: TipDefinition = {
    id: 'configure-mcp-servers',
    titleKey: 'tips.configureMcp.title',
    bodyKey: 'tips.configureMcp.body',
    available: (ctx) => !hasMcpServersConfigured(ctx.plugin.settings),
    disqualified: (ctx) => hasMcpServersConfigured(ctx.plugin.settings),
    execute: async (ctx) => {
        const setting = getSettingShim(ctx);
        if (!setting) {
            new Notice(t('tips.configureMcp.openFailed'));
            return;
        }
        setting.open();
        setting.openTabById(ctx.plugin.manifest.id);
        window.requestAnimationFrame(() => {
            setting.activeTab?.scrollToSection?.(MCP_SECTION_ID);
        });
    },
};
