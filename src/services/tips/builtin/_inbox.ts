import type { TipContext } from '../types';

/**
 * Narrow shim for Obsidian's undocumented `Vault.getConfig` API. The
 * method has been stable across Obsidian releases and is widely used
 * in the community plugin ecosystem; keeping the cast minimal lets the
 * call sites stay typed without leaning on `any`.
 */
interface VaultConfigShim {
    getConfig?(key: string): unknown;
}

/**
 * Resolve the user's "inbox" folder — semantically, the folder
 * configured as Obsidian's "Default location for new notes" (Settings
 * → Files & links). When that mode is "vault" / "current" / unset, or
 * the configured folder no longer exists, fall back to the vault root.
 *
 * Returns `""` for the vault root, otherwise a normalized folder path
 * (no leading/trailing slashes) that has been confirmed to exist in
 * the vault at call time.
 *
 * Shared by every tip that drops a starter file (`example.base`,
 * `example.canvas`, …) so the resolution rules — and the fallback
 * behaviour — stay consistent across them.
 */
export function resolveInboxFolder(ctx: TipContext): string {
    const vault = ctx.plugin.app.vault as unknown as VaultConfigShim;
    if (vault.getConfig?.('newFileLocation') !== 'folder') return '';
    const raw = vault.getConfig?.('newFileFolderPath');
    if (typeof raw !== 'string') return '';
    const cleaned = raw.trim().replace(/^\/+|\/+$/g, '');
    if (cleaned.length === 0) return '';
    // Defensive: the folder may have been renamed or deleted after the
    // setting was written. Drop back to root rather than baking a
    // stale path into the prompt.
    if (!ctx.plugin.app.vault.getAbstractFileByPath(cleaned)) return '';
    return cleaned;
}

/**
 * Compose a vault-relative path for `filename` placed under the
 * resolved inbox `folder`. Folders are joined with `/`; an empty
 * folder collapses to the bare filename (i.e. vault root).
 */
export function inboxPath(folder: string, filename: string): string {
    return folder.length > 0 ? `${folder}/${filename}` : filename;
}
