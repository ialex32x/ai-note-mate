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
    private onUnitsTrimmed: ((removedMessageIds: string[]) => void) | null = null;

    constructor(private readonly messagesEl: HTMLElement) {}

    /**
     * Register a callback invoked with the message IDs of the display units
     * removed from the DOM by {@link trimTail}. The bubble-list controller
     * uses this to drop the corresponding entries from its `messageBubbles`
     * map so jump navigation never resolves a detached (trimmed) node.
     */
    setOnUnitsTrimmed(cb: (removedMessageIds: string[]) => void): void {
        this.onUnitsTrimmed = cb;
    }

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

    /** Number of display units currently rendered in the DOM. */
    get renderedCount(): number {
        return this.renderedEnd - this.renderedStart;
    }

    /**
     * Remove the oldest `count` rendered display units from `messagesEl`
     * and advance `renderedStart` accordingly. Does NOT modify `allUnits`
     * so trimmed history can be re-rendered later via "load older".
     * Returns the number of units actually removed.
     *
     * A single display unit can span **more than one** sibling DOM node:
     * user messages and sub-agent replies have their action bar moved
     * outside the bubble border (see {@link BubbleRenderer.externalizeActionBar}),
     * so they render as `[.session-bubble][.session-bubble__actions--external]`.
     * Trimming must therefore count whole units (one `.session-bubble`
     * starts a unit) and drop each unit's trailing external action bar with
     * it — otherwise an orphaned toolbar is left behind as a standalone flex
     * child, producing an empty gap with a lone hover toolbar, and
     * `renderedStart` would over-advance (one node ≠ one unit) and desync
     * the logical window from the DOM.
     */
    trimTail(count: number): number {
        if (count <= 0) return 0;

        const toRemove = Math.min(count, this.renderedCount);
        if (toRemove <= 0) return 0;

        const oldStart = this.renderedStart;
        const anchor = this.getPrependAnchor();
        let el: ChildNode | null = anchor;
        let unitsRemoved = 0;

        while (el && unitsRemoved < toRemove) {
            const isBubble = el.instanceOf(HTMLElement)
                && el.classList.contains('session-bubble');
            const next = el.nextSibling;
            el.remove();
            if (isBubble) {
                unitsRemoved++;
            }
            el = next;

            // Drop any trailing nodes that belong to the unit just removed
            // (e.g. an externalised action bar) before counting the next
            // unit boundary.
            while (
                el?.instanceOf(HTMLElement)
                && el.classList.contains('session-bubble__actions--external')
            ) {
                const after = el.nextSibling;
                el.remove();
                el = after;
            }
        }

        this.renderedStart += unitsRemoved;

        // Notify the bubble-list controller which message IDs left the DOM so
        // it can drop their (now detached) entries from `messageBubbles`.
        // The removed units are the oldest rendered slice; one DisplayUnit
        // maps to exactly one `.session-bubble`, so the slice aligns with the
        // nodes removed above.
        if (unitsRemoved > 0 && this.onUnitsTrimmed) {
            const removed = this.allUnits.slice(oldStart, oldStart + unitsRemoved);
            this.onUnitsTrimmed(removed.map(u => u.msg.id));
        }

        this.updateSentinel();
        return unitsRemoved;
    }

    /**
     * If the number of rendered units exceeds {@link HISTORY_LOADING.maxRenderedUnits},
     * trim the oldest bubbles to stay within the limit.
     */
    maybeTrimTail(): number {
        const excess = this.renderedCount - HISTORY_LOADING.maxRenderedUnits;
        if (excess <= 0) return 0;
        return this.trimTail(excess);
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
        // NOTE: maybeTrimTail() is NOT called here intentionally.
        // Trimming during active streaming while the user is browsing
        // history (autoFollow=false) could remove the oldest rendered
        // bubbles that the user is currently reading.  Instead, the
        // view layer calls maybeTrimTail() at safe boundary points:
        // after loadOlderMessages, ensureMessageVisible, and on turn
        // finish/abort/error — where scroll anchoring or autoFollow
        // guarantee a correct viewport state.
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
            this.sentinelEl = this.messagesEl.createDiv({
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
