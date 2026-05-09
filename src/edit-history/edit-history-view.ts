/**
 * AI Edit History view — sidebar `ItemView` listing every rewrite task.
 *
 * The view is a thin presenter on top of `EditHistoryStore`:
 * - subscribes to the store's `change` and `task-updated` events,
 * - re-renders the list on structural changes,
 * - patches a single item element on streaming updates (no full rerender).
 *
 * All UI text flows through `t()` so the 5 supported locales stay in sync.
 */

import { ItemView, WorkspaceLeaf, IconName, Menu, Notice, MarkdownView, TFile, setIcon, setTooltip } from "obsidian";
import type NoteAssistantPlugin from "../main";
import { t } from "../i18n";
import type { EditHistoryStore } from "./edit-history-store";
import type { EditTask, EditTaskStatus, EditAction } from "./edit-history-types";
import { runEditTask } from "./edit-history-runner";

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

    private listEl!: HTMLElement;
    /** Maps task id → its rendered list-item element, for in-place updates. */
    private readonly itemEls = new Map<string, HTMLElement>();
    /**
     * Snapshot of fields used to decide whether `patchItem` can do a cheap
     * in-place update or must do a full row rebuild. Streaming chunks land
     * dozens of times per second; rebuilding the row each time causes hover
     * states to flicker and tooltips to be re-registered.
     */
    private readonly itemSnapshots = new Map<string, ItemSnapshot>();
    /** Disposers returned by `store.on(...)`. */
    private readonly unsubscribers: Array<() => void> = [];

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: NoteAssistantPlugin,
        private readonly store: EditHistoryStore,
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

        // Header / toolbar
        const header = root.createEl("div", { cls: "ai-edit-history-header" });
        header.createEl("div", { cls: "ai-edit-history-title", text: t("editHistory.title") });

        const actions = header.createEl("div", { cls: "ai-edit-history-header-actions" });

        const cancelAllBtn = actions.createEl("button", { cls: "clickable-icon" });
        setIcon(cancelAllBtn, "square");
        setTooltip(cancelAllBtn, t("editHistory.button.cancelAll"));
        cancelAllBtn.addEventListener("click", () => this.store.cancelAll());

        const clearBtn = actions.createEl("button", { cls: "clickable-icon" });
        setIcon(clearBtn, "trash-2");
        setTooltip(clearBtn, t("editHistory.button.clearFinished"));
        clearBtn.addEventListener("click", () => this.store.clearFinished());

        // List
        this.listEl = root.createEl("div", { cls: "ai-edit-history-list" });

        this.renderList();

        this.unsubscribers.push(this.store.on("change", () => this.renderList()));
        this.unsubscribers.push(this.store.on("task-updated", (task) => this.patchItem(task)));
    }

    async onClose(): Promise<void> {
        for (const fn of this.unsubscribers) {
            try { fn(); } catch { /* ignore */ }
        }
        this.unsubscribers.length = 0;
        this.itemEls.clear();
        this.itemSnapshots.clear();
        this.contentEl.empty();
    }

    // ── Rendering ────────────────────────────────────────────────────────

    private renderList(): void {
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
        const existing = this.itemEls.get(task.id);
        const prevSnap = this.itemSnapshots.get(task.id);
        if (!existing || !prevSnap) {
            this.renderList();
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
        setTooltip(statusIcon, t(`editHistory.status.${task.status}`));

        if (task.status === "running" || task.status === "pending") {
            this.makeIconButton(buttonRow, "x", t("editHistory.button.cancel"), () => {
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
                    await this.copyToClipboard(latest.originalText);
                });
            });

            if (latest.rewrittenText) {
                menu.addItem((item) => {
                    item.setTitle(t("editHistory.menu.copyResult"));
                    item.setIcon("clipboard-copy");
                    item.onClick(async () => {
                        await this.copyToClipboard(latest.rewrittenText);
                    });
                });
            }

            menu.showAtPosition({ x: ev.clientX, y: ev.clientY });
        });
    }

    private async copyToClipboard(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            new Notice(t("view.copied"));
        } catch (err) {
            console.error("Failed to copy to clipboard:", err);
        }
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

    // ── Actions ─────────────────────────────────────────────────────────

    private async openTaskFile(task: EditTask): Promise<void> {
        if (!task.filePath) return;
        const file = this.app.vault.getAbstractFileByPath(task.filePath);
        if (!(file instanceof TFile)) {
            new Notice(t("editHistory.notice.fileMissing"));
            return;
        }
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
        // Best-effort: restore the original selection in the opened editor.
        const view = leaf.view;
        if (view instanceof MarkdownView) {
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
}
