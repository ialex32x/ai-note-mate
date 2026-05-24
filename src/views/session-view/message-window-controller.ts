import { setIcon } from 'obsidian';
import { t } from '../../i18n';
import type { DisplayUnit } from './display-units';
import { findDisplayUnitIndex } from './display-units';
import { HISTORY_LOADING } from './history-loading-config';

export interface MessageWindowInitResult {
    initialStart: number;
    initialEnd: number;
    useWindowing: boolean;
}

/**
 * Tracks which slice of {@link DisplayUnit} history is currently rendered
 * in the DOM and owns the top-of-list sentinel for loading older bubbles.
 */
export class MessageWindowController {
    private allUnits: DisplayUnit[] = [];
    private renderedStart = 0;
    private renderedEnd = 0;
    private useWindowing = false;
    private sentinelEl: HTMLElement | null = null;
    private isLoadingOlder = false;
    private onLoadOlder: (() => void) | null = null;

    constructor(private readonly messagesEl: HTMLElement) {}

    reset(): void {
        this.allUnits = [];
        this.renderedStart = 0;
        this.renderedEnd = 0;
        this.useWindowing = false;
        this.isLoadingOlder = false;
        this.onLoadOlder = null;
        this.removeSentinel();
    }

    /**
     * Prepare window state for a replay pass. Returns the slice
     * `[initialStart, initialEnd)` that should be rendered first.
     */
    init(allUnits: DisplayUnit[]): MessageWindowInitResult {
        this.allUnits = allUnits;
        this.useWindowing = allUnits.length >= HISTORY_LOADING.minUnitsForWindowing;
        this.renderedStart = this.useWindowing
            ? Math.max(0, allUnits.length - HISTORY_LOADING.initialTailUnits)
            : 0;
        this.renderedEnd = allUnits.length;
        return {
            initialStart: this.renderedStart,
            initialEnd: this.renderedEnd,
            useWindowing: this.useWindowing,
        };
    }

    get units(): ReadonlyArray<DisplayUnit> {
        return this.allUnits;
    }

    get start(): number {
        return this.renderedStart;
    }

    get end(): number {
        return this.renderedEnd;
    }

    get loadingOlder(): boolean {
        return this.isLoadingOlder;
    }

    hasOlderUnrendered(): boolean {
        return this.renderedStart > 0;
    }

    olderUnrenderedCount(): number {
        return this.renderedStart;
    }

    findUnitIndex(messageId: string): number {
        return findDisplayUnitIndex(this.allUnits, messageId);
    }

    slice(from: number, to: number): DisplayUnit[] {
        return this.allUnits.slice(from, to);
    }

    /** DOM node to insert prepended bubbles before (first rendered bubble). */
    getPrependAnchor(): HTMLElement | null {
        const sentinel = this.sentinelEl;
        if (sentinel?.nextElementSibling instanceof HTMLElement) {
            return sentinel.nextElementSibling;
        }
        const firstBubble = this.messagesEl.querySelector('.session-bubble');
        return firstBubble instanceof HTMLElement ? firstBubble : null;
    }

    registerAppendedUnit(unit: DisplayUnit): void {
        this.allUnits.push(unit);
        this.renderedEnd = this.allUnits.length;
    }

    setLoadingOlder(loading: boolean): void {
        this.isLoadingOlder = loading;
        this.updateSentinel();
    }

    applyOlderBatch(newStart: number): void {
        this.renderedStart = newStart;
        this.updateSentinel();
    }

    expandRenderedStart(newStart: number): void {
        this.renderedStart = Math.min(this.renderedStart, newStart);
        this.updateSentinel();
    }

    mountSentinel(onLoadOlder: () => void): void {
        this.onLoadOlder = onLoadOlder;
        if (!this.hasOlderUnrendered()) {
            this.removeSentinel();
            return;
        }

        if (!this.sentinelEl) {
            this.sentinelEl = this.messagesEl.createEl('div', {
                cls: 'session-history-sentinel',
            });
            this.messagesEl.insertBefore(this.sentinelEl, this.messagesEl.firstChild);
            const btn = this.sentinelEl.createEl('button', {
                cls: 'session-history-sentinel__btn',
                attr: { type: 'button' },
            });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                this.onLoadOlder?.();
            });
        }
        this.updateSentinel();
    }

    updateSentinel(): void {
        const el = this.sentinelEl;
        if (!el) return;

        if (!this.hasOlderUnrendered()) {
            this.removeSentinel();
            return;
        }

        el.removeClass('session-history-sentinel--loading');
        const btn = el.querySelector('.session-history-sentinel__btn');
        if (!(btn instanceof HTMLButtonElement)) return;

        if (this.isLoadingOlder) {
            el.addClass('session-history-sentinel--loading');
            btn.empty();
            const spinner = btn.createSpan({ cls: 'session-history-sentinel__spinner' });
            setIcon(spinner, 'loader');
            btn.createSpan({ text: t('view.loadingOlderMessages') });
            btn.disabled = true;
            return;
        }

        btn.disabled = false;
        btn.empty();
        btn.setText(t('view.loadOlderMessages', { count: this.olderUnrenderedCount() }));
    }

    removeSentinel(): void {
        this.sentinelEl?.remove();
        this.sentinelEl = null;
    }

    shouldAutoLoadOlder(scrollTop: number): boolean {
        return this.hasOlderUnrendered()
            && !this.isLoadingOlder
            && scrollTop < HISTORY_LOADING.autoLoadThresholdPx;
    }
}
