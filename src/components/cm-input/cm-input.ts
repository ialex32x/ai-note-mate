/**
 * CodeMirror 6 based input editor with file reference widget support.
 *
 * Features:
 * - File references rendered as inline widgets (Obsidian [[path]] syntax)
 * - Trigger file suggest on `[[` input
 * - Backspace to delete entire widget
 * - Extract file references from content
 */

import { EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars, Decoration, DecorationSet, tooltips, placeholder } from '@codemirror/view';
import { EditorState, StateField, RangeSetBuilder, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { autocompletion, startCompletion, completionKeymap, completionStatus } from '@codemirror/autocomplete';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching } from '@codemirror/language';
import { setIcon } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';
import { FileRefWidget } from './file-ref-widget';
import { fileRefCompletionSource } from './file-ref-completion';

export interface CMInputOptions {
    app: App;
    placeholder?: string;
    onEnter?: (view: EditorView) => boolean | void;
    onFileRefClick?: (path: string) => void;
    onDeleteFileRef?: (path: string) => void;
    /** Called when content changes */
    onChange?: (content: string) => void;
}

/**
 * Parse content and extract file references in [[path]] format.
 * Returns an array of { start, end, path } positions.
 *
 * Uses non-greedy matching to find the nearest closing ]] for each [[.
 * This ensures that `[[ [[test]]` is parsed as one link `[[test]]` (the second [[),
 * not as `[[ [[test]]` starting from the first [[.
 */
export function extractFileRefs(content: string): Array<{ start: number; end: number; path: string; displayName?: string }> {
    const refs: Array<{ start: number; end: number; path: string; displayName?: string }> = [];
    // Use non-greedy quantifier (+? instead of +) to find the nearest closing ]]
    // Group 1: file path (stripped of heading ref #h and block ref ^b).
    // Group 2: optional display name after | (e.g. [[file|My Label]] → displayName = "My Label").
    const regex = /\[\[([^[\]|#^]+?)(?:[#^][^\]|]*?)?(?:\|([^\]]+?))?\]\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        refs.push({
            start: match.index,
            end: match.index + match[0].length,
            path: match[1]!,
            displayName: match[2] ?? undefined,
        });
    }
    return refs;
}

/**
 * Build decorations from document content.
 * Finds all [[path]] patterns and creates replace decorations that render
 * each match as an inline chip widget.
 *
 * We use `Decoration.replace` (not `Decoration.widget`) because the chip
 * spans a real range in the source (`[[path]]`) and should hide that text.
 * `Decoration.widget` is meant for zero-length insertions; using it with
 * a non-zero range bypasses CM's `range()` validation and causes the
 * widget rangeset to drift out of sync with the document during edits
 * (which surfaces as `Position N is out of range for changeset of length 0`
 * crashes when CM remaps decorations on backspace-deletion of a chip).
 */
function buildDecorations(
    state: EditorState,
    app: App,
    onFileRefClick?: (path: string) => void,
    onDeleteFileRef?: (path: string) => void
): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const content = state.doc.toString();
    const refs = extractFileRefs(content);

    for (const ref of refs) {
        const chip = Decoration.replace({
            widget: new FileRefWidget(ref.path, app, onFileRefClick, onDeleteFileRef, ref.displayName),
            inclusive: false,
        });
        builder.add(ref.start, ref.end, chip);
    }

    return builder.finish();
}

/**
 * Create a CodeMirror 6 based input editor with file reference support.
 */
export class CMInput {
    private view: EditorView;
    private app: App;
    private onEnterCallback?: (view: EditorView) => boolean | void;
    /** rAF handle for a pending `startCompletion` call; cleared on destroy. */
    private pendingCompletionRAF: number | null = null;
    /** Set to true once `destroy()` runs so deferred callbacks can bail out. */
    private destroyed = false;

