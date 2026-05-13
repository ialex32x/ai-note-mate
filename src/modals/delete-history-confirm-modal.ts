import { App, Modal } from 'obsidian';
import { t } from '../i18n';

/**
 * Result of the delete-history confirmation modal.
 *
 * - `confirmed === false` means the user cancelled (or closed the modal)
 *   and no deletion should happen.
 * - When confirmed, `includeBusy` indicates whether sessions whose
 *   runtime is currently mid-turn (`busy`) should also be deleted.
 *   The caller is responsible for forcibly aborting those runtimes
 *   before/while removing them.
 *
 * The currently active session is *never* part of this operation —
 * that constraint is enforced upstream by SessionNavigator and
 * SessionManager.deleteAllHistorySessions.
 */
export interface DeleteHistoryConfirmResult {
    confirmed: boolean;
    includeBusy: boolean;
}

/**
 * Confirmation modal shown before deleting history sessions
 * (all sessions except the currently active one).
 *
 * Behaviour:
 *   - Shows the total count of deletable history sessions and, when
 *     any of them are mid-turn, a separate "X are currently running"
 *     hint plus an opt-in checkbox to also delete those running ones.
 *   - When the checkbox is unticked (the default) running sessions
 *     are skipped; the Delete button label updates to reflect the
 *     count that will actually be removed and is disabled if the
 *     resulting count is zero.
 *
 * Usage:
 *   const { confirmed, includeBusy } = await new DeleteHistoryConfirmModal(
 *       app, totalCount, busyCount,
 *   ).waitForResult();
 */
export class DeleteHistoryConfirmModal extends Modal {
    private resultResolver: ((result: DeleteHistoryConfirmResult) => void) | null = null;
    private resolved = false;

    private includeBusy = false;
    private confirmBtn: HTMLButtonElement | null = null;
    private includeBusyCheckbox: HTMLInputElement | null = null;

    constructor(
        app: App,
        private readonly totalCount: number,
        private readonly busyCount: number,
    ) {
        super(app);
    }

    /** Opens the modal and resolves with the user's choice. */
    waitForResult(): Promise<DeleteHistoryConfirmResult> {
        return new Promise<DeleteHistoryConfirmResult>((resolve) => {
            this.resultResolver = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('delete-history-modal');

        this.setTitle(t('view.deleteHistorySessionsConfirmTitle'));

        // ── Message body ──────────────────────────────────────────────
        const body = contentEl.createDiv({ cls: 'delete-history-modal__body' });
        body.createEl('p', {
            cls: 'delete-history-modal__message',
            text: t('view.deleteHistorySessionsConfirmMessage', { count: this.totalCount }),
        });

        if (this.busyCount > 0) {
            body.createEl('p', {
                cls: 'delete-history-modal__busy-hint',
                text: t('view.deleteHistorySessionsConfirmBusyHint', { count: this.busyCount }),
            });

            // ── Include-busy checkbox ────────────────────────────────
            const checkboxLabel = body.createEl('label', {
                cls: 'delete-history-modal__checkbox-label',
            });
            const checkbox = checkboxLabel.createEl('input', {
                cls: 'delete-history-modal__checkbox',
                attr: { type: 'checkbox' },
            });
            checkbox.checked = this.includeBusy;
            this.includeBusyCheckbox = checkbox;
            checkboxLabel.createEl('span', {
                cls: 'delete-history-modal__checkbox-text',
                text: t('view.deleteHistorySessionsConfirmIncludeBusy'),
            });
            checkbox.addEventListener('change', () => {
                this.includeBusy = checkbox.checked;
                this.updateConfirmBtn();
            });
        }

        // ── Buttons ──────────────────────────────────────────────────
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

        const cancelBtn = buttonContainer.createEl('button', { cls: 'delete-history-modal__btn' });
        cancelBtn.setText(t('view.deleteHistorySessionsConfirmCancel'));
        cancelBtn.addEventListener('click', () => {
            this.resolve({ confirmed: false, includeBusy: false });
            this.close();
        });

        const confirmBtn = buttonContainer.createEl('button', {
            cls: 'mod-warning delete-history-modal__btn delete-history-modal__btn--confirm',
        });
        this.confirmBtn = confirmBtn;
        confirmBtn.addEventListener('click', () => {
            if (confirmBtn.disabled) return;
            this.resolve({ confirmed: true, includeBusy: this.includeBusy });
            this.close();
        });

        this.updateConfirmBtn();
    }

    onClose() {
        // If the user dismissed via Esc / outside-click, treat as cancel.
        this.resolve({ confirmed: false, includeBusy: false });
        const { contentEl } = this;
        contentEl.empty();
        contentEl.removeClass('delete-history-modal');
    }

    /**
     * Recomputes the Delete button label and disabled state from the
     * current `includeBusy` selection. When the resulting count is
     * zero (i.e. all sessions are busy and the user has not opted
     * into deleting them) the button is disabled to make it obvious
     * the operation would be a no-op.
     */
    private updateConfirmBtn(): void {
        if (!this.confirmBtn) return;
        const effectiveCount = this.includeBusy
            ? this.totalCount
            : this.totalCount - this.busyCount;
        this.confirmBtn.setText(
            t('view.deleteHistorySessionsConfirmDelete', { count: effectiveCount }),
        );
        this.confirmBtn.disabled = effectiveCount <= 0;
        this.confirmBtn.toggleClass('is-disabled', effectiveCount <= 0);
    }

    private resolve(value: DeleteHistoryConfirmResult) {
        if (this.resolved) return;
        this.resolved = true;
        this.resultResolver?.(value);
        this.resultResolver = null;
    }
}
