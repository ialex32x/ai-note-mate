import { App, Modal, TFile, TFolder, Notice, setTooltip, setIcon } from 'obsidian';
import { t } from '../i18n';

export interface SaveFileResult {
    folder: TFolder;
    filename: string;
}

export class SaveFileModal extends Modal {
    private defaultFilename: string;
    private selectedFolder: TFolder;
    private filenameInput!: HTMLInputElement;
    private saveBtn!: HTMLButtonElement;
    private overwriteIcon!: HTMLElement;
    private treeContainer!: HTMLElement;
    private fileListContainer!: HTMLElement;
    private pathDisplay!: HTMLElement;
    private expandedFolders: Set<string> = new Set();
    private resultResolver: ((result: SaveFileResult | null) => void) | null = null;

    constructor(
        app: App,
        defaultFilename: string,
        suggestedFolder?: TFolder,
    ) {
        super(app);
        this.defaultFilename = defaultFilename;
        this.selectedFolder = suggestedFolder ?? app.vault.getRoot();
    }

    /** Opens the modal and returns the user's choice, or null if cancelled. */
    waitForResult(): Promise<SaveFileResult | null> {
        return new Promise(resolve => {
            this.resultResolver = resolve;
            this.open();
        });
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('save-file-modal');

        this.setTitle(t('view.exportSession'));

        // Expand ancestor folders of the suggested folder
        this.expandToFolder(this.selectedFolder);

        // ── Main area: folder tree + file list ─────────────────────────────
        const mainArea = contentEl.createDiv({ cls: 'save-file-modal__main' });

        const treePanel = mainArea.createDiv({ cls: 'save-file-modal__tree-panel' });
        const treeHeader = treePanel.createDiv({ cls: 'save-file-modal__panel-header save-file-modal__panel-header--tree' });
        treeHeader.createSpan({ cls: 'save-file-modal__panel-header-text', text: t('save.directories') });
        const newFolderBtn = treeHeader.createEl('button', {
            cls: 'save-file-modal__new-folder-btn',
            text: '+',
        });
        setTooltip(newFolderBtn, t('save.newFolder'));
        newFolderBtn.addEventListener('click', () => this.showNewFolderPrompt());
        this.treeContainer = treePanel.createDiv({ cls: 'save-file-modal__tree' });

        const divider = mainArea.createDiv({ cls: 'save-file-modal__divider' });

        const filePanel = mainArea.createDiv({ cls: 'save-file-modal__file-panel' });
        filePanel.createDiv({ cls: 'save-file-modal__panel-header', text: t('save.files') });
        this.fileListContainer = filePanel.createDiv({ cls: 'save-file-modal__file-list' });

        // ── Resizable divider ─────────────────────────────────────────────
        // Uses Pointer Events + setPointerCapture so that move/up events are
        // guaranteed to be delivered to the divider element — no document-wide
        // listeners, no mutation of document.body style.
        let activePointerId: number | null = null;
        const endDrag = () => {
            if (activePointerId === null) return;
            if (divider.hasPointerCapture(activePointerId)) {
                divider.releasePointerCapture(activePointerId);
            }
            activePointerId = null;
            mainArea.removeClass('save-file-modal__main--resizing');
            divider.removeClass('save-file-modal__divider--active');
        };
        divider.addEventListener('pointerdown', (e) => {
            // Only react to primary button / primary touch-pen contact.
            if (e.button !== 0) return;
            e.preventDefault();
            activePointerId = e.pointerId;
            divider.setPointerCapture(e.pointerId);
            mainArea.addClass('save-file-modal__main--resizing');
            divider.addClass('save-file-modal__divider--active');
        });
        divider.addEventListener('pointermove', (e) => {
            if (activePointerId === null || e.pointerId !== activePointerId) return;
            const rect = mainArea.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const min = 120;
            const max = rect.width - 120;
            const clamped = Math.max(min, Math.min(max, x));
            treePanel.style.width = `${clamped}px`;
        });
        divider.addEventListener('pointerup', endDrag);
        divider.addEventListener('pointercancel', endDrag);
        // Safety net: if capture is lost for any reason (e.g. focus change),
        // clear our state so we don't leave the modal in a stuck state.
        divider.addEventListener('lostpointercapture', endDrag);

        // ── Bottom bar ─────────────────────────────────────────────────────
        const bottomBar = contentEl.createDiv({ cls: 'save-file-modal__bottom' });

        // Location path
        const pathRow = bottomBar.createDiv({ cls: 'save-file-modal__path-row' });
        pathRow.createEl('span', { cls: 'save-file-modal__path-label', text: t('save.location') + ':' });
        this.pathDisplay = pathRow.createEl('span', { cls: 'save-file-modal__path-value' });

        // Filename row
        const filenameRow = bottomBar.createDiv({ cls: 'save-file-modal__filename-row' });
        filenameRow.createEl('label', { cls: 'save-file-modal__filename-label', text: t('save.fileName') + ':' });
        this.filenameInput = filenameRow.createEl('input', {
            cls: 'save-file-modal__filename-input',
            attr: { type: 'text', value: this.defaultFilename },
        });
        this.overwriteIcon = filenameRow.createSpan({ cls: 'save-file-modal__overwrite-icon' });
        setIcon(this.overwriteIcon, 'alert-triangle');
        this.overwriteIcon.hide();
        setTooltip(this.overwriteIcon, t('save.overwriteWarning'), { placement: 'top' });

        // Buttons
        const btnRow = bottomBar.createDiv({ cls: 'save-file-modal__btn-row' });
        this.saveBtn = btnRow.createEl('button', {
            cls: 'save-file-modal__btn save-file-modal__btn--save',
            text: t('save.save'),
        });
        this.saveBtn.addEventListener('click', () => this.handleSave());

        // Event handlers
        this.filenameInput.addEventListener('input', () => this.checkOverwrite());

        // Initial render
        this.renderTree();
        this.renderFileList();
        this.updatePathDisplay();
        this.checkOverwrite();
    }

