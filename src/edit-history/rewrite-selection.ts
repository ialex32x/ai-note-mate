/**
 * Shared "AI" submenu host on `editor-menu`.
 *
 * Caller-contributed items (e.g. "Send to AI Session") and dynamic items
 * from MENU.md are grouped under a single parent entry so AI-related
 * editor actions don't clutter the top-level editor menu.
 */

import { Editor, MarkdownView, MarkdownFileInfo, IconName } from "obsidian";
import type NoteAssistantPlugin from "../main";
import { t } from "../i18n";

/**
 * Caller-contributed entry that will be appended into the shared "AI"
 * submenu on `editor-menu`. Allows other modules to share the parent
 * item instead of registering their own top-level entries.
 *
 * `isAvailable` controls whether the entry appears for the current editor
 * state (e.g. selection presence). When omitted the entry is always shown.
 */
export interface AISubmenuItem {
    title: string;
    icon: IconName;
    isAvailable?: (editor: Editor, info?: MarkdownView | MarkdownFileInfo) => boolean;
    onClick: (editor: Editor, info?: MarkdownView | MarkdownFileInfo) => void;
}

// Minimal shape of `MenuItem.setSubmenu()` — Obsidian exposes this at
// runtime but it is not in the public typings, so we narrow it locally.
type SubmenuHost = {
    addItem: (cb: (s: {
        setTitle: (n: string) => unknown;
        setIcon: (n: string) => unknown;
        onClick: (cb: () => void) => unknown;
    }) => void) => unknown;
    addSeparator?: () => unknown;
};

/**
 * Wire up the editor-menu "AI" submenu.
 *
 * `extraSubmenuItems` lets other modules add static actions (e.g. "Send to
 * AI Session") under the shared parent. `dynamicExtraItems` is an optional
 * getter evaluated at menu-open time, allowing dynamically-loaded items
 * (e.g. from MENU.md) to appear alongside the static ones.
 */
export function registerEditorAISubmenu(
    plugin: NoteAssistantPlugin,
    extraSubmenuItems: readonly AISubmenuItem[] = [],
    dynamicExtraItems?: (editor: Editor, info?: MarkdownView | MarkdownFileInfo) => AISubmenuItem[],
): void {
    plugin.registerEvent(
        plugin.app.workspace.on("editor-menu", (menu, editor, info) => {
            const staticExtras = extraSubmenuItems.filter(
                (e) => !e.isAvailable || e.isAvailable(editor, info),
            );
            const dynamicExtras = dynamicExtraItems?.(editor, info) ?? [];

            if (staticExtras.length === 0 && dynamicExtras.length === 0) return;

            menu.addItem((item) => {
                item.setTitle(t("editHistory.menu.aiSubmenu"))
                    .setIcon("sparkles")
                    .setSection("action");
                const sub = (item as unknown as { setSubmenu: () => SubmenuHost }).setSubmenu();

                for (const extra of staticExtras) {
                    sub.addItem((s) => {
                        s.setTitle(extra.title);
                        s.setIcon(extra.icon);
                        s.onClick(() => extra.onClick(editor, info));
                    });
                }

                if (staticExtras.length > 0 && dynamicExtras.length > 0) {
                    sub.addSeparator?.();
                }

                for (const extra of dynamicExtras) {
                    sub.addItem((s) => {
                        s.setTitle(extra.title);
                        s.setIcon(extra.icon);
                        s.onClick(() => extra.onClick(editor, info));
                    });
                }
            });
        }),
    );
}
