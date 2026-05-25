/**
 * AI Edit History view — sidebar `ItemView` exposing TWO separate audit logs
 * under a single tabbed panel:
 *
 *   1. **Rewrites** — selection-rewrite tasks triggered from the editor
 *      (expand / shorten / polish). Thin presenter on top of
 *      {@link EditHistoryStore}; subscribes to `change` / `task-updated`
 *      and patches a single item element on streaming updates.
 *   2. **File changes** — a flat log of vault mutations performed by AI
 *      tool calls (create / modify / rename / delete). Presenter on top of
 *      {@link VaultEditLogStore}; entries are grouped by the sessionId
 *      they originated from so related edits stay together.
 *
 * All UI text flows through `t()` so the 5 supported locales stay in sync.
 */

import { ItemView, WorkspaceLeaf, IconName, Menu, Notice, MarkdownView, TFile, TFolder, setIcon, setTooltip } from "obsidian";
import type NoteAssistantPlugin from "../main";
import { t } from "../i18n";
import { copyToClipboard } from "../utils/clipboard";
import type { EditHistoryStore } from "./edit-history-store";
import type { EditTask, EditTaskStatus, EditAction } from "./edit-history-types";
import { runEditTask } from "./edit-history-runner";
import type { VaultEditLogStore } from "./vault-edit-log-store";
import type { VaultEditLogEntry, VaultEditKind } from "./vault-edit-log-types";

const STATUS_ICONS: Record<EditTaskStatus, IconName> = {
    pending: "clock",
    running: "loader-2",
    applied: "check-circle-2",
    cancelled: "circle-slash",
    failed: "alert-triangle",
    stale: "unlink",
};

const ACTION_ICONS: Record<EditAction, IconName> = {
    expand: "maximize-2",
    shorten: "minimize-2",
    polish: "wand-2",
    continue: "chevrons-right",
};

/**
 * Lucide icon per mutation kind shown on each file-change row. Kept here
 * (not in the locale bundle) because icons are cross-locale and sharing
 * the mapping keeps the view declarative.
 */
const KIND_ICONS: Record<VaultEditKind, IconName> = {
    create: "file-plus",
    modify: "file-pen",
    rename: "arrow-right-left",
    delete: "trash-2",
};

/** Which tab is currently showing. Held only in memory (not persisted). */
type ActiveTab = "rewrites" | "fileChanges";

/** Tab switcher icons (labels come from `t("editHistory.tab.*")` via tooltips). */
const TAB_ICONS: Record<ActiveTab, IconName> = {
    rewrites: "pen-line",
    fileChanges: "folder-tree",
};

/**
 * Subset of `EditTask` fields that, when changed, force the row to be
 * fully rebuilt (different buttons, different status border, etc.).
 * Anything outside this set — most notably `rewrittenText` / `bytes` /
 * `previewAfter` — can be patched in place without disturbing hover
 * states or tooltips.
 */
interface ItemSnapshot {
    status: EditTask["status"];
    action: EditTask["action"];
    filePath: string;
    error: string | undefined;
    previewBefore: string;
    originalText: string;
    profileName: string;
    modelName: string;
}

function snapshotOf(task: EditTask): ItemSnapshot {
    return {
        status: task.status,
        action: task.action,
        filePath: task.filePath,
        error: task.error,
        previewBefore: task.previewBefore,
        originalText: task.originalText,
        profileName: task.profileName,
        modelName: task.modelName,
    };
}

function snapshotsEqual(a: ItemSnapshot, b: ItemSnapshot): boolean {
    return (
        a.status === b.status &&
        a.action === b.action &&
        a.filePath === b.filePath &&
        a.error === b.error &&
        a.previewBefore === b.previewBefore &&
        a.originalText === b.originalText &&
        a.profileName === b.profileName &&
        a.modelName === b.modelName
    );
}

export class EditHistoryView extends ItemView {
    static readonly VIEW_TYPE = "ai-edit-history-view";

    /** The current tab. */
    private activeTab: ActiveTab = "rewrites";

    /** Header container — re-rendered on tab switch to rewire tab buttons / toolbar. */
    private headerEl!: HTMLElement;
    /** Container that hosts either the rewrites list or the file-changes list. */
    private bodyEl!: HTMLElement;

