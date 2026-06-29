import { type App } from 'obsidian';
import { joinPath } from './path-helper';

/**
 * Resolve a non-colliding filename in `targetDir` for an attachment.
 *
 * If `preferredName` is available the file is kept as-is; otherwise
 * numeric suffixes are appended before the extension, e.g.
 * `photo.png` → `photo-1.png`, `photo-2.png`, …
 *
 * @param targetDir - Normalised vault-relative directory path.
 * @param preferredName - Desired filename (may collide).
 * @param existsCheck - Async function that returns `true` when the
 *   given vault-relative path already exists.
 */
export async function resolveUniqueFilename(
    targetDir: string,
    preferredName: string,
    existsCheck: (path: string) => Promise<boolean>,
): Promise<string> {
    const dotIdx = preferredName.lastIndexOf('.');
    const stem = dotIdx >= 0 ? preferredName.slice(0, dotIdx) : preferredName;
    const ext = dotIdx >= 0 ? preferredName.slice(dotIdx) : '';

    let candidate = preferredName;
    let counter = 1;
    while (await existsCheck(joinPath(targetDir, candidate))) {
        candidate = `${stem}-${counter}${ext}`;
        counter++;
    }
    return candidate;
}

/**
 * Copy a single cached attachment from `cachePath` into `targetDir`.
 *
 * Returns the vault-relative path of the newly created file, or `null`
 * if the cache file is missing or the copy fails.
 *
 * @param app - Obsidian App instance (provides vault adapter).
 * @param cachePath - Vault-relative path to the cached attachment binary.
 * @param targetDir - Normalised vault-relative directory to save into.
 * @param preferredName - Preferred filename (collisions resolved automatically).
 */
export async function copyAttachmentToDir(
    app: App,
    cachePath: string,
    targetDir: string,
    preferredName: string,
): Promise<string | null> {
    try {
        if (!(await app.vault.adapter.exists(cachePath))) {
            console.warn(
                `[attachment-utils] Cache file missing, skipping: ${cachePath}`,
            );
            return null;
        }
        const buf = await app.vault.adapter.readBinary(cachePath);
        const fileName = await resolveUniqueFilename(
            targetDir,
            preferredName,
            async (p) => app.vault.adapter.exists(p),
        );
        const targetPath = joinPath(targetDir, fileName);
        await app.vault.createBinary(targetPath, buf);
        return targetPath;
    } catch (err) {
        console.warn(
            `[attachment-utils] Failed to copy attachment "${cachePath}":`,
            err,
        );
        return null;
    }
}
