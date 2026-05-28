import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { hasMcpServersConfigured } from '../../../settings';
import { openPluginSettings } from '../../../utils/open-plugin-settings';
import { TOOLS_SECTION_ID } from '../../../settings/section-ids';
import type { TipDefinition } from '../types';

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
        const ok = openPluginSettings(
            ctx.plugin.app,
            ctx.plugin.manifest.id,
            TOOLS_SECTION_ID,
        );
        if (!ok) {
            new Notice(t('tips.configureMcp.openFailed'));
        }
    },
};
