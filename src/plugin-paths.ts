import type { Plugin } from "obsidian";

/**
 * Centralized resolver for plugin-local storage paths.
 *
 * All paths are vault-relative (suitable for `app.vault.adapter` APIs) and
 * rooted at the plugin's own directory under `<configDir>/plugins/<id>/`.
 *
 * Subdirectories are *named by semantic role*, not by storage mechanism:
 * - `sessions/` : user-visible chat session data (list + per-session files).
 *                 Wiping this directory means "forget my conversations".
 * - `cache/`    : derived, rebuildable data (embeddings, etc.).
 *                 Wiping this directory only costs recomputation time.
 *
 * Keep the two roles separate so that future UX features like
 * "clear history" vs "clear cache" can target them independently.
 */
export class PluginPaths {
    /** Vault-relative path to the plugin's own directory. */
    readonly root: string;

    constructor(plugin: Plugin) {
        this.root = plugin.manifest.dir
            ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
    }

    /** Directory for user-owned session data. */
    sessions(): string {
        return `${this.root}/sessions`;
    }

    /** Directory for rebuildable derived caches (embeddings, etc.). */
    cache(): string {
        return `${this.root}/cache`;
    }
}
