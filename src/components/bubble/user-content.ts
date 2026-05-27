import { setIcon, setTooltip, TFile, TFolder } from 'obsidian';
import { extractFileRefs } from '../cm-input/cm-input';
import {
    revealInNavigation,
    resolveFileRef,
} from '../../utils/workspace-utils';
import type { BubbleContext } from './bubble-context';

/**
 * Render user message content with inline file references.
 *
 * Parses `[[path]]` syntax and renders each reference as a clickable inline
 * chip; any surrounding text is appended verbatim. If the content contains
 * no references, the text is set directly to avoid extra DOM churn.
 */
export function renderUserContent(
    ctx: BubbleContext,
    container: HTMLElement,
    content: string,
): void {
    const refs = extractFileRefs(content);

    if (refs.length === 0) {
        container.setText(content);
        return;
    }

    let lastEnd = 0;
    for (const ref of refs) {
        if (ref.start > lastEnd) {
            container.appendText(content.slice(lastEnd, ref.start));
        }
        renderInlineFileRef(ctx, container, ref.path, ref.displayName);
        lastEnd = ref.end;
    }

    if (lastEnd < content.length) {
        container.appendText(content.slice(lastEnd));
    }
}

/**
 * Render an inline file reference chip.
 *
 * Shows as a clickable link with a "broken" visual state for missing files.
 * Supports both full paths and short links (filename-only references); the
 * tooltip disambiguates short links by showing the resolved full path.
 */
function renderInlineFileRef(
    ctx: BubbleContext,
    container: HTMLElement,
    path: string,
    displayName?: string,
): void {
    const app = ctx.app;
    const resolved = resolveFileRef(app, path);
    const exists = resolved !== null;
    const isFolder = resolved?.isFolder ?? false;
    const resolvedPath = resolved?.path ?? path;

    const chip = container.createEl('span', {
        cls: exists
            ? 'bubble-file-ref'
            : 'bubble-file-ref bubble-file-ref--missing',
    });

    // Data attributes power Obsidian's built-in hover preview wiring.
    chip.setAttribute('data-href', resolvedPath);
    chip.setAttribute('data-path', resolvedPath);

    const tooltipPath = resolved?.isShortLink
        ? `${path} → ${resolvedPath}`
        : resolvedPath;
    setTooltip(chip, tooltipPath, { placement: 'top' });

    const iconEl = chip.createEl('span', { cls: 'bubble-file-ref__icon' });
    setIcon(iconEl, isFolder ? 'folder' : 'file');

    const name = displayName ?? resolvedPath.split('/').pop() ?? resolvedPath;
    chip.createEl('span', { cls: 'bubble-file-ref__name', text: name });

    // Hover preview (files only; folders have no preview surface).
    if (exists && !isFolder) {
        const file = app.vault.getAbstractFileByPath(resolvedPath);
        if (file instanceof TFile) {
            chip.addEventListener('mouseenter', (evt) => {
                app.workspace.trigger('hover-link', {
                    event: evt,
                    source: 'ai-assistant',
                    hoverParent: container,
                    targetEl: chip,
                    linktext: resolvedPath,
                });
            });
        }
    }

    chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!exists) return;
        const file = app.vault.getAbstractFileByPath(resolvedPath);
        if (file instanceof TFolder) {
            revealInNavigation(app, file);
        } else if (file instanceof TFile) {
            // Follow Obsidian's standard behaviour: click replaces the
            // active tab, Cmd/Ctrl+click opens a new tab.
            void app.workspace.openLinkText(resolvedPath, '', false);
        }
    });
}