    onClose() {
        if (this.resultResolver) {
            this.resultResolver(null);
            this.resultResolver = null;
        }
        const { contentEl } = this;
        contentEl.empty();
        contentEl.removeClass('save-file-modal');
    }

    // ── Folder tree ────────────────────────────────────────────────────────

    private expandToFolder(folder: TFolder) {
        const parts = folder.path.split('/').filter(Boolean);
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            this.expandedFolders.add(current);
        }
    }

    private renderTree() {
        this.treeContainer.empty();
        this.renderFolderNode(this.app.vault.getRoot(), 0);
    }

    private renderFolderNode(folder: TFolder, depth: number) {
        const isRoot = folder.path === '/';
        const isExpanded = this.expandedFolders.has(folder.path) || isRoot;
        const isSelected = this.selectedFolder.path === folder.path;

        const node = this.treeContainer.createDiv({
            cls: `save-file-modal__tree-node${isSelected ? ' save-file-modal__tree-node--selected' : ''}`,
            attr: { 'aria-label': folder.path },
        });
        node.style.paddingLeft = `${depth * 16 + 4}px`;

        // Expand/collapse arrow (hide for root, invisible for leaf folders)
        if (!isRoot) {
            const hasSubFolders = folder.children.some((c): c is TFolder => c instanceof TFolder);
            const arrow = node.createEl('span', { cls: 'save-file-modal__tree-arrow' });
            arrow.setText(isExpanded ? '▾' : '▸');
            if (!hasSubFolders) arrow.classList.add('is-invisible');
        }

        // Folder icon
        const icon = node.createEl('span', { cls: 'save-file-modal__tree-icon' });
        setIcon(icon, isExpanded ? 'folder-open' : 'folder-closed');

        // Name
        node.createEl('span', { cls: 'save-file-modal__tree-name' })
            .setText(isRoot ? t('save.vaultRoot') : folder.name);

        // Click: toggle expand + select
        node.addEventListener('click', () => {
            if (!isRoot) {
                if (isExpanded) {
                    this.expandedFolders.delete(folder.path);
                } else {
                    this.expandedFolders.add(folder.path);
                }
            }
            this.selectedFolder = folder;
            this.renderTree();
            this.renderFileList();
            this.updatePathDisplay();
            this.checkOverwrite();
        });

        // Render children if expanded (lazy: only immediate sub-folders)
        if (isExpanded) {
            const subFolders = folder.children
                .filter((c): c is TFolder => c instanceof TFolder)
                .sort((a, b) => a.name.localeCompare(b.name));
            for (const sub of subFolders) {
                this.renderFolderNode(sub, depth + 1);
            }
        }
    }

    // ── File list ──────────────────────────────────────────────────────────

    private renderFileList() {
        this.fileListContainer.empty();

        const files = this.selectedFolder.children
            .filter((c): c is TFile => c instanceof TFile)
            .sort((a, b) => a.name.localeCompare(b.name));

        if (files.length === 0) {
            this.fileListContainer.createDiv({ cls: 'save-file-modal__empty' })
                .setText(t('save.noFiles'));
            return;
        }

        for (const file of files) {
            const item = this.fileListContainer.createDiv({ cls: 'save-file-modal__file-item' });
            item.setAttribute('aria-label', file.path);
            const fileIcon = item.createEl('span', { cls: 'save-file-modal__file-icon' });
            setIcon(fileIcon, 'file-text');
            item.createEl('span', { cls: 'save-file-modal__file-name', text: file.name });

            item.addEventListener('click', () => {
                this.filenameInput.value = file.name;
                this.checkOverwrite();
                // Highlight
                this.fileListContainer.querySelectorAll('.save-file-modal__file-item--selected')
                    .forEach(el => el.removeClass('save-file-modal__file-item--selected'));
                item.addClass('save-file-modal__file-item--selected');
            });
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private updatePathDisplay() {
        this.pathDisplay.setText(this.selectedFolder.path === '/' ? '/' : this.selectedFolder.path);
    }

    private checkOverwrite() {
        const filename = this.filenameInput.value.trim();
        if (!filename) {
            this.overwriteIcon.hide();
            this.saveBtn.setText(t('save.save'));
            this.saveBtn.removeClass('save-file-modal__btn--overwrite');
            return;
        }

        const fullPath = this.selectedFolder.path === '/'
            ? filename
            : `${this.selectedFolder.path}/${filename}`;
        const existing = this.app.vault.getAbstractFileByPath(fullPath);
        if (existing instanceof TFile) {
            this.overwriteIcon.show();
            this.saveBtn.setText(t('save.overwrite'));
            this.saveBtn.addClass('save-file-modal__btn--overwrite');
        } else {
            this.overwriteIcon.hide();
            this.saveBtn.setText(t('save.save'));
            this.saveBtn.removeClass('save-file-modal__btn--overwrite');
        }
    }

    // ── New folder ─────────────────────────────────────────────────────────

    private showNewFolderPrompt() {
        const prompt = new NewFolderPromptModal(this.app, this.selectedFolder.path);
        void prompt.waitForResult().then(async (name) => {
            if (!name) return;
            const fullPath = this.selectedFolder.path === '/'
                ? name
                : `${this.selectedFolder.path}/${name}`;
            try {
                await this.app.vault.createFolder(fullPath);
                this.expandedFolders.add(this.selectedFolder.path);
                this.renderTree();
            } catch {
                new Notice(t('save.folderExists'));
            }
        });
    }

    // ── Save ───────────────────────────────────────────────────────────────

    private handleSave() {
        const filename = this.filenameInput.value.trim();
        if (!filename) {
            new Notice(t('save.noFilename'));
            return;
        }

        const result: SaveFileResult = { folder: this.selectedFolder, filename };
        if (this.resultResolver) {
            this.resultResolver(result);
            this.resultResolver = null;
        }
        this.close();
    }
}

// ── New Folder Prompt Modal ──────────────────────────────────────────────

class NewFolderPromptModal extends Modal {
    private input!: HTMLInputElement;
    private resolver: ((name: string | null) => void) | null = null;

    constructor(app: App, private parentPath: string) {
        super(app);
    }

    waitForResult(): Promise<string | null> {
        return new Promise(resolve => {
            this.resolver = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        this.setTitle(t('save.newFolder'));

        const form = contentEl.createDiv({ cls: 'new-folder-prompt' });

        const pathHint = form.createDiv({ cls: 'new-folder-prompt__path' });
        pathHint.setText(this.parentPath);

        this.input = form.createEl('input', {
            cls: 'new-folder-prompt__input',
            type: 'text',
            placeholder: t('save.newFolderPlaceholder'),
        });

        const btnRow = form.createDiv({ cls: 'new-folder-prompt__btn-row' });

        const cancelBtn = btnRow.createEl('button', {
            cls: 'new-folder-prompt__btn new-folder-prompt__btn--cancel',
            text: t('save.cancel'),
        });
        cancelBtn.addEventListener('click', () => this.close());

        const confirmBtn = btnRow.createEl('button', {
            cls: 'new-folder-prompt__btn new-folder-prompt__btn--confirm',
            text: t('save.save'),
        });
        confirmBtn.addEventListener('click', () => this.confirm());

        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.confirm();
            if (e.key === 'Escape') this.close();
        });

        // Auto-focus input
        window.setTimeout(() => this.input.focus(), 50);
    }

    onClose() {
        if (this.resolver) {
            this.resolver(null);
            this.resolver = null;
        }
    }

    private confirm() {
        const name = this.input.value.trim();
        if (this.resolver) {
            this.resolver(name || null);
            this.resolver = null;
        }
        this.close();
    }
}
