import { Menu, TFile } from 'obsidian';
import { t } from '../../i18n';
import { resolveAppUrlToVaultPath } from '../../utils/path-helper';
import { copyToClipboard } from '../../utils/clipboard';
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
                        void leaf.openFile(vaultFile);
                    });
                });
            } else if (isExternalLink) {
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
 * Attach a context menu to a user message bubble that offers "Copy message"
 * to place the raw message text on the clipboard, plus optional "Branch from
 * here" when the host wires a branch handler.
 *
 * The menu is kept intentionally minimal: user bubbles don't have an action
 * bar (unlike assistant replies), so right-click is the primary surface for
 * these shortcuts. Bind to the bubble element rather than the content element
 * so the hit area includes the role label and surrounding padding — matches
 * user expectation that "right-click the bubble" works anywhere on it.
 *
 * Passes `showNotice: false` only when we want to suppress the default toast;
 * here we keep it on so users get an explicit confirmation on both desktop
 * and mobile (where no tooltip/icon-swap feedback is available).
 *
 * @param onBranch  Optional callback invoked when the user selects
 *                  "Branch from here". When omitted, the item is not shown.
 *                  The callback is responsible for guarding busy-state and
 *                  any follow-up UI transitions.
 */
export function attachUserBubbleContextMenu(
    bubble: HTMLElement,
    content: string,
    onBranch?: () => void,
): void {
    bubble.addEventListener('contextmenu', (e: MouseEvent) => {
        // Don't hijack context menus that originate from child widgets
        // (file-ref chips, future inline controls). Those elements handle
        // their own right-click — our handler should only fire for plain
        // text areas of the bubble.
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.bubble-file-ref')) {
            return;
        }

        e.preventDefault();
        const menu = new Menu();

        menu.addItem((item) => {
            item.setTitle(t('common.copy'));
            item.setIcon('copy');
            item.onClick(async () => {
                await copyToClipboard(content);
            });
        });

        if (onBranch) {
            menu.addItem((item) => {
                item.setTitle(t('view.branchFromHere'));
                item.setIcon('git-branch');
                item.onClick(() => {
                    onBranch();
                });
            });
        }

        menu.showAtPosition({ x: e.clientX, y: e.clientY });
    });
}
