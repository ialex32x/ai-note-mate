/**
 * File Reference Widget for CodeMirror 6.
 *
 * Renders `[[path/to/file]]` as an inline chip widget.
 * The widget is atomic (cursor jumps over it) and can be clicked.
 */

import { WidgetType } from '@codemirror/view';
import { setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { resolveFileRef } from '../../utils/workspace-utils';

/**
 * Widget that renders a file reference as a styled chip.
 */
export class FileRefWidget extends WidgetType {
    private resolvedRef: ReturnType<typeof resolveFileRef> | null = null;

    constructor(
        readonly path: string,
        readonly app: App,
        readonly onClick?: (path: string) => void,
        readonly onDelete?: (path: string) => void
    ) {
        super();
        // Resolve the file reference once during construction
        this.resolvedRef = resolveFileRef(app, path);
    }

    /**
     * Check if the referenced file or folder exists in the vault.
     * Supports both full paths and short links (filename-only references).
     */
    private fileExists(): boolean {
        return this.resolvedRef !== null;
    }

    /**
     * Get the resolved path, preferring the original path for display.
     */
    private getDisplayPath(): string {
        return this.resolvedRef?.path ?? this.path;
    }

    toDOM(): HTMLElement {
        const container = document.createElement('span');
        const exists = this.fileExists();
        const displayPath = this.getDisplayPath();
        container.className = exists ? 'cm-file-ref' : 'cm-file-ref cm-file-ref--missing';
        container.setAttribute('data-path', displayPath);

        // Get file/folder name from path
        const name = displayPath.split('/').pop() ?? displayPath;
        const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() : '';

        // Add icon based on resolved type or extension
        const iconEl = container.createEl('span', { cls: 'cm-file-ref__icon' });
        if (this.resolvedRef?.isFolder) {
            setIcon(iconEl, 'folder');
        } else if (ext) {
            // File with extension - use file icon
            setIcon(iconEl, 'file');
        } else {
            // Unknown type, use file icon as default
            setIcon(iconEl, 'file');
        }

        // Add name
        container.createEl('span', { cls: 'cm-file-ref__name', text: name });

        // Add delete button.
        // NOTE: We intentionally use <span role="button"> rather than a real
        // <button>, because Obsidian Mobile injects aggressive global styles
        // for <button> (min-width / padding / appearance) that override our
        // 14x14 sizing and squash the round chip into an oval.
        if (this.onDelete) {
            const deleteBtn = container.createEl('span', {
                cls: 'cm-file-ref__delete',
                attr: { role: 'button', 'aria-label': 'Remove', tabindex: '-1' },
            });
            setIcon(deleteBtn, 'x');
            deleteBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.onDelete?.(this.path);
            });
        }

        // Click handler (only on main content, not delete button)
        if (this.onClick) {
            container.addEventListener('click', (e) => {
                // Don't trigger if clicking on delete button
                if ((e.target as HTMLElement).closest('.cm-file-ref__delete')) {
                    return;
                }
                e.preventDefault();
                e.stopPropagation();
                // Use the original path from [[]] for click action
                this.onClick?.(this.path);
            });
        }

        return container;
    }

    /**
     * Widget should be treated as a single unit for cursor movement.
     * This means arrow keys will skip over the entire widget.
     */
    override eq(other: FileRefWidget): boolean {
        return other.path === this.path && other.app === this.app;
    }

    /**
     * Ignore most events so cursor moves over the widget atomically.
     */
    override ignoreEvent(): boolean {
        return false; // Allow click events
    }

    /**
     * Estimated width for layout calculation.
     */
    override get estimatedHeight(): number {
        return 22;
    }
}
