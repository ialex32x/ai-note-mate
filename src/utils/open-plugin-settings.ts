import type { App } from 'obsidian';

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

function getSettingShim(app: App): ObsidianSettingShim | null {
    const a = app as unknown as { setting?: ObsidianSettingShim };
    return a.setting ?? null;
}

/**
 * Open the plugin's settings tab, optionally scrolling to a specific
 * named section. Returns `false` when Obsidian's undocumented
 * `app.setting` API is unavailable (extremely rare, but the API is
 * undocumented so a future refactor could in theory remove it) — the
 * caller decides whether to surface a Notice.
 *
 * The scroll is deferred one frame so Obsidian has finished mounting
 * the tab's DOM (including the anchor nav). Without this the
 * geometry-based scroll math sees stale layout and jumps to the wrong
 * place.
 */
export function openPluginSettings(
    app: App,
    pluginId: string,
    sectionId?: string,
): boolean {
    const setting = getSettingShim(app);
    if (!setting) return false;

    setting.open();
    setting.openTabById(pluginId);

    if (sectionId) {
        window.requestAnimationFrame(() => {
            setting.activeTab?.scrollToSection?.(sectionId);
        });
    }
    return true;
}
