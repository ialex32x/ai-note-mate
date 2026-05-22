import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import { openPluginSettings } from '../../../utils/open-plugin-settings';
import type { TipContext, TipDefinition } from '../types';

/**
 * Anchor id of the Embedding section in the plugin settings tab. Must
 * match the section's `titleKey` (see EmbeddingSettingsSection).
 * Hard-coded rather than imported from the section to keep the tip
 * layer free of UI-layer dependencies.
 */
const EMBEDDING_SECTION_ID = 'settings.embeddingSection';

/**
 * True when embedding-based tool filtering can already kick in for the
 * user's next turn: the feature is enabled AND the active config has a
 * non-empty API key. Treat any "not yet usable" state (disabled, or no
 * key) as eligible for the tip — those are the users who would
 * benefit most from the explanation.
 */
function isEmbeddingFilterUsable(ctx: TipContext): boolean {
    const s = ctx.plugin.settings;
    if (!s.embeddingEnabled) return false;
    if (s.embeddingConfigs.length === 0) return false;
    const active = s.embeddingConfigs.find(c => c.id === s.activeEmbeddingId)
        ?? s.embeddingConfigs[0]!;
    return (active.apiKey?.trim().length ?? 0) > 0;
}

/**
 * Onboarding tip: explain that embedding powers per-turn on-demand
 * tool filtering (and skill ranking), which trims the schema list sent
 * to the model on each turn — saving tokens and reducing latency,
 * especially on smaller-context models. "Try it" opens Settings →
 * Embedding so the user can enable the feature and fill in an API key.
 *
 * Intentionally omits `preview`: the only side effect is opening a
 * settings panel, which is harmless and self-explanatory. A
 * confirmation step here would feel like busywork — the popover body
 * already tells the user where the button leads.
 */
export const enableEmbeddingFilterTip: TipDefinition = {
    id: 'enable-embedding-filter',
    titleKey: 'tips.enableEmbedding.title',
    bodyKey: 'tips.enableEmbedding.body',
    available: (ctx) => !isEmbeddingFilterUsable(ctx),
    disqualified: (ctx) => isEmbeddingFilterUsable(ctx),
    execute: async (ctx) => {
        const ok = openPluginSettings(
            ctx.plugin.app,
            ctx.plugin.manifest.id,
            EMBEDDING_SECTION_ID,
        );
        if (!ok) {
            // Defensive: the API is undocumented, so a future Obsidian
            // refactor could in theory remove it. Surface a graceful
            // Notice rather than throwing.
            new Notice(t('tips.enableEmbedding.openFailed'));
        }
    },
};