    /** Rewrites list host + per-task caches. Populated lazily per tab mount. */
    private listEl: HTMLElement | null = null;
    /** Maps task id → its rendered list-item element, for in-place updates. */
    private readonly itemEls = new Map<string, HTMLElement>();
    /**
     * Snapshot of fields used to decide whether `patchItem` can do a cheap
     * in-place update or must do a full row rebuild. Streaming chunks land
     * dozens of times per second; rebuilding the row each time causes hover
     * states to flicker and tooltips to be re-registered.
     */
    private readonly itemSnapshots = new Map<string, ItemSnapshot>();

    /** File-changes list host, only present while that tab is mounted. */
    private fileChangesListEl: HTMLElement | null = null;

    /** Disposers returned by `store.on(...)`. */
    private readonly unsubscribers: Array<() => void> = [];

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: NoteAssistantPlugin,
        private readonly store: EditHistoryStore,
        private readonly logStore: VaultEditLogStore,
    ) {
        super(leaf);
    }

    getViewType(): string { return EditHistoryView.VIEW_TYPE; }
    getDisplayText(): string { return t("editHistory.title"); }
    getIcon(): IconName { return "wand-sparkles"; }

    async onOpen(): Promise<void> {
        const root = this.contentEl;
        root.empty();
        root.addClass("ai-edit-history-view");

        // Header host (re-rendered on tab switch to swap the toolbar) +
        // body host (list container).
        this.headerEl = root.createEl("div", { cls: "ai-edit-history-header-host" });
        this.bodyEl = root.createEl("div", { cls: "ai-edit-history-body" });

        this.renderHeader();
        this.renderActiveTabBody();

        // Subscribe once; router decides what to repaint based on the
        // currently active tab.
        this.unsubscribers.push(this.store.on("change", () => {
            if (this.activeTab === "rewrites") this.renderRewritesList();
        }));
        this.unsubscribers.push(this.store.on("task-updated", (task) => {
            if (this.activeTab === "rewrites") this.patchItem(task);
        }));
        this.unsubscribers.push(this.logStore.on("change", () => {
            if (this.activeTab === "fileChanges") this.renderFileChangesList();
        }));
    }

    async onClose(): Promise<void> {
        for (const fn of this.unsubscribers) {
            try { fn(); } catch { /* ignore */ }
        }
        this.unsubscribers.length = 0;
        this.itemEls.clear();
        this.itemSnapshots.clear();
        this.listEl = null;
        this.fileChangesListEl = null;
        this.contentEl.empty();
    }

    // ── Header & tabs ────────────────────────────────────────────────────

    private renderHeader(): void {
        const header = this.headerEl;
        header.empty();
        header.addClass("ai-edit-history-header");

        // Title + tab switcher on the left.
        const left = header.createEl("div", { cls: "ai-edit-history-header-left" });
        left.createEl("div", { cls: "ai-edit-history-title", text: t("editHistory.title") });

        const tabs = left.createEl("div", { cls: "ai-edit-history-tabs" });
        this.makeTabButton(tabs, "rewrites", TAB_ICONS.rewrites, t("editHistory.tab.rewrites"));
        this.makeTabButton(tabs, "fileChanges", TAB_ICONS.fileChanges, t("editHistory.tab.fileChanges"));

        // Toolbar on the right (tab-specific).
        const actions = header.createEl("div", { cls: "ai-edit-history-header-actions" });
        if (this.activeTab === "rewrites") {
            const clearBtn = actions.createEl("button", { cls: "clickable-icon" });
            setIcon(clearBtn, "trash-2");
            setTooltip(clearBtn, t("editHistory.button.clearFinished"));
            clearBtn.addEventListener("click", () => this.store.clearFinished());
        } else {
            const clearBtn = actions.createEl("button", { cls: "clickable-icon" });
            setIcon(clearBtn, "trash-2");
            setTooltip(clearBtn, t("editHistory.fileChanges.clearAll"));
            clearBtn.addEventListener("click", () => this.logStore.clear());
        }
    }

    private makeTabButton(host: HTMLElement, id: ActiveTab, icon: IconName, tooltipLabel: string): HTMLElement {
        const btn = host.createEl("button", {
            cls: `ai-edit-history-tab${this.activeTab === id ? " is-active" : ""}`,
            attr: { "aria-label": tooltipLabel, type: "button" },
        });
        setIcon(btn, icon);
        setTooltip(btn, tooltipLabel);
        btn.addEventListener("click", () => {
            if (this.activeTab === id) return;
            this.activeTab = id;
            this.renderHeader();
            this.renderActiveTabBody();
        });
        return btn;
    }

    private renderActiveTabBody(): void {
        this.bodyEl.empty();
        this.itemEls.clear();
        this.itemSnapshots.clear();
        this.listEl = null;
        this.fileChangesListEl = null;

        if (this.activeTab === "rewrites") {
            this.listEl = this.bodyEl.createEl("div", { cls: "ai-edit-history-list" });
            this.renderRewritesList();
        } else {
            this.fileChangesListEl = this.bodyEl.createEl("div", {
                cls: "ai-edit-history-list ai-edit-history-list--file-changes",
            });
            this.renderFileChangesList();
        }
    }

    // ── Rewrites tab ────────────────────────────────────────────────────

    private renderRewritesList(): void {
        if (!this.listEl) return;
        this.listEl.empty();
        this.itemEls.clear();
        this.itemSnapshots.clear();

        const tasks = this.store.tasks;
        if (tasks.length === 0) {
            this.listEl.createEl("div", {
                cls: "ai-edit-history-empty",
                text: t("editHistory.empty"),
            });
            return;
        }

        for (const task of tasks) {
            const el = this.renderItem(task);
            this.listEl.appendChild(el);
            this.itemEls.set(task.id, el);
            this.itemSnapshots.set(task.id, snapshotOf(task));
        }
    }

    /**
     * Update a single item in response to `task-updated`.
     *
     * Streaming chunks fire this dozens of times per second. To keep hover
     * states stable and avoid re-registering tooltips on every chunk, we
     * compare a snapshot of structural fields and only rebuild the row
     * when something other than the streaming text has changed. The hot
     * path (status="running", text growing) walks a couple of nodes and
     * returns.
     */
    private patchItem(task: EditTask): void {
        if (!this.listEl) return;
        const existing = this.itemEls.get(task.id);
        const prevSnap = this.itemSnapshots.get(task.id);
        if (!existing || !prevSnap) {
            this.renderRewritesList();
            return;
        }

        const nextSnap = snapshotOf(task);
        if (snapshotsEqual(prevSnap, nextSnap)) {
            this.updateItemInPlace(existing, task);
            return;
        }

        const fresh = this.renderItem(task);
        const wasExpanded = existing.hasClass("is-expanded");
        existing.replaceWith(fresh);
        this.itemEls.set(task.id, fresh);
        this.itemSnapshots.set(task.id, nextSnap);
        if (wasExpanded) fresh.addClass("is-expanded");
    }

    /**
     * Cheap path: only mutate the few text nodes that change while the
     * task is streaming. No `replaceWith`, no icon/tooltip re-registration.
     */
    private updateItemInPlace(el: HTMLElement, task: EditTask): void {
        const bytesEl = el.querySelector<HTMLElement>(".ai-edit-history-bytes");
        if (bytesEl) {
            const txt = t("editHistory.progress.bytes", { n: task.bytes });
            if (bytesEl.textContent !== txt) bytesEl.textContent = txt;
        }

        // Details panel may be expanded; refresh the "after" preview text in
        // place if so. The rest of the details (titles/meta) is unchanged
        // while streaming.
        if (el.hasClass("is-expanded")) {
            const afterPre = el.querySelector<HTMLElement>(".ai-edit-history-preview-text");
            if (afterPre) {
                const txt = task.rewrittenText || "—";
                if (afterPre.textContent !== txt) afterPre.textContent = txt;
            }
        }
    }

    private renderItem(task: EditTask): HTMLElement {
        const el = createEl("div", {
            cls: `ai-edit-history-item ai-edit-history-item--${task.status}`,
        });
        el.dataset.taskId = task.id;

        // ── Top row ────────────────────────────────────────────────────
        const head = el.createEl("div", { cls: "ai-edit-history-item-head" });

        // Action is conveyed by icon only; the localized name moves to a tooltip
        // so each row stays compact (especially on mobile / narrow sidebars).
        const actionIcon = head.createEl("span", { cls: "ai-edit-history-action-icon" });
        setIcon(actionIcon, ACTION_ICONS[task.action]);
        setTooltip(actionIcon, t(`editHistory.action.${task.action}`));

        // File link sits inline on the head row, taking the remaining space and
        // ellipsis-truncating when the sidebar is narrow.
        const fileLabel = head.createEl("a", { cls: "ai-edit-history-file" });
        const fileText = task.filePath ?? t("editHistory.unsavedDraft");
        fileLabel.setText(fileText);
        if (task.filePath) {
            setTooltip(fileLabel, task.filePath);
            fileLabel.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                void this.openTaskFile(task);
            });
        }

        if (task.status === "running") {
            head.createEl("span", {
                cls: "ai-edit-history-bytes",
                text: t("editHistory.progress.bytes", { n: task.bytes }),
            });
        }

        const buttonRow = head.createEl("div", { cls: "ai-edit-history-buttons" });

        // Status indicator lives at the head of the button group: a non-interactive
        // icon that mirrors the row's status (also shown via the left border tint).
        const statusIcon = buttonRow.createEl("span", {
            cls: `ai-edit-history-status-icon ai-edit-history-status-icon--${task.status}`,
        });
        setIcon(statusIcon, STATUS_ICONS[task.status]);
        // For failed tasks, append the captured error reason to the tooltip
        // so hovering the status icon reveals the cause without forcing the
        // user to expand the row.
        const statusLabel = t(`editHistory.status.${task.status}`);
        const statusTooltip = task.status === "failed" && task.error
            ? `${statusLabel}: ${task.error}`
            : statusLabel;
        setTooltip(statusIcon, statusTooltip);

        if (task.status === "running" || task.status === "pending") {
            this.makeIconButton(buttonRow, "x", t("common.cancel"), () => {
                this.store.cancel(task.id);
            });
        }
        if (task.status === "failed" || task.status === "cancelled" || task.status === "stale") {
            this.makeIconButton(buttonRow, "rotate-cw", t("editHistory.button.retry"), () => {
                this.retryTask(task);
            });
        }
        this.makeIconButton(buttonRow, "trash", t("editHistory.button.remove"), (ev) => {
            ev.stopPropagation();
            this.store.remove(task.id);
        });

        // ── Inline preview (always one-line truncated) ────────────────
        const preview = el.createEl("div", { cls: "ai-edit-history-preview-line" });
        preview.setText(task.previewBefore || task.originalText.slice(0, 120));

        // ── Details (toggle on click on item except buttons) ──────────
        const details = el.createEl("div", { cls: "ai-edit-history-details" });
        this.renderDetails(details, task);

        head.addEventListener("click", (ev) => {
            const target = ev.target as HTMLElement;
            // Avoid toggling when clicking on file link or buttons.
            if (target.closest(".ai-edit-history-buttons")) return;
            if (target.closest(".ai-edit-history-file")) return;
            el.toggleClass("is-expanded", !el.hasClass("is-expanded"));
        });

        // Right-click / long-press menu: copy original / rewritten text.
        // Attached to the whole row so users don't have to expand it first.
        this.attachItemContextMenu(el, task);

        return el;
    }

    /**
     * Context menu offering quick "copy original" / "copy result" actions.
     *
     * - Original text is always available (set at enqueue time), so the
     *   first item is always present.
     * - Rewritten text is empty for `pending` tasks and partially filled
     *   while `running`; we hide the "copy result" item when nothing has
     *   been produced yet to avoid copying an empty string.
     * - Right-clicks inside the button strip are left to the browser /
     *   Obsidian default so we don't shadow the per-button affordances.
     */
    private attachItemContextMenu(rootEl: HTMLElement, task: EditTask): void {
        rootEl.addEventListener("contextmenu", (ev: MouseEvent) => {
            const target = ev.target as HTMLElement | null;
            if (target?.closest(".ai-edit-history-buttons")) return;

            ev.preventDefault();
            ev.stopPropagation();

            // Always re-read the latest task from the store: streaming may
            // have grown `rewrittenText` since this row was last rendered.
            const latest = this.store.get(task.id) ?? task;

            const menu = new Menu();

            menu.addItem((item) => {
                item.setTitle(t("editHistory.menu.copyOriginal"));
                item.setIcon("clipboard");
                item.onClick(async () => {
                    await copyToClipboard(latest.originalText);
                });
            });

            if (latest.rewrittenText) {
                menu.addItem((item) => {
                    item.setTitle(t("editHistory.menu.copyResult"));
                    item.setIcon("clipboard-copy");
                    item.onClick(async () => {
                        await copyToClipboard(latest.rewrittenText);
                    });
                });
            }

            menu.showAtPosition({ x: ev.clientX, y: ev.clientY });
        });
    }

    private renderDetails(host: HTMLElement, task: EditTask): void {
        host.empty();

        if (task.status === "failed" && task.error) {
            const err = host.createEl("div", { cls: "ai-edit-history-error" });
            err.setText(task.error);
        }

        // Single preview column: the inline collapsed line already shows the
        // (truncated) original text, so the details panel only needs to expose
        // the rewritten result. We keep the `.ai-edit-history-preview-grid`
        // wrapper for consistent spacing/border styling.
        const grid = host.createEl("div", { cls: "ai-edit-history-preview-grid" });

        const afterCol = grid.createEl("div", { cls: "ai-edit-history-preview-col" });
        afterCol.createEl("div", {
            cls: "ai-edit-history-preview-title",
            text: t("editHistory.preview.after"),
        });
        afterCol.createEl("pre", {
            cls: "ai-edit-history-preview-text",
            text: task.rewrittenText || "—",
        });

        const meta = host.createEl("div", { cls: "ai-edit-history-meta" });
        const date = new Date(task.createdAt).toLocaleString();
        meta.setText(`${task.profileName} · ${task.modelName} · ${date}`);
    }

    private makeIconButton(
        host: HTMLElement,
        icon: IconName,
        tooltip: string,
        handler: (ev: MouseEvent) => void,
    ): HTMLElement {
        const btn = host.createEl("button", { cls: "clickable-icon ai-edit-history-icon-btn" });
        setIcon(btn, icon);
        setTooltip(btn, tooltip);
        btn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            handler(ev);
        });
        return btn;
    }

    // ── Rewrites actions ────────────────────────────────────────────────

    private async openTaskFile(task: EditTask): Promise<void> {
        if (!task.filePath) return;
        // Use Obsidian's standard open behaviour so click replaces the
        // active tab and Cmd/Ctrl-click opens a new tab, consistent with
        // how wikilinks work everywhere else in the vault.
        await this.app.workspace.openLinkText(task.filePath, '', false);
        // Best-effort: restore the original selection in the opened editor.
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file?.path === task.filePath) {
            try {
                view.editor.setSelection(
                    { line: task.fromLine, ch: task.fromCh },
                    { line: task.toLine, ch: task.toCh },
                );
                view.editor.scrollIntoView(
                    {
                        from: { line: task.fromLine, ch: task.fromCh },
                        to: { line: task.toLine, ch: task.toCh },
                    },
                    true,
                );
            } catch {
                /* ignore — coordinates may be out of range now */
            }
        }
    }

    private retryTask(task: EditTask): void {
        const { task: fresh, controller } = this.store.enqueue({
            action: task.action,
            filePath: task.filePath,
            fromLine: task.fromLine,
            fromCh: task.fromCh,
            toLine: task.toLine,
            toCh: task.toCh,
            originalText: task.originalText,
            profileName: task.profileName,
            modelName: task.modelName,
        });
        void runEditTask(this.plugin, this.store, fresh, controller.signal);
    }

    // ── File changes tab ────────────────────────────────────────────────

    private renderFileChangesList(): void {
        const list = this.fileChangesListEl;
        if (!list) return;
        list.empty();

        const entries = this.logStore.entries;
        if (entries.length === 0) {
            list.createEl("div", {
                cls: "ai-edit-history-empty",
                text: t("editHistory.fileChanges.empty"),
            });
            return;
        }

        // Group consecutive entries that share the same sessionId. Entries
        // are already sorted newest-first; we preserve that order and only
        // collapse adjacent same-session runs. This keeps the UI close to
        // "one chat turn, one group" without hiding interleaved edits from
        // concurrent sessions.
        type Group = { sessionId: string | undefined; entries: VaultEditLogEntry[] };
        const groups: Group[] = [];
        for (const entry of entries) {
            const last = groups[groups.length - 1];
            if (last && last.sessionId === entry.sessionId) {
                last.entries.push(entry);
            } else {
                groups.push({ sessionId: entry.sessionId, entries: [entry] });
            }
        }

        for (const group of groups) {
            if (group.sessionId) {
                const sid = group.sessionId;
                const metaLine = this.plugin.sessionManager.getSessionMetadataDisplayLine(sid);
                const tooltipText =
                    metaLine !== undefined && metaLine.length > 0 ? metaLine : sid;
                const header = list.createEl("div", {
                    cls: "ai-edit-history-group-title",
                    text: sid,
                });
                setTooltip(header, tooltipText);
            } else {
                list.createEl("div", {
                    cls: "ai-edit-history-group-title",
                    text: t("editHistory.fileChanges.sessionUnknown"),
                });
            }

            for (const entry of group.entries) {
                list.appendChild(this.renderFileChangeItem(entry));
            }
        }
    }

    private renderFileChangeItem(entry: VaultEditLogEntry): HTMLElement {
        const el = createEl("div", {
            cls: `ai-edit-history-item ai-edit-history-item--log ai-edit-history-item--log-${entry.kind}`,
        });
        el.dataset.entryId = entry.id;

        const head = el.createEl("div", { cls: "ai-edit-history-item-head" });

        // Kind icon on the left (create / modify / rename / delete).
        const kindIcon = head.createEl("span", { cls: "ai-edit-history-action-icon" });
        setIcon(kindIcon, KIND_ICONS[entry.kind]);
        const kindLabelKey =
            entry.kind === "delete"
                ? "common.delete"
                : `editHistory.fileChanges.kind.${entry.kind}`;
        setTooltip(kindIcon, t(kindLabelKey));

        const canOpen = entry.kind !== "delete";

        // File path — clickable for everything except `delete` entries,
        // where the referenced path is no longer resolvable.
        const fileEl = head.createEl("a", {
            cls: "ai-edit-history-file" + (canOpen ? "" : " is-disabled"),
        });
        fileEl.setText(entry.path);
        if (canOpen) {
            setTooltip(fileEl, entry.path);
            fileEl.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                void this.openLogEntry(entry);
            });
        } else {
            setTooltip(fileEl, t("editHistory.fileChanges.deletedHint"));
        }

        // Secondary line: tool name + timestamp (+ previous path for renames).
        const meta = el.createEl("div", { cls: "ai-edit-history-preview-line" });
        const ts = new Date(entry.createdAt).toLocaleString();
        const parts: string[] = [entry.toolName, ts];
        if (entry.kind === "rename" && entry.previousPath) {
            parts.push(t("editHistory.fileChanges.renamedFrom", { 0: entry.previousPath }));
        }
        meta.setText(parts.join(" · "));

        return el;
    }

    /**
     * Open the file referenced by a file-change log entry. Renames point at
     * the NEW path (which is what the log stores). Deletes can't be opened
     * (their row is rendered as non-interactive) and never reach this path.
     */
    private async openLogEntry(entry: VaultEditLogEntry): Promise<void> {
        const abs = this.app.vault.getAbstractFileByPath(entry.path);
        if (abs instanceof TFile) {
            // Use Obsidian's standard open behaviour.
            await this.app.workspace.openLinkText(entry.path, '', false);
            return;
        }
        if (abs instanceof TFolder) {
            // Folders have no default open action; reveal in the file
            // explorer if we can, otherwise surface a notice.
            new Notice(entry.path);
            return;
        }
        new Notice(t("editHistory.notice.fileMissing"));
    }
}
