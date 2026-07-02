import { Menu, TFile, setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import { resolveAppUrlToVaultPath } from '../../utils/path-helper';
import { copyToClipboard } from '../../utils/clipboard';
import {
    revealInNavigation,
    resolveLinkOpenText,
    resolveLinkTarget,
} from '../../utils/workspace-utils';
import type { BubbleContext } from './bubble-context';

/**
 * Attach click + context-menu handlers to every `<img>` inside `container`.
 *
 * - Vault-relative images become clickable and open in the current leaf.
 * - Right-click exposes copy-link, reveal-in-explorer (for vault files), and
 *   open-in-browser (for external URLs).
 *
 * Idempotent-ish: callers are expected to only call this once per render
 * because MarkdownRenderer produces fresh DOM each pass.
 */
export function attachImageContextMenu(
    ctx: BubbleContext,
    container: HTMLElement,
): void {
    const app = ctx.app;
    const images = container.querySelectorAll('img');
    images.forEach((img) => {
        const getVaultPath = (): string | null => {
            const srcAttr = img.getAttribute('src') || '';
            if (srcAttr.startsWith('data:')) return null;
            if (srcAttr.startsWith('http')) return null;
            return resolveAppUrlToVaultPath(app, srcAttr);
        };

        img.addEventListener('click', (e: MouseEvent) => {
            const vaultPath = getVaultPath();
            if (vaultPath) {
                e.preventDefault();
                e.stopPropagation();
                const file = app.vault.getAbstractFileByPath(vaultPath);
                if (file instanceof TFile) {
                    const leaf = app.workspace.getLeaf(false);
                    void leaf.openFile(file);
                }
            }
        });

        img.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            const vaultPath = getVaultPath();
            const srcAttr = img.getAttribute('src') || '';
            const menu = new Menu();

            menu.addItem((item) => {
                item.setTitle(t('common.copy'));
                item.onClick(async () => {
                    const textToCopy = vaultPath || srcAttr;
                    await copyToClipboard(textToCopy);
                });
            });

            if (vaultPath) {
                const file = app.vault.getAbstractFileByPath(vaultPath);
                if (file instanceof TFile) {
                    menu.addItem((item) => {
                        item.setTitle(t('view.revealInExplorer'));
                        item.onClick(() => {
                            revealInNavigation(app, file);
                        });
                    });
                }
            }

            if (srcAttr.startsWith('http')) {
                menu.addItem((item) => {
                    item.setTitle(t('view.openInBrowser'));
                    item.onClick(() => {
                        window.open(srcAttr, '_blank');
                    });
                });
            }

            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });

        img.addClass('session-image-clickable');
    });
}

/**
 * Attach click + context-menu handlers to every `<a>` inside `container`.
 *
 * Resolves three link flavours:
 * 1. Internal vault links (`app://…` URLs, Obsidian `internal-link` class,
 *    or bare vault paths) — opened via `openLinkText` which handles
 *    heading/block references, non-existent notes, and mobile workspaces
 *    correctly. Obsidian's native hover-preview is wired up.
 * 2. External `http(s)` links — opened via workspace linker or system shell.
 * 3. Anchors / unsupported schemes — copy-link only.
 */
