import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * Confirmation modal shown before deleting all history sessions
 * (all sessions except the currently active one).
 *
 * Usage:
 *   const confirmed = await new DeleteHistoryConfirmModal(app, count).waitForResult();
 */
export class DeleteHistoryConfirmModal extends Modal {
    private resultResolver: ((confirmed: boolean) => void) | null = null;
    private resolved = false;

    constructor(
        app: App,
        private sessionCount: number,
    ) {
        super(app);
    }

    /** Opens the modal and resolves with the user's choice. */
    waitForResult(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.resultResolver = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        this.setTitle(t('view.deleteHistorySessionsConfirmTitle'));

        const messageEl = contentEl.createDiv({ cls: 'modal-content' });
        messageEl.setText(t('view.deleteHistorySessionsConfirmMessage', { count: this.sessionCount }));

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        const confirmBtn = buttonContainer.createEl('button', { cls: 'mod-cta' });
        confirmBtn.setText('Delete');
        confirmBtn.addEventListener('click', () => {
            this.resolve(true);
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { cls: 'mod-warning' });
        cancelBtn.setText('Cancel');
        cancelBtn.addEventListener('click', () => {
            this.resolve(false);
            this.close();
        });
    }

    private resolve(value: boolean) {
        if (this.resolved) return;
        this.resolved = true;
        this.resultResolver?.(value);
        this.resultResolver = null;
    }
}