    constructor(parent: HTMLElement, options: CMInputOptions) {
        this.app = options.app;
        this.onEnterCallback = options.onEnter;

        // Create delete handler that removes the file reference from content
        const handleDeleteFileRef = (path: string) => {
            this.deleteFileRef(path);
            options.onDeleteFileRef?.(path);
        };

        // Single source of truth for file-ref ranges. The same DecorationSet
        // drives both the visual chip rendering and the atomic-range behavior
        // (cursor jumps over chips, backspace deletes the whole chip), so the
        // two stay in lockstep across transactions. This mirrors the pattern
        // shown in the official CodeMirror decoration example.
        const decorationField = StateField.define<DecorationSet>({
            create: (state) => buildDecorations(state, this.app, options.onFileRefClick, handleDeleteFileRef),
            update: (decorations, tr) => {
                if (tr.docChanged) {
                    return buildDecorations(tr.state, this.app, options.onFileRefClick, handleDeleteFileRef);
                }
                return decorations;
            },
            provide: (f) => [
                EditorView.decorations.from(f),
                EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
            ],
        });

        const enterHandler = Prec.highest(keymap.of([{
            key: 'Enter',
            run: (view) => {
                // If completion dropdown is open or pending, let completionKeymap handle it
                // completionStatus returns 'active', 'pending', or null
                const status = completionStatus(view.state);
                if (status !== null) {
                    return false;
                }
                // Otherwise, call the onEnter callback (for send functionality)
                if (this.onEnterCallback) {
                    const result = this.onEnterCallback(view);
                    return result === true;
                }
                return false;
            },
        }]));

        const tabHandler = keymap.of([{
            key: 'Tab',
            run: (view) => {
                // Accept completion if visible, otherwise do nothing
                startCompletion(view);
                return true;
            },
        }]);

        const state = EditorState.create({
            extensions: [
                // Basic setup
                highlightSpecialChars(),
                history(),
                drawSelection(),
                dropCursor(),
                EditorState.allowMultipleSelections.of(false),
                EditorView.lineWrapping,

                // Close brackets - disabled for now as it interferes with [[ file ref syntax
                // closeBrackets(),

                // Bracket matching
                bracketMatching(),

                // Syntax highlighting
                syntaxHighlighting(defaultHighlightStyle, { fallback: true }),

                // File reference decorations (also provides atomic ranges
                // for cursor motion / backspace deletion of chips)
                decorationField,

                // Use fixed positioning for tooltips to avoid clipping by parent overflow
                // Must be placed BEFORE autocompletion for the config to take effect
                tooltips({
                    position: 'fixed',
                    parent: activeDocument.body,
                }),

                // Autocompletion for file references
                autocompletion({
                    override: [fileRefCompletionSource(this.app)],
                    activateOnTyping: true,
                    maxRenderedOptions: 20,
                    addToOptions: [
                        {
                            render: (completion) => {
                                const el = createSpan();
                                el.className = 'cm-completion-icon';
                                const iconName = completion.type === 'note' ? 'file-text'
                                    : completion.type === 'folder' ? 'folder'
                                    : 'paperclip';
                                setIcon(el, iconName);
                                return el;
                            },
                            position: 20, // before label (default label position is 50)
                        },
                    ],
                    icons: false, // disable default icons
                }),

                // Keymaps
                keymap.of([
                    // ...closeBracketsKeymap, // disabled for [[ file ref syntax
                    ...defaultKeymap,
                    ...historyKeymap,
                    ...completionKeymap,
                    indentWithTab,
                ]),
                enterHandler,
                tabHandler,

                // Theme
                EditorView.theme({
                    '&': {
                        height: '100%',
                        fontSize: '14px',
                    },
                    '.cm-scroller': {
                        overflow: 'auto',
                        fontFamily: 'inherit',
                    },
                    '.cm-content': {
                        padding: '8px 0',
                        minHeight: '60px',
                    },
                    '.cm-line': {
                        padding: '0 8px',
                    },
                    // Placeholder style - normal font, same padding as .cm-line
                    '.cm-placeholder': {
                        color: 'var(--text-faint)',
                        padding: '0 8px',
                    },
                    // Completion dropdown
                    '.cm-tooltip-autocomplete': {
                        '& > ul': {
                            maxHeight: '200px',
                            fontFamily: 'inherit',
                            fontSize: '13px',
                        },
                        '& li': {
                            padding: '2px 8px',
                        },
                        '& li[aria-selected]': {
                            background: 'var(--background-modifier-active-hover)',
                        },
                    },
                }),

                // Placeholder (built-in CM6 extension; renders inline as a
                // widget with class `cm-placeholder`, styled via our theme).
                options.placeholder ? placeholder(options.placeholder) : [],

                // Trigger completion on [[ input or when cursor is inside [[ ]]
                EditorView.updateListener.of((update) => {
                    if (!update.docChanged) return;
                    const doc = update.state.doc.toString();
                    const pos = update.state.selection.main.head;

                    // Check if we're inside a [[ ]] pair (after typing [[ or closeBrackets auto-inserted )
                    // Look backwards for [[
                    let foundTrigger = false;
                    for (let i = pos - 1; i >= 0; i--) {
                        const char = doc[i];
                        if (char === ']' && i > 0 && doc[i - 1] === ']') {
                            // Found closing ]] before cursor, stop
                            break;
                        }
                        if (char === '[' && i > 0 && doc[i - 1] === '[') {
                            foundTrigger = true;
                            break;
                        }
                        if (char === '\n' || char === ' ' || char === '\t') {
                            break;
                        }
                    }

                    if (foundTrigger) {
                        this.scheduleCompletion();
                    }
                }),

                // Content change listener for draft input save
                EditorView.updateListener.of((update) => {
                    if (update.docChanged && options.onChange) {
                        options.onChange(update.state.doc.toString());
                    }
                }),
            ],
        });

        this.view = new EditorView({
            state,
            parent,
        });
    }

