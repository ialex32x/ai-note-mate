

import { normalizePath, type App } from 'obsidian';

/**
 * Joins path segments and normalizes the result.
 * Uses Obsidian's normalizePath for cross-platform compatibility.
 * @param paths - Path segments to join
 * @returns Normalized path with forward slashes
 */
export function joinPath(...paths: string[]): string {
    return normalizePath(paths.filter(p => p.length > 0).join('/'));
}

/**
 * Narrow view of `app.vault.adapter` exposing the desktop-only `basePath`.
 *
 * Obsidian's official `DataAdapter` interface does not declare `basePath`,
 * but `FileSystemAdapter` (desktop) does. We only ever read it, never write,
 * and treat its absence as "we're on mobile / unknown adapter" — falling
 * back to vault-name heuristics instead.
 */
interface AdapterWithBasePath {
    basePath?: string;
}

/**
 * Resolve an Obsidian `app://...` resource URL to a vault-relative path.
 *
 * Obsidian renders local images / attachments through internal `app://<host>/<absolute-fs-path>?<rev>`
 * URLs. To map one back to a vault path (e.g. for "Reveal in file explorer"
 * or "Open in tab"), we need to strip the absolute filesystem prefix.
 *
 * Strategy:
 *   1. Match the URL shape and decode the path component.
 *   2. If the desktop adapter exposes `basePath`, strip that prefix.
 *   3. Otherwise (mobile / unknown adapter), fall back to locating the
 *      vault folder name inside the absolute path.
 *
 * @returns The vault-relative path (with leading slashes stripped), or
 *   `null` if the URL is not an `app://` resource URL or the vault could
 *   not be located inside it.
 */
export function resolveAppUrlToVaultPath(app: App, url: string): string | null {
    if (!url) return null;
    const match = url.match(/^app:\/\/[^/]+\/(.+?)(?:\?\d+)?$/);
    if (!match || !match[1]) return null;

    const absolutePath = decodeURIComponent(match[1]);
    const adapter = app.vault.adapter as AdapterWithBasePath;
    const vaultBasePath = adapter.basePath;

    if (vaultBasePath && absolutePath.startsWith(vaultBasePath)) {
        return absolutePath.slice(vaultBasePath.length).replace(/^[/\\]+/, '');
    }

    const vaultName = app.vault.getName();
    const vaultNameIndex = absolutePath.lastIndexOf(vaultName);
    if (vaultNameIndex !== -1) {
        return absolutePath.slice(vaultNameIndex + vaultName.length).replace(/^[/\\]+/, '');
    }

    return null;
}
