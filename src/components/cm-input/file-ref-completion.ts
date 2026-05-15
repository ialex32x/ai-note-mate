/**
 * File Reference Completion Source for CodeMirror 6.
 *
 * Provides autocompletion for file references when typing [[.
 */

import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { App, FileView, TAbstractFile, TFile, TFolder } from 'obsidian';

/**
 * Create a completion source for file references.
 */
export function fileRefCompletionSource(app: App) {
    return (context: CompletionContext): CompletionResult | null => {
        const doc = context.state.doc.toString();
        const pos = context.pos;

        // Look backwards for [[ trigger
        let triggerStart = -1;
        for (let i = pos - 1; i >= 0; i--) {
            const char = doc[i];
            if (char === ']' && i > 0 && doc[i - 1] === ']') {
                // Found closing ]], stop looking
                break;
            }
            if (char === '[' && i > 0 && doc[i - 1] === '[') {
                triggerStart = i - 1;
                break;
            }
            // Stop at newline or other break characters
            if (char === '\n' || char === ' ' || char === '\t') {
                break;
            }
        }

        if (triggerStart === -1) {
            return null;
        }

        // Get the content between [[ and cursor position
        const afterTrigger = doc.slice(triggerStart + 2, pos);

        // Check if there's already ]] before cursor (meaning we're outside a ref)
        // Note: ]] after cursor (auto-inserted by closeBrackets) is OK
        if (afterTrigger.includes(']]')) {
            return null;
        }

        // Get the partial path typed so far
        const partialPath = afterTrigger.toLowerCase();
        const files = getAllFiles(app);

        // Filter files by partial path
        const filteredFiles = files.filter(f =>
            f.path.toLowerCase().includes(partialPath) ||
            f.name.toLowerCase().includes(partialPath)
        );

        // Get active file and opened files for sorting priority
        const activeFile = app.workspace.getActiveFile();
        const openedFiles = getOpenedFiles(app);

        // Helper function to calculate boost score for a file
        // Higher boost = higher priority (appears earlier in list)
        const getBoostScore = (file: TAbstractFile): number => {
            const name = file.name.toLowerCase();
            const path = file.path.toLowerCase();
            const isActive = activeFile && file.path === activeFile.path;
            const isOpened = openedFiles.has(file.path);
            const isFolder = file instanceof TFolder;
            const isNote = file instanceof TFile && file.extension === 'md';

            // Base score by category (using large gaps for clear separation)
            // Active file: 10000
            // Opened notes: 8000
            // Unopened notes: 6000
            // Non-note files: 4000
            // Folders: 2000
            let score = 0;

            if (isActive) {
                score = 10000;
            } else if (isFolder) {
                score = 2000;
            } else if (!isNote) {
                // Non-note files
                score = 4000;
            } else if (isOpened) {
                score = 8000;
            } else {
                // Unopened notes
                score = 6000;
            }

            // Add relevance bonuses (smaller increments within category)
            // Match against the full path (primary) and name (secondary).
            if (partialPath !== '') {
                // Path matches (primary, since we now match by full path)
                if (path === partialPath) {
                    score += 900; // Exact path match
                } else if (path.startsWith(partialPath)) {
                    score += 700; // Path starts with partial
                } else {
                    const idx = path.indexOf(partialPath);
                    if (idx > 0 && path[idx - 1] === '/') {
                        score += 500; // Segment-boundary match within path
                    } else if (idx >= 0) {
                        score += 100; // Substring match in path
                    }
                }

                // Name matches (secondary)
                if (name === partialPath) {
                    score += 400;
                } else if (name.startsWith(partialPath)) {
                    score += 200;
                }
            }

            return score;
        };

        // Sort by boost score (descending) before limiting, so high-priority files are included
        const sortedFiles = [...filteredFiles].sort((a, b) => getBoostScore(b) - getBoostScore(a));
        const limitedFiles = sortedFiles.slice(0, 50);

        // Create completions with boost for sorting.
        //
        // IMPORTANT: the `from`/`to` parameters passed to `apply` are CM6's
        // mapped-to-current-state positions for `result.from` / `result.to`
        // (mapped through any transactions that happened while the popup was
        // open). We must use those, NOT the `triggerStart` / `pos` / `doc`
        // captured at completion-source time — those become stale the moment
        // `validFor` keeps the popup open across further typing, and using
        // them would leave any user-typed-since-popup characters orphaned
        // (e.g. typing `[[hel` → popup → type `lo` → accept produces
        // `[[file.md]]lo`).
        const completions: Completion[] = limitedFiles.map((file) => ({
            // Use full path as label so CM6's built-in filter matches against the path,
            // and the dropdown shows the complete path instead of just the file name.
            label: file.path,
            displayLabel: file.path,
            boost: getBoostScore(file),
            apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
                const docNow = view.state.doc;
                // Back up over the opening `[[` if it's still right before `from`.
                const beforeFrom = docNow.sliceString(Math.max(0, from - 2), from);
                const replaceFrom = beforeFrom === '[[' ? from - 2 : from;
                // Absorb any auto-closed `]]` right after `to` (closeBrackets path).
                const afterTo = docNow.sliceString(to, Math.min(docNow.length, to + 2));
                const replaceTo = afterTo === ']]' ? to + 2 : to;
                const insert = `[[${file.path}]]`;
                view.dispatch({
                    changes: { from: replaceFrom, to: replaceTo, insert },
                    selection: { anchor: replaceFrom + insert.length },
                });
            },
            type: file instanceof TFolder ? 'folder' : (file instanceof TFile && file.extension === 'md' ? 'note' : 'attachment'),
        }));

        return {
            from: triggerStart + 2,
            to: pos,
            options: completions,
            // Keep completion open as long as we're still inside the [[ ]]
            // pair — i.e. the text between [[ and cursor doesn't contain ]].
            validFor: (text: string) => !text.includes(']]'),
        };
    };
}

/**
 * Get all files and folders from the vault.
 *
 * Delegates to Obsidian's internally-maintained flat list rather than
 * walking the folder tree ourselves — both are O(N) but the native call
 * has a much smaller constant factor (no recursion, no de-dup Set).
 *
 * `getAllLoadedFiles()` includes the root folder in its result; we strip
 * it here to match what a suggestion popup would meaningfully reference
 * (you can't `[[]]`-link the vault root).
 */
function getAllFiles(app: App): TAbstractFile[] {
    return app.vault.getAllLoadedFiles().filter(
        (f) => !(f instanceof TFolder && f.isRoot())
    );
}

/**
 * Get the set of file paths that are currently open in any workspace leaf
 * (main area, floating, or sidebar) — used to boost frequently-accessed
 * files in completion ranking.
 *
 * Covers any `FileView` subclass (markdown / canvas / pdf / image /
 * attachment / etc.), not just markdown, so a user actively working with
 * non-note content still gets the "opened" priority bump for it.
 */
function getOpenedFiles(app: App): Set<string> {
    const openedFiles = new Set<string>();
    app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view;
        if (view instanceof FileView && view.file) {
            openedFiles.add(view.file.path);
        }
    });
    return openedFiles;
}
