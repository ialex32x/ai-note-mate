/**
 * Editor right-click menu + command-palette entry points for the
 * AI Edit History feature, plus a shared "AI" submenu host on `editor-menu`.
 *
 * For each of `expand` / `shorten` / `polish`:
 * - registers a command palette command,
 * - registers a sub-menu item under a parent "AI" entry on `editor-menu`.
 *
 * Other AI-related editor actions (e.g. "Send to AI Session") may be
 * contributed by the caller via `extraSubmenuItems` so they share the
 * same parent submenu instead of cluttering the top-level editor menu.
 *
 * Rewrite paths funnel into `startRewriteFromEditor`, which validates the
 * selection, captures coordinates, enqueues a task, and kicks off the
 * runner in the background. The view auto-reveals so users see progress.
 */

import { Editor, MarkdownView, Notice, MarkdownFileInfo, IconName } from "obsidian";
import type NoteAssistantPlugin from "../main";
import { t } from "../i18n";
import type { EditAction } from "./edit-history-types";
import { MAX_EDIT_SELECTION_SIZE } from "./edit-history-types";
import type { EditHistoryStore } from "./edit-history-store";
import { runEditTask } from "./edit-history-runner";
import { createProviderForActiveProfile } from "../utils/provider-factory";
import { EditHistoryView } from "./edit-history-view";

const ACTIONS: readonly EditAction[] = ["expand", "shorten", "polish", "continue"];

const ACTION_ICONS: Record<EditAction, IconName> = {
    expand: "maximize-2",
    shorten: "minimize-2",
    polish: "wand-2",
    continue: "chevrons-right",
};

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
// `addSeparator` is available on the underlying `Menu` instance and we
// use it to visually group the rewrite actions vs. caller-contributed
// extras like "Send to AI Session".
type SubmenuHost = {
    addItem: (cb: (s: {
        setTitle: (n: string) => unknown;
        setIcon: (n: string) => unknown;
        onClick: (cb: () => void) => unknown;
    }) => void) => unknown;
    addSeparator?: () => unknown;
};

/**
 * Wire up the editor menu and command palette commands.
 *
 * `revealView` is supplied by the plugin so we don't have to re-implement
 * leaf creation logic here. `extraSubmenuItems` lets other modules add
 * sibling actions (e.g. "Send to AI Session") under the same "AI" parent.
 */
export function registerRewriteSelection(
    plugin: NoteAssistantPlugin,
    store: EditHistoryStore,
    revealView: () => Promise<void>,
    extraSubmenuItems: readonly AISubmenuItem[] = [],
): void {
    // ── editor-menu ──────────────────────────────────────────────────────
    // NOTE: the third callback arg (`info`) carries the `MarkdownView`/`MarkdownFileInfo`
    // for the editor that opened the menu. Without it we cannot resolve the
    // file path on write-back, and every task ends up `stale`.
    plugin.registerEvent(
        plugin.app.workspace.on("editor-menu", (menu, editor, info) => {
            const sel = editor.getSelection();
            const hasSelection = !!(sel && sel.trim());

            // Decide which extras should appear for this invocation up-front
            // so we can suppress the entire parent item when nothing inside
            // it would be actionable.
            const visibleExtras = extraSubmenuItems.filter(
                (e) => !e.isAvailable || e.isAvailable(editor, info),
            );
            if (!hasSelection && visibleExtras.length === 0) return;

            menu.addItem((item) => {
                item.setTitle(t("editHistory.menu.aiSubmenu"))
                    .setIcon("sparkles")
                    .setSection("action");
                const sub = (item as unknown as { setSubmenu: () => SubmenuHost }).setSubmenu();
                if (hasSelection) {
                    for (const action of ACTIONS) {
                        sub.addItem((s) => {
                            s.setTitle(t(`editHistory.action.${action}`));
                            s.setIcon(ACTION_ICONS[action]);
                            s.onClick(() => {
                                startRewriteFromEditor(plugin, store, action, editor, revealView, info);
                            });
                        });
                    }
                }
                // Visually separate the rewrite trio from caller-contributed
                // extras (e.g. "Send to AI Session") only when both groups
                // are actually present in this menu invocation.
                if (hasSelection && visibleExtras.length > 0) {
                    sub.addSeparator?.();
                }
                for (const extra of visibleExtras) {
                    sub.addItem((s) => {
                        s.setTitle(extra.title);
                        s.setIcon(extra.icon);
                        s.onClick(() => extra.onClick(editor, info));
                    });
                }
            });
        }),
    );

    // ── command palette ─────────────────────────────────────────────────
    // NOTE: on mobile, commands without an `icon` render as a `?` in the
    // command bar / command list, so we always attach the same icon used
    // in the editor-menu submenu to keep the UX consistent across surfaces.
    for (const action of ACTIONS) {
        plugin.addCommand({
            id: `ai-rewrite-${action}`,
            name: t(`editHistory.command.${action}`),
            icon: ACTION_ICONS[action],
            editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
                startRewriteFromEditor(plugin, store, action, editor, revealView, ctx);
            },
        });
    }
}

