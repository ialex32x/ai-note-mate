/**
 * File Reference Completion Source for CodeMirror 6.
 *
 * Provides autocompletion for file references when typing [[.
 */

import { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { App, MarkdownView, TAbstractFile, TFile, TFolder } from 'obsidian';

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

        // Create completions with boost for sorting
        const completions: Completion[] = limitedFiles.map((file) => ({
            // Use full path as label so CM6's built-in filter matches against the path,
            // and the dropdown shows the complete path instead of just the file name.
            label: file.path,
            displayLabel: file.path,
            boost: getBoostScore(file),
            apply: (view: any, completion: Completion, from: number, to: number) => {
                // Check if there's ]] right after cursor position (auto-inserted by closeBrackets)
                const docAfterPos = doc.slice(pos, pos + 2);
                const hasAutoClose = docAfterPos === ']]';

                // Replace from [[ to current position (and include ]] if auto-closed)
                view.dispatch({
                    changes: {
                        from: triggerStart,
                        to: hasAutoClose ? pos + 2 : pos,
                        insert: `[[${file.path}]]`,
                    },
                    selection: { anchor: triggerStart + file.path.length + 4 },
                });
            },
            type: file instanceof TFolder ? 'folder' : (file instanceof TFile && file.extension === 'md' ? 'note' : 'attachment'),
        }));

        return {
            from: triggerStart + 2,
            to: pos,
            options: completions,
            // Keep completion open as long as we're inside [[ ]]
            // Return true if the text between [[ and cursor doesn't contain ]]
            validFor: (text: string, from: number, to: number) => {
                // If text contains ]], we're no longer inside a file ref
                if (text.includes(']]')) return false;
                // Otherwise, keep the completion open
                return true;
            },
        };
    };
}

/**
 * Get all files and folders from the vault.
 */
function getAllFiles(app: App): TAbstractFile[] {
    const files: TAbstractFile[] = [];
    const seen = new Set<string>();

    const traverse = (folder: TFolder) => {
        for (const child of folder.children) {
            if (seen.has(child.path)) continue;
            seen.add(child.path);
            files.push(child);
            if (child instanceof TFolder) {
                traverse(child);
            }
        }
    };

    traverse(app.vault.getRoot());
    return files;
}

/**
 * Get all opened file paths (excluding the active file).
 */
function getOpenedFiles(app: App): Set<string> {
    const openedFiles = new Set<string>();
    const leaves = app.workspace.getLeavesOfType('markdown');
    const activeFile = app.workspace.getActiveFile();

    for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof MarkdownView) {
            const file = view.file;
            if (file && file.path !== activeFile?.path) {
                openedFiles.add(file.path);
            }
        }
    }
    return openedFiles;
}
