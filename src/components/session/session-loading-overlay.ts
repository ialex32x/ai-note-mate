import { setIcon } from 'obsidian';
import { t } from '../../i18n';

/**
 * Full-area overlay shown while a large history slice is being replayed
 * into the message list. Covers {@link SessionView}'s messages wrapper so
 * the user sees progress instead of a frozen UI.
 */
export class SessionLoadingOverlay {
    private el: HTMLElement | null = null;
    private progressBarEl: HTMLElement | null = null;
    private progressTextEl: HTMLElement | null = null;
    private total = 0;

    constructor(private readonly wrapperEl: HTMLElement) {}

    mount(): void {
        this.el = this.wrapperEl.createDiv({
            cls: 'session-history-loading session-history-loading--hidden',
            attr: { 'aria-hidden': 'true', 'aria-live': 'polite' },
        });

        const panel = this.el.createDiv({ cls: 'session-history-loading__panel' });
        const spinner = panel.createSpan({ cls: 'session-history-loading__spinner' });
        setIcon(spinner, 'loader');

        panel.createDiv({
            cls: 'session-history-loading__title',
            text: t('view.historyLoading'),
        });

        const track = panel.createDiv({ cls: 'session-history-loading__track' });
        this.progressBarEl = track.createDiv({ cls: 'session-history-loading__bar' });
        this.progressTextEl = panel.createDiv({ cls: 'session-history-loading__text' });
    }

    dispose(): void {
        this.el?.remove();
        this.el = null;
        this.progressBarEl = null;
        this.progressTextEl = null;
    }

    show(total: number): void {
        if (!this.el) return;
        this.total = Math.max(1, total);
        this.setProgress(0, this.total);
        this.el.removeClass('session-history-loading--hidden');
        this.el.removeClass('session-history-loading--indeterminate');
        this.el.setAttribute('aria-hidden', 'false');
    }

    /**
     * Show a simple spinner overlay without progress bar — suitable for
     * initial data loading where the total item count is unknown.
     */
    showSimple(): void {
        if (!this.el) return;
        this.el.removeClass('session-history-loading--hidden');
        this.el.addClass('session-history-loading--indeterminate');
        this.el.setAttribute('aria-hidden', 'false');
    }

    hide(): void {
        if (!this.el) return;
        this.el.addClass('session-history-loading--hidden');
        this.el.removeClass('session-history-loading--indeterminate');
        this.el.setAttribute('aria-hidden', 'true');
    }

    setProgress(done: number, total: number): void {
        this.total = Math.max(1, total);
        const pct = Math.min(100, Math.round((done / this.total) * 100));
        if (this.progressBarEl) {
            this.progressBarEl.style.width = `${pct}%`;
        }
        if (this.progressTextEl) {
            this.progressTextEl.setText(t('view.historyLoadingProgress', { done, total }));
        }
    }
}