/**
 * Validate the editor state, snapshot the selection, enqueue a task and
 * launch the runner. All user-facing errors surface via `Notice`.
 */
function startRewriteFromEditor(
    plugin: NoteAssistantPlugin,
    store: EditHistoryStore,
    action: EditAction,
    editor: Editor,
    revealView: () => Promise<void>,
    ctx?: MarkdownView | MarkdownFileInfo,
): void {
    const selection = editor.getSelection();
    if (!selection || !selection.trim()) {
        new Notice(t("editHistory.notice.emptySelection"));
        return;
    }
    if (selection.length > MAX_EDIT_SELECTION_SIZE) {
        new Notice(t("editHistory.notice.tooLarge", { size: MAX_EDIT_SELECTION_SIZE }));
        return;
    }

    // Validate provider + key before we even create a task — surfacing the
    // configuration error here keeps the history view free of trivial
    // "missing API key" failures that the user can fix in one click.
    let providerInfo: { profileName: string; modelName: string };
    try {
        const resolved = createProviderForActiveProfile(plugin);
        providerInfo = { profileName: resolved.profileName, modelName: resolved.modelName };
        // Heuristic: the underlying provider validates apiKey lazily, but if
        // the resolved active profile has no key at all we can short-circuit.
        const profile = plugin.settings.profiles.find(p => p.id === plugin.settings.activeProfileId)
            ?? plugin.settings.profiles[0];
        const rawKey = profile?.apiKey ?? "";
        const stored = profile ? plugin.app.secretStorage.getSecret(profile.apiKey) : "";
        if (!rawKey && !stored) {
            new Notice(t("editHistory.notice.noProfile"));
            return;
        }
    } catch {
        new Notice(t("editHistory.notice.noProfile"));
        return;
    }

    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const filePath = resolveFilePath(plugin, ctx);

    const { task, controller } = store.enqueue({
        action,
        filePath,
        fromLine: from.line,
        fromCh: from.ch,
        toLine: to.line,
        toCh: to.ch,
        originalText: selection,
        profileName: providerInfo.profileName,
        modelName: providerInfo.modelName,
    });

    // Reveal the history view so the user sees progress immediately.
    void revealView();

    // Fire and forget — runEditTask never throws.
    void runEditTask(plugin, store, task, controller.signal);
}

function resolveFilePath(
    plugin: NoteAssistantPlugin,
    ctx?: MarkdownView | MarkdownFileInfo,
): string {
    // 1) Prefer the ctx supplied by the caller (command palette / editor-menu).
    const fromCtx = (ctx as { file?: { path?: string } } | undefined)?.file?.path;
    if (fromCtx) return fromCtx;

    // 2) Fallback: ask workspace for the currently active editor/view. This
    //    covers older command paths and any case where the third arg of
    //    `editor-menu` is missing.
    const ws = plugin.app.workspace;
    const activeEditor = (ws as unknown as { activeEditor?: MarkdownFileInfo | null }).activeEditor;
    const fromActive = (activeEditor as { file?: { path?: string } } | null | undefined)?.file?.path;
    if (fromActive) return fromActive;

    const activeView = ws.getActiveViewOfType(MarkdownView);
    return activeView?.file?.path ?? "";
}

/** Re-exports so main.ts can register the view alongside command wiring. */
export { EditHistoryView };
