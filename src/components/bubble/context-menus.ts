import { Menu, TFile } from 'obsidian';
import { t } from '../../i18n';
import { resolveAppUrlToVaultPath } from '../../utils/path-helper';
import { copyToClipboard } from '../../utils/clipboard';
import { revealInNavigation } from '../../utils/workspace-utils';
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
 * Strip a heading reference (`#…`) or block reference (`^…`) suffix from a
 * wikilink path so the remaining portion can be passed to
 * `getFirstLinkpathDest` for file resolution.
 *
 * Handles both `#` and `^` at any position after the first character,
 * taking the earliest delimiter when both are present (e.g.
 * `Note#heading^block` → `Note`).
 */
function stripHeadingBlockRef(linkText: string): string {
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

        // Resolve the target file using Obsidian's wikilink resolver. For
        // `app://` URLs we still resolve via vault path; for wikilinks we
        // strip heading/block refs before calling `getFirstLinkpathDest`.
        let resolvedFile: TFile | null = null;
        if (isObsidianInternal && linkText) {
            const pathOnly = stripHeadingBlockRef(linkText);
            const dest = app.metadataCache.getFirstLinkpathDest(pathOnly, '');
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
                void app.workspace.openLinkText(linkText, '', inNewTab);
            });

            // Middle-click (auxclick) — same as Cmd/Ctrl+click.
            link.addEventListener('auxclick', (e: MouseEvent) => {
                if (e.button !== 1) return;
                e.preventDefault();
                e.stopPropagation();
                void app.workspace.openLinkText(linkText, '', true);
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
