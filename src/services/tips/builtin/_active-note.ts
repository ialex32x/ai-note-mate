import type { App } from 'obsidian';
import { MarkdownView, TFile } from 'obsidian';

/** Markdown note currently focused in the workspace, if any. */
export function getActiveMarkdownFile(app: App): TFile | null {
    const file = app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return null;
    return file;
}

/**
 * Best-effort synchronous read of an open note body from any markdown leaf
 * that already has the file loaded in an editor.
 */
function readNoteContentSync(app: App, file: TFile): string | null {
    const active = app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === file.path) {
        return active.editor.getValue();
    }
    for (const leaf of app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === file.path) {
            return view.editor.getValue();
        }
    }
    return null;
}

/** True when body likely contains an image embed (`![[...]]` or `![...](...)`). */
export function noteBodyHasImageEmbed(content: string): boolean {
    return content.includes('![');
}

let cachedPath: string | undefined;
let cachedHasImage: boolean | undefined;

export function invalidateActiveNoteImageCache(): void {
    cachedPath = undefined;
    cachedHasImage = undefined;
}

/**
 * Refresh the cached image-embed flag for the active markdown note. Uses an
 * open editor when available, otherwise falls back to `vault.cachedRead`.
 */
export async function warmActiveNoteImageCache(app: App): Promise<void> {
    const file = getActiveMarkdownFile(app);
    if (!file) {
        invalidateActiveNoteImageCache();
        return;
    }

    let content = readNoteContentSync(app, file);
    if (content === null) {
        try {
            content = await app.vault.cachedRead(file);
        } catch {
            invalidateActiveNoteImageCache();
            return;
        }
    }

    cachedPath = file.path;
    cachedHasImage = noteBodyHasImageEmbed(content);
}

/**
 * True when the active markdown note has no image embeds. Returns false when
 * there is no active markdown file or content cannot be resolved yet.
 */
export function activeNoteLacksImageEmbed(app: App): boolean {
    const file = getActiveMarkdownFile(app);
    if (!file) return false;

    if (cachedPath === file.path && cachedHasImage !== undefined) {
        return !cachedHasImage;
    }

    const content = readNoteContentSync(app, file);
    if (content === null) return false;
    return !noteBodyHasImageEmbed(content);
}
