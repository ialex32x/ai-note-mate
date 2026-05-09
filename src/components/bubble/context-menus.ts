import { Menu, TFile } from 'obsidian';
import { t } from '../../i18n';
import { resolveAppUrlToVaultPath } from '../../utils/path-helper';
import {
    openFileInWorkspace,
    revealInNavigation,
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
                    leaf.openFile(file);
                }
            }
        });

        img.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            const vaultPath = getVaultPath();
            const srcAttr = img.getAttribute('src') || '';
            const menu = new Menu();

            menu.addItem((item) => {
                item.setTitle(t('view.copyLink'));
                item.onClick(async () => {
                    const textToCopy = vaultPath || srcAttr;
                    await navigator.clipboard.writeText(textToCopy);
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
 * 1. Internal vault links (`app://…` URLs or bare vault paths) — opened in
 *    the workspace, with Obsidian's native hover-preview wired up.
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

        const resolveVaultFile = (): TFile | null => {
            if (!hrefAttr) return null;

            if (hrefAttr.startsWith('app://')) {
                const relativePath = resolveAppUrlToVaultPath(app, hrefAttr);
                if (relativePath) {
                    const file = app.vault.getAbstractFileByPath(relativePath);
                    if (file instanceof TFile) return file;
                }
                return null;
            }

            // Bare path (no scheme, not an anchor): try as-is and with `.md`
            // appended — matches how the renderer emits internal links.
            if (!hrefAttr.includes('://') && !hrefAttr.startsWith('#')) {
                let pathToTry = hrefAttr;
                if (!pathToTry.includes('.')) {
                    pathToTry = pathToTry + '.md';
                }
                const file = app.vault.getAbstractFileByPath(pathToTry);
                if (file instanceof TFile) return file;

                const fileNoExt = app.vault.getAbstractFileByPath(hrefAttr);
                if (fileNoExt instanceof TFile) return fileNoExt;
            }

            return null;
        };

        const isExternalLink = hrefAttr.startsWith('http://') || hrefAttr.startsWith('https://');
        const vaultFile = resolveVaultFile();
        const isInternalLink = vaultFile !== null;

        if (isInternalLink && vaultFile) {
            link.addEventListener('mouseenter', (evt) => {
                app.workspace.trigger('hover-link', {
                    event: evt,
                    source: 'ai-assistant',
                    hoverParent: container,
                    targetEl: link,
                    linktext: vaultFile.path,
                });
            });

            link.addEventListener('click', (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                openFileInWorkspace(app, vaultFile);
            });
        }

        link.addEventListener('contextmenu', (e: MouseEvent) => {
            e.preventDefault();
            const menu = new Menu();

            if (isInternalLink && vaultFile) {
                menu.addItem((item) => {
                    item.setTitle(t('view.openNoteInNewTab'));
                    item.onClick(() => {
                        const leaf = app.workspace.getLeaf('tab');
                        leaf.openFile(vaultFile);
                    });
                });
            } else if (isExternalLink) {
                menu.addItem((item) => {
                    item.setTitle(t('view.openInBrowser'));
                    item.onClick(() => {
                        app.workspace.openLinkText(hrefAttr, '', false);
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
                item.setTitle(t('view.copyLink'));
                item.onClick(async () => {
                    await navigator.clipboard.writeText(hrefAttr);
                });
            });

            menu.showAtPosition({ x: e.clientX, y: e.clientY });
        });

        link.addClass('session-link-clickable');
    });
}