    /**
     * Schedule a `startCompletion` call on the next animation frame.
     *
     * We defer to rAF so the editor state from the triggering transaction
     * is fully committed before the completion plugin reads it. The handle
     * is tracked so {@link destroy} can cancel it; if the view is torn
     * down between scheduling and execution, the callback bails out
     * instead of poking a destroyed view (which would crash CM internals).
     */
    private scheduleCompletion(): void {
        if (this.pendingCompletionRAF !== null) {
            window.cancelAnimationFrame(this.pendingCompletionRAF);
        }
        this.pendingCompletionRAF = window.requestAnimationFrame(() => {
            this.pendingCompletionRAF = null;
            if (this.destroyed) return;
            startCompletion(this.view);
        });
    }

    /** Get the current content (includes [[path]] for file references) */
    getContent(): string {
        return this.view.state.doc.toString();
    }

    /** Set editor content and place the cursor at the end. */
    setContent(content: string): void {
        this.view.dispatch({
            changes: {
                from: 0,
                to: this.view.state.doc.length,
                insert: content,
            },
            selection: { anchor: content.length, head: content.length },
        });
    }

    /** Clear editor content */
    clear(): void {
        this.setContent('');
    }

    /** Focus the editor */
    focus(): void {
        this.view.focus();
    }

    /**
     * Insert `[[` at the cursor position (if not already preceded by `[[`)
     * and open the file reference suggestion popup.
     *
     * Equivalent to the user manually typing `[[` — intended for mobile users
     * who cannot easily input double brackets from the on-screen keyboard.
     */
    triggerFileRefSuggest(): void {
        this.view.focus();
        const { state } = this.view;
        const selection = state.selection.main;

        // Only treat a preceding `[[` as "already there" when there is no
        // active selection — otherwise that `[[` could actually be inside
        // the selection (selection.head can be either end of the range).
        let alreadyHasBrackets = false;
        if (selection.empty) {
            const beforeCursor = state.doc.sliceString(Math.max(0, selection.head - 2), selection.head);
            alreadyHasBrackets = beforeCursor === '[[';
        }

        if (!alreadyHasBrackets) {
            this.view.dispatch({
                changes: {
                    from: selection.from,
                    to: selection.to,
                    insert: '[[',
                },
                selection: { anchor: selection.from + 2 },
            });
        }

        this.scheduleCompletion();
    }

    /** Insert a file reference at current cursor position */
    insertFileRef(file: TAbstractFile): void {
        const { state } = this.view;
        const selection = state.selection.main;
        const insertText = `[[${file.path}]]`;

        // Default to replacing the current selection (or, if empty, inserting
        // at the cursor). Using `selection.from` / `selection.to` (not
        // `selection.head`) keeps reverse-direction selections correct.
        let from = selection.from;
        const to = selection.to;

        // If the cursor is right after a `[[` trigger (no selection), absorb
        // those two characters so we don't end up with `[[[[file]]`.
        if (selection.empty) {
            const beforeCursor = state.doc.sliceString(Math.max(0, selection.head - 2), selection.head);
            if (beforeCursor === '[[') {
                from = selection.head - 2;
            }
        }

        this.view.dispatch({
            changes: { from, to, insert: insertText },
            selection: { anchor: from + insertText.length },
        });

        this.view.focus();
    }

    /**
     * Insert arbitrary text at the current cursor position. If text is currently
     * selected in the input it is replaced. The cursor ends up immediately after
     * the inserted text so the user can keep typing.
     *
     * Used by external entry points such as the editor right-click menu's
     * "Send to AI Session" action that need to drop a contextual snippet
     * (file ref + cursor coordinates / selected text) into the input.
     */
    insertText(text: string): void {
        if (!text) return;
        const { state } = this.view;
        const selection = state.selection.main;
        this.view.dispatch({
            changes: {
                from: selection.from,
                to: selection.to,
                insert: text,
            },
            selection: { anchor: selection.from + text.length },
        });
        this.view.focus();
    }

    /** Get extracted file references from current content */
    getFileRefs(): string[] {
        const content = this.getContent();
        return extractFileRefs(content).map(r => r.path);
    }

    /** Delete a file reference by path */
    deleteFileRef(path: string): void {
        const content = this.view.state.doc.toString();
        const refs = extractFileRefs(content);
        const ref = refs.find(r => r.path === path);
        if (ref) {
            this.view.dispatch({
                changes: {
                    from: ref.start,
                    to: ref.end,
                    insert: '',
                },
            });
        }
    }

    /** Enable or disable the editor */
    setEnabled(enabled: boolean): void {
        this.view.contentDOM.contentEditable = enabled ? 'true' : 'false';
        if (enabled) {
            this.view.dom.classList.remove('cm-disabled');
        } else {
            this.view.dom.classList.add('cm-disabled');
        }
    }

    /** Destroy the editor */
    destroy(): void {
        this.destroyed = true;
        if (this.pendingCompletionRAF !== null) {
            window.cancelAnimationFrame(this.pendingCompletionRAF);
            this.pendingCompletionRAF = null;
        }
        this.view.destroy();
    }

    /** Get the underlying EditorView for advanced use */
    getView(): EditorView {
        return this.view;
    }
}
