import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * Simple confirm / cancel dialog for checkpoint accept or discard.
 * Resolves `true` when the user confirms, `false` on cancel or dismiss.
 */
export class CheckpointActionConfirmModal extends Modal {
    private resultResolver: ((ok: boolean) => void) | null = null;
    private resolved = false;

    constructor(
        app: App,
        private readonly titleText: string,
        private readonly messageText: string,
        private readonly confirmText: string,
        private readonly variant: 'accept' | 'discard',
    ) {
        super(app);
    }

    waitForResult(): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            this.resultResolver = resolve;
            this.open();
        });
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.setTitle(this.titleText);
        contentEl.createEl('p', { text: this.messageText });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        const cancelBtn = buttonContainer.createEl('button', {});
        cancelBtn.setText(t('save.cancel'));
        cancelBtn.addEventListener('click', () => {
            this.resolve(false);
            this.close();
        });

        const confirmBtn = buttonContainer.createEl('button', {
            cls: this.variant === 'discard' ? 'mod-warning' : 'mod-cta',
        });
        confirmBtn.setText(this.confirmText);
        confirmBtn.addEventListener('click', () => {
            this.resolve(true);
            this.close();
        });
    }

    onClose(): void {
        this.resolve(false);
        this.contentEl.empty();
    }

    private resolve(ok: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resultResolver?.(ok);
        this.resultResolver = null;
    }
}