export function attachLinkContextMenu(
    ctx: BubbleContext,
    container: HTMLElement,
): void {
    const app = ctx.app;
    const links = container.querySelectorAll('a');
    links.forEach((link) => {
        const hrefAttr = link.getAttribute('href') || '';
        // Obsidian's MarkdownRenderer stores the raw wikilink text (without
        // `[[` `]]`) in `data-href`. Use this as the canonical link text
        // for `openLinkText` because it preserves heading/block references.
        const linkText = link.getAttribute('data-href') || hrefAttr;

        // ── Detect link type ───────────────────────────────────────────
        const isExternalLink = hrefAttr.startsWith('http://') || hrefAttr.startsWith('https://');

        // Internal links are either:
        //   - Marked by Obsidian's MarkdownRenderer with class `internal-link`
        //   - `app://` resource URLs (images, attachments)
        const isObsidianInternal = link.classList.contains('internal-link');
        const isAppUrl = hrefAttr.startsWith('app://');

        // Resolve the target file. For wikilinks we combine Obsidian's cache
        // lookup with our extension-aware resolver (`.base`, `.canvas`, …).
        let resolvedFile: TFile | null = null;
        if (isObsidianInternal && linkText) {
            const dest = resolveLinkTarget(app, linkText);
            if (dest instanceof TFile) resolvedFile = dest;
        }
        if (!resolvedFile && isAppUrl) {
            const relativePath = resolveAppUrlToVaultPath(app, hrefAttr);
            if (relativePath) {
                const file = app.vault.getAbstractFileByPath(relativePath);
                if (file instanceof TFile) resolvedFile = file;
            }
        }

        const isInternalLink = resolvedFile !== null || isObsidianInternal || isAppUrl;

        // ── Click handler ──────────────────────────────────────────────
        // Always attach for recognised internal links so the user never
        // hits the browser's built-in `target="_blank"` behaviour on
        // wiki-links — that fallback is a known crash source on mobile
        // Capacitor WebViews.
        if (isInternalLink) {
            // Hover preview: use the resolved file path for the preview,
            // falling back to the raw linkText (which may include a heading).
            link.addEventListener('mouseenter', (evt) => {
                app.workspace.trigger('hover-link', {
                    event: evt,
                    source: 'ai-assistant',
                    hoverParent: container,
                    targetEl: link,
                    linktext: resolvedFile?.path || linkText,
                });
            });

            link.addEventListener('click', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                const inNewTab = e.metaKey || e.ctrlKey || e.button === 1;
                void app.workspace.openLinkText(
                    resolveLinkOpenText(app, linkText),
                    '',
                    inNewTab,
                );
            });

            // Middle-click (auxclick) — same as Cmd/Ctrl+click.
            link.addEventListener('auxclick', (e: MouseEvent) => {
                if (e.button !== 1) return;
                e.preventDefault();
                e.stopPropagation();
                void app.workspace.openLinkText(resolveLinkOpenText(app, linkText), '', true);
            });
        }

        // ── Context menu ───────────────────────────────────────────────
        link.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            const menu = new Menu();

            if (isExternalLink) {
                menu.addItem((item) => {
                    item.setTitle(t('view.openInBrowser'));
                    item.onClick(() => {
                        void app.workspace.openLinkText(hrefAttr, '', false);
                    });
                });

                menu.addItem((item) => {
                    item.setTitle(t('view.openInSystemBrowser'));
                    item.onClick(() => {
                        window.open(hrefAttr, '_blank');
                    });
                });
            }

            menu.addItem((item) => {
                item.setTitle(t('common.copy'));
                item.onClick(async () => {
                    await copyToClipboard(hrefAttr);
                });
            });

            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });

        link.addClass('session-link-clickable');
    });
}

/**
 * Attach click handlers + copy buttons to every `.mermaid` container inside
 * `container`.
 *
 * - Adds a copy button (top-right, hover-revealed) that copies the original
 *   mermaid source code — same UX as regular code blocks.
 * - If `onPreview` is provided, clicking the diagram opens the zoomable /
 *   pannable preview overlay.
 * - Idempotent: safe to call multiple times per container.
 *
 * @param mermaidSources  Source strings extracted from the original markdown,
 *   matched to `.mermaid` containers by DOM order. Obsidian's
 *   MarkdownRenderer does not preserve mermaid sources in the rendered DOM,
 *   so they must be supplied externally.
 */
export function attachMermaidPreviewHandler(
    container: HTMLElement,
    onPreview?: (svg: string, code?: string) => void,
    mermaidSources?: string[],
): void {
    const mermaidContainers = container.querySelectorAll('.mermaid');
    let sourceIndex = 0;
    mermaidContainers.forEach((wrapper) => {
        // Prevent attaching handler multiple times (idempotent).
        if (wrapper.hasClass('session-mermaid-clickable')) return;

        const svgEl = wrapper.querySelector('svg');
        if (!svgEl) return;

        // Source code matched by DOM order.
        const sourceCode = mermaidSources?.[sourceIndex++];

        // ── Copy button (hover-revealed, top-right) ───────────────────
        if (sourceCode) {
            const copyBtn = activeDocument.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'session-mermaid-copy-btn';
            copyBtn.setAttribute('aria-label', t('common.copy'));
            setIcon(copyBtn, 'copy');
            setTooltip(copyBtn, t('common.copy'));

            const handleCopy = async () => {
                const ok = await copyToClipboard(sourceCode, { showNotice: false });
                if (!ok) return;
                setIcon(copyBtn, 'check');
                window.setTimeout(() => setIcon(copyBtn, 'copy'), 1500);
            };
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                void handleCopy();
            });
            wrapper.appendChild(copyBtn);
        }

        // ── Preview click handler ─────────────────────────────────────
        if (onPreview) {
            const serializer = new XMLSerializer();
            const svgString = serializer.serializeToString(svgEl);

            wrapper.addEventListener('click', (e) => {
                e.stopPropagation();
                onPreview(svgString, sourceCode);
            });
        }

        wrapper.addClass('session-mermaid-clickable');
    });
}

