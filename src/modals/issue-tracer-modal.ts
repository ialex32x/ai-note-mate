import { App, Modal, setIcon, setTooltip } from 'obsidian';
import {
    clearIssueTracer,
    formatSnapshotAsText,
    getIssueTracerSnapshot,
    subscribeIssueTracer,
    type IssueRecord,
    type IssueTracerSnapshot,
} from '../services/diagnostics/issue-tracer';
import { copyToClipboard } from '../utils/clipboard';

/**
 * Read-only viewer for the in-memory {@link IssueTracerSnapshot}.
 *
 * All strings are intentionally hard-coded English: records are
 * diagnostic payloads forwarded back to the plugin author (typically
 * pasted into a GitHub issue), and stable identifiers across locales
 * keep the signal intact when the author triages.
 *
 * Lifecycle:
 *   - On open: subscribes to the global tracer so newly captured
 *     records appear live without needing to reopen the modal.
 *   - On close: unsubscribes and drops references so the modal is
 *     garbage-collectable even if the user keeps the session open
 *     for hours afterwards.
 */
export class IssueTracerModal extends Modal {
    private unsubscribe: (() => void) | null = null;
    private listEl: HTMLElement | null = null;
    private headerCountEl: HTMLElement | null = null;
    private bannerEl: HTMLElement | null = null;
    private expanded = new Set<string>();

