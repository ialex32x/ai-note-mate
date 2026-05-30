import { App, TFile, TFolder, TAbstractFile } from 'obsidian';

/**
 * Strip a heading reference (`#…`) or block reference (`^…`) suffix from a
 * wikilink path so the remaining portion can be resolved to a vault file.
 */
export function stripHeadingBlockRef(linkText: string): string {
    const hashIdx = linkText.indexOf('#');
    const caretIdx = linkText.indexOf('^');
    if (hashIdx >= 0 && caretIdx >= 0) {
        return linkText.slice(0, Math.min(hashIdx, caretIdx));
    }
    if (hashIdx >= 0) return linkText.slice(0, hashIdx);
    if (caretIdx >= 0) return linkText.slice(0, caretIdx);
    return linkText;
}

/**
 * Resolve a wikilink target to a vault file/folder, combining Obsidian's
 * metadata cache lookup with our extension-aware path resolver.
 */
export function resolveLinkTarget(app: App, linkText: string): TAbstractFile | null {
    const pathOnly = stripHeadingBlockRef(linkText);
    const dest = app.metadataCache.getFirstLinkpathDest(pathOnly, '');
    if (dest) return dest;

    const ref = resolveFileRef(app, pathOnly);
    if (!ref) return null;
    return app.vault.getAbstractFileByPath(ref.path);
}

/**
 * Best-effort wikilink text to pass to `openLinkText`, preserving any
 * heading/block suffix while substituting a resolved vault path when found.
 */
export function resolveLinkOpenText(app: App, linkText: string): string {
    const pathOnly = stripHeadingBlockRef(linkText);
    const suffix = linkText.slice(pathOnly.length);
    const target = resolveLinkTarget(app, linkText);
    return target ? target.path + suffix : linkText;
}

function resolveExtensionlessPathInParent(app: App, path: string): TAbstractFile | null {
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash < 0) return null;

    const parentPath = path.slice(0, lastSlash);
    const name = path.slice(lastSlash + 1);
    if (!name || name.includes('.')) return null;

    const parent = app.vault.getAbstractFileByPath(parentPath);
    if (!(parent instanceof TFolder)) return null;

    let foundFile: TAbstractFile | null = null;
    let foundFolder: TAbstractFile | null = null;
    let matchCount = 0;

    for (const child of parent.children) {
        if (child instanceof TFile && child.basename === name) {
            matchCount++;
            foundFile = child;
        } else if (child instanceof TFolder && child.name === name) {
            matchCount++;
            foundFolder = child;
        }
    }

    if (matchCount !== 1) return null;
    return foundFile ?? foundFolder;
}

/**
 * Obsidian's public types don't expose this internal view field, but it is
 * stable across versions and is the canonical way to ask the file-explorer
 * to scroll to / highlight a node (`revealInFolder`).
 *
 * We narrow once here so callers stay typed without `as any`.
 */
interface FileExplorerLeafView {
    revealInFolder?: (target: TAbstractFile) => void;
}

/**
 * Result of resolving a file reference path.
 */
export interface ResolvedFileRef {
    /** The resolved absolute path in the vault */
    path: string;
    /** Whether the resolved item is a folder */
    isFolder: boolean;
    /** Whether this was a short link (no path separators in original) */
    isShortLink: boolean;
}

/**
 * Resolve a file reference path that may be a short link (filename only).
 *
 * - If path contains path separators (/), treats it as a full path and returns the file if it exists.
 * - If path is just a filename (no /), searches the entire vault for unique matches.
 * - When both a file and folder have the same name, files take priority.
 *
 * @param app - The Obsidian app instance
 * @param path - The file reference path (may be a short link)
 * @returns ResolvedFileRef if found and unique, null otherwise
 */
export function resolveFileRef(app: App, path: string): ResolvedFileRef | null {
    // If path contains path separators, treat as full path
    if (path.includes('/')) {
        let file = app.vault.getAbstractFileByPath(path);
        // Obsidian wikilinks may omit the .md extension; try appending it
        // as a fallback when the exact path is not found.
        if (!file) {
            file = app.vault.getAbstractFileByPath(path + '.md');
        }
        // Extensionless paths like `Inbox/Generic Base` may refer to
        // `.base`, `.canvas`, etc. — match by basename within the parent.
        if (!file) {
            file = resolveExtensionlessPathInParent(app, path);
        }
        if (file) {
            return {
                path: file.path,
                isFolder: file instanceof TFolder,
                isShortLink: false,
            };
        }
        return null;
    }

    // Short link: search by filename only (without extension for files)
    const fileName = path;
    let foundFile: TAbstractFile | null = null;
    let foundFolder: TAbstractFile | null = null;
    let foundCount = 0;

    // Search all files in the vault
    for (const file of app.vault.getAllLoadedFiles()) {
        // For TFile, use basename without extension for matching
        const baseName = file instanceof TFile
            ? file.basename.toLowerCase()
            : file.name.toLowerCase();
        // Also check the full name (with extension) for folder matching
        const fullName = file.name.toLowerCase();

        // Match by basename (files) or full name (folders), case-insensitive
        if (baseName === fileName.toLowerCase() || fullName === fileName.toLowerCase()) {
            foundCount++;
            if (file instanceof TFile) {
                foundFile = file;
            } else if (file instanceof TFolder) {
                foundFolder = file;
            }
        }
    }

    // Only return if exactly one match found
    if (foundCount === 1) {
        const resolved = foundFile ?? foundFolder;
        if (resolved) {
            return {
                path: resolved.path,
                isFolder: resolved instanceof TFolder,
                isShortLink: true,
            };
        }
    }

    // Multiple matches or no match - can't resolve unambiguously
    return null;
}

/**
 * Check if a file reference path exists in the vault.
 * Supports both full paths and short links (filename-only references).
 *
 * @param app - The Obsidian app instance
 * @param path - The file reference path
 * @returns true if the file/folder exists and is unique
 */
export function fileRefExists(app: App, path: string): boolean {
    return resolveFileRef(app, path) !== null;
}

/**
 * Reveal a folder in the file explorer navigation panel.
 */
export function revealInNavigation(app: App, target: TFile | TFolder): void {
    const explorerLeaf = app.workspace.getLeavesOfType('file-explorer')[0];
    if (explorerLeaf?.view) {
        (explorerLeaf.view as FileExplorerLeafView).revealInFolder?.(target);
    }
}
