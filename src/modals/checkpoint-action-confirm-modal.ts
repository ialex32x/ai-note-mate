import { App } from 'obsidian';
import { t } from '../i18n';
import { PromiseModal } from './_promise-modal';

/**
 * Simple confirm / cancel dialog for checkpoint accept or discard.
 * Resolves `true` when the user confirms, `false` on cancel or dismiss.
 */
export class CheckpointActionConfirmModal extends PromiseModal<boolean> {
    constructor(
        app: App,
        private readonly titleText: string,
        private readonly messageText: string,
        private readonly confirmText: string,
        private readonly variant: 'accept' | 'discard',
    ) {
        super(app);
    }

    protected cancelValue(): boolean {
        return false;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.setTitle(this.titleText);
        contentEl.createEl('p', { text: this.messageText });

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        const cancelBtn = buttonContainer.createEl('button', {});
        cancelBtn.setText(t('common.cancel'));
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
        super.onClose();
        this.contentEl.empty();
    }
}