    constructor(app: App) {
        super(app);
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('issue-tracer-modal');

        this.setTitle('Issue tracer');

        const intro = contentEl.createDiv({ cls: 'issue-tracer-modal__intro' });
        intro.setText(
            'In-memory diagnostic clues captured from code paths the plugin knows are unexpected. ' +
            'Nothing is written to disk; restarting Obsidian clears everything.',
        );

        const header = contentEl.createDiv({ cls: 'issue-tracer-modal__header' });
        this.headerCountEl = header.createDiv({ cls: 'issue-tracer-modal__count' });

        const actions = header.createDiv({ cls: 'issue-tracer-modal__actions' });

        const copyBtn = actions.createEl('button', {
            cls: 'issue-tracer-modal__btn',
            attr: { type: 'button', 'aria-label': 'Copy all records' },
        });
        setIcon(copyBtn, 'copy');
        copyBtn.createSpan({ text: 'Copy all' });
        setTooltip(copyBtn, 'Copy all records as text (for pasting into a bug report)');
        copyBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const text = formatSnapshotAsText(getIssueTracerSnapshot());
            void copyToClipboard(text);
        });

        const clearBtn = actions.createEl('button', {
            cls: 'issue-tracer-modal__btn issue-tracer-modal__btn--danger',
            attr: { type: 'button', 'aria-label': 'Clear all records' },
        });
        setIcon(clearBtn, 'trash-2');
        clearBtn.createSpan({ text: 'Clear' });
        setTooltip(clearBtn, 'Discard every recorded issue');
        clearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            clearIssueTracer();
        });

        this.bannerEl = contentEl.createDiv({ cls: 'issue-tracer-modal__banner' });

        this.listEl = contentEl.createDiv({ cls: 'issue-tracer-modal__list' });

        this.unsubscribe = subscribeIssueTracer((snapshot) => this.render(snapshot));
        this.render(getIssueTracerSnapshot());
    }

    onClose(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        const { contentEl } = this;
        contentEl.empty();
        contentEl.removeClass('issue-tracer-modal');
        this.listEl = null;
        this.headerCountEl = null;
        this.bannerEl = null;
        this.expanded.clear();
    }

    private render(snapshot: IssueTracerSnapshot): void {
        if (this.headerCountEl) {
            const total = snapshot.activeCount;
            const label = total === 1 ? '1 record' : `${total} records`;
            const dropped = snapshot.droppedCount > 0
                ? ` (+${snapshot.droppedCount} dropped)`
                : '';
            this.headerCountEl.setText(`${label}${dropped}`);
        }

        if (this.bannerEl) {
            this.bannerEl.empty();
            if (snapshot.droppedCount > 0) {
                this.bannerEl.addClass('issue-tracer-modal__banner--visible');
                this.bannerEl.setText(
                    `Capacity exceeded: ${snapshot.droppedCount} older record(s) were silently dropped. ` +
                    `Only the most recent ${snapshot.activeCount} are kept.`,
                );
            } else {
                this.bannerEl.removeClass('issue-tracer-modal__banner--visible');
            }
        }

        if (!this.listEl) return;
        this.listEl.empty();

        if (snapshot.issues.length === 0) {
            this.listEl.createDiv({
                cls: 'issue-tracer-modal__empty',
                text: 'No issues recorded so far. Anything captured here would be a known plugin bug — silence is good.',
            });
            return;
        }

        // Render newest-first so the most recently captured (most
        // likely to match what the user just observed) is at the top.
        const ordered = snapshot.issues.slice().reverse();
        for (const rec of ordered) {
            this.renderRecord(this.listEl, rec);
        }
    }

    private renderRecord(parent: HTMLElement, rec: IssueRecord): void {
        const item = parent.createDiv({
            cls: `issue-tracer-item issue-tracer-item--${rec.severity}`,
        });

        const head = item.createDiv({ cls: 'issue-tracer-item__head' });

        const iconEl = head.createSpan({ cls: 'issue-tracer-item__icon' });
        setIcon(iconEl, rec.severity === 'error' ? 'circle-alert' : 'triangle-alert');

        const titleWrap = head.createDiv({ cls: 'issue-tracer-item__title-wrap' });
        const titleRow = titleWrap.createDiv({ cls: 'issue-tracer-item__title-row' });
        titleRow.createSpan({
            cls: 'issue-tracer-item__source',
            text: rec.source,
        });
        titleRow.createSpan({
            cls: 'issue-tracer-item__code',
            text: rec.code,
        });
        titleWrap.createDiv({
            cls: 'issue-tracer-item__message',
            text: rec.message,
        });

        const meta = head.createDiv({ cls: 'issue-tracer-item__meta' });
        meta.createSpan({
            cls: 'issue-tracer-item__time',
            text: formatTime(rec.timestamp),
        });

        const hasDetail = !!(rec.context && Object.keys(rec.context).length > 0) || !!rec.stack;
        if (hasDetail) {
            const toggleBtn = head.createEl('button', {
                cls: 'issue-tracer-item__toggle',
                attr: { type: 'button', 'aria-label': 'Toggle details' },
            });
            const isOpen = this.expanded.has(rec.id);
            setIcon(toggleBtn, isOpen ? 'chevron-up' : 'chevron-down');
            toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.expanded.has(rec.id)) {
                    this.expanded.delete(rec.id);
                } else {
                    this.expanded.add(rec.id);
                }
                this.render(getIssueTracerSnapshot());
            });

            if (isOpen) {
                const details = item.createDiv({ cls: 'issue-tracer-item__details' });
                if (rec.context && Object.keys(rec.context).length > 0) {
                    const section = details.createDiv({
                        cls: 'issue-tracer-item__section',
                    });
                    section.createDiv({
                        cls: 'issue-tracer-item__section-label',
                        text: 'Context',
                    });
                    section.createEl('pre', {
                        cls: 'issue-tracer-item__code-block',
                        text: stringifyContext(rec.context),
                    });
                }
                if (rec.stack) {
                    const section = details.createDiv({
                        cls: 'issue-tracer-item__section',
                    });
                    section.createDiv({
                        cls: 'issue-tracer-item__section-label',
                        text: 'Stack',
                    });
                    section.createEl('pre', {
                        cls: 'issue-tracer-item__code-block',
                        text: rec.stack,
                    });
                }
            }
        }
    }
}

function formatTime(ts: number): string {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
}

function stringifyContext(ctx: Record<string, unknown>): string {
    try {
        return JSON.stringify(ctx, replacerWithCycleGuard(), 2);
    } catch (err) {
        return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
    }
}

function replacerWithCycleGuard() {
    const seen = new WeakSet<object>();
    return (_key: string, val: unknown): unknown => {
        if (val && typeof val === 'object') {
            if (seen.has(val)) return '[cyclic]';
            seen.add(val);
        }
        return val;
    };
}
