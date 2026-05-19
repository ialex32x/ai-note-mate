import { Notice } from 'obsidian';
import { t } from '../../../i18n';
import type { TipContext, TipDefinition } from '../types';

/**
 * Anchor id of the Embedding section in the plugin settings tab. Must
 * match the section's `titleKey` (see EmbeddingSettingsSection).
 * Hard-coded rather than imported from the section to keep the tip
 * layer free of UI-layer dependencies.
 */
const EMBEDDING_SECTION_ID = 'settings.embeddingSection';

/**
 * Narrow shim for Obsidian's undocumented `app.setting` API. These two
 * methods are stable across Obsidian versions and used by many
 * community plugins; declared locally so the cast stays minimal and
 * we never lean on `any`.
 *
 * `activeTab` is opaque on purpose — callers identify the right tab
 * structurally (by the optional `scrollToSection` method) rather than
 * importing the concrete class, which would create a circular dep
 * through `settings-tab.ts`.
 */
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
        const setting = getSettingShim(ctx);
        if (!setting) {
            // Defensive: the API is undocumented, so a future Obsidian
            // refactor could in theory remove it. Surface a graceful
            // Notice rather than throwing.
            new Notice(t('tips.enableEmbedding.openFailed'));
            return;
        }
        setting.open();
        setting.openTabById(ctx.plugin.manifest.id);
        // Defer the scroll one frame so Obsidian has finished
        // mounting the tab's DOM (including the anchor nav). Without
        // this the geometry-based scroll math sees stale layout and
        // jumps to the wrong place.
        window.requestAnimationFrame(() => {
            setting.activeTab?.scrollToSection?.(EMBEDDING_SECTION_ID);
        });
    },
};
