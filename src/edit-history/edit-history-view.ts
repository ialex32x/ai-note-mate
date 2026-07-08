/**
 * AI Edit History view — sidebar panel listing vault mutations performed
 * by AI tool calls (create / modify / rename / delete).
 *
 * Thin presenter on top of {@link VaultEditLogStore}; entries are grouped
 * by sessionId so related edits from the same chat stay together.
 */

import { ItemView, WorkspaceLeaf, IconName, Notice, TFile, TFolder, setIcon, setTooltip } from "obsidian";
import type NoteAssistantPlugin from "../main";
import { t } from "../i18n";
import type { VaultEditLogStore } from "./vault-edit-log-store";
import type { VaultEditLogEntry, VaultEditKind } from "./vault-edit-log-types";

const KIND_ICONS: Record<VaultEditKind, IconName> = {
    create: "file-plus",
    modify: "file-pen",
    rename: "arrow-right-left",
    delete: "trash-2",
};

export class EditHistoryView extends ItemView {
    static readonly VIEW_TYPE = "ai-edit-history-view";

    private listEl!: HTMLElement;
    private readonly unsubscribers: Array<() => void> = [];

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: NoteAssistantPlugin,
        private readonly logStore: VaultEditLogStore,
    ) {
        super(leaf);
    }

    getViewType(): string { return EditHistoryView.VIEW_TYPE; }
    getDisplayText(): string { return t("editHistory.title"); }
    getIcon(): IconName { return "folder-tree"; }

    async onOpen(): Promise<void> {
        const root = this.contentEl;
        root.empty();
        root.addClass("ai-edit-history-view");

        const header = root.createDiv({ cls: "ai-edit-history-header" });
        const left = header.createDiv({ cls: "ai-edit-history-header-left" });
        left.createDiv({ cls: "ai-edit-history-title", text: t("editHistory.title") });

        const actions = header.createDiv({ cls: "ai-edit-history-header-actions" });
        const clearBtn = actions.createEl("button", { cls: "clickable-icon" });
        setIcon(clearBtn, "trash-2");
        setTooltip(clearBtn, t("editHistory.fileChanges.clearAll"));
        clearBtn.addEventListener("click", () => this.logStore.clear());

        this.listEl = root.createDiv({
            cls: "ai-edit-history-list ai-edit-history-list--file-changes",
        });

        // Subscribe before the initial render so we don't miss a 'change'
        // event that fires between rendering and subscribing (e.g. if
        // vaultEditLog.load() completes in another microtask).
        this.unsubscribers.push(this.logStore.on("change", () => this.renderList()));
        this.renderList();
    }

    async onClose(): Promise<void> {
        for (const fn of this.unsubscribers) {
            try { fn(); } catch { /* ignore */ }
        }
        this.unsubscribers.length = 0;
        this.contentEl.empty();
    }

    private renderList(): void {
        this.listEl.empty();

        const entries = this.logStore.entries;
        if (entries.length === 0) {
            this.listEl.createDiv({
                cls: "ai-edit-history-empty",
                text: t("editHistory.fileChanges.empty"),
            });
            return;
        }

        type Group = { sessionId: string; entries: VaultEditLogEntry[] };
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
            const sid = group.sessionId;
            const metaLine = this.plugin.sessionManager.getSessionMetadataDisplayLine(sid);
            const tooltipText =
                metaLine !== undefined && metaLine.length > 0 ? metaLine : sid;
            const header = this.listEl.createDiv({
                cls: "ai-edit-history-group-title",
                text: sid,
            });
            setTooltip(header, tooltipText);

            for (const entry of group.entries) {
                this.listEl.appendChild(this.renderFileChangeItem(entry));
            }
        }
    }

    private renderFileChangeItem(entry: VaultEditLogEntry): HTMLElement {
        const el = createDiv({
            cls: `ai-edit-history-item ai-edit-history-item--log ai-edit-history-item--log-${entry.kind}`,
        });
        el.dataset.entryId = entry.id;

        const head = el.createDiv({ cls: "ai-edit-history-item-head" });

        const kindIcon = head.createSpan({ cls: "ai-edit-history-action-icon" });
        setIcon(kindIcon, KIND_ICONS[entry.kind]);
        const kindLabelKey =
            entry.kind === "delete"
                ? "common.delete"
                : `editHistory.fileChanges.kind.${entry.kind}`;
        setTooltip(kindIcon, t(kindLabelKey));

        const canOpen = entry.kind !== "delete";

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

        const meta = el.createDiv({ cls: "ai-edit-history-preview-line" });
        const ts = new Date(entry.createdAt).toLocaleString();
        const parts: string[] = [entry.toolName, ts];
        if (entry.kind === "rename" && entry.previousPath) {
            parts.push(t("editHistory.fileChanges.renamedFrom", { 0: entry.previousPath }));
        }
        meta.setText(parts.join(" · "));

        return el;
    }

    private async openLogEntry(entry: VaultEditLogEntry): Promise<void> {
        const abs = this.app.vault.getAbstractFileByPath(entry.path);
        if (abs instanceof TFile) {
            await this.app.workspace.openLinkText(entry.path, '', false);
            return;
        }
        if (abs instanceof TFolder) {
            new Notice(entry.path);
            return;
        }
        new Notice(t("editHistory.notice.fileMissing"));
    }
}
