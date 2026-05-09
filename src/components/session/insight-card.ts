import { setIcon, setTooltip } from 'obsidian';
import type { ConversationInsight } from '../../services/insights';
import { t } from '../../i18n';

/**
 * Read-only preview block mounted at the tail of the session view, showing
 * candidate "knowledge nuggets" extracted from the most recent
 * user → assistant turn.
 *
 * Visually modelled after `FollowUpBar`: a small section title followed by
 * a vertical list of items — no collapse/expand affordance, no surrounding
 * dashed card.
 *
 * The class name `InsightCard` and CSS namespace `session-insight-card`
 * are kept for backward compatibility, even though it is no longer a
 * visual "card" per se.
 */
export class InsightCard {
    private el: HTMLElement | null = null;
    private spinnerEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    /** Associates the block with a particular assistant message id. */
    private ownerMessageId: string | null = null;
    /**
     * All "Deepen" buttons currently rendered in the card. Tracked so we
     * can disable / enable them in unison while a chat turn is in flight,
     * avoiding accidental concurrent triggers.
     */
    private deepenBtns: HTMLButtonElement[] = [];
    private busy = false;

    constructor(
        private parent: HTMLElement,
        /**
         * Invoked when the user clicks the per-item "Deepen" button. The
         * host (session view) is expected to send a follow-up user message
         * that asks the model to expand on this insight, taking advantage
         * of the existing chat channel (tools, streaming, etc.).
         */
        private onDeepen?: (insight: ConversationInsight) => void,
    ) {}

    /** True when the block is currently mounted. */
    get isVisible(): boolean {
        return this.el !== null;
    }

    /** Message id this block is currently attached to (for ownership checks). */
    get messageId(): string | null {
        return this.ownerMessageId;
    }

    /**
     * Render the block in "loading" state and bind it to the given
     * assistant message id. Clears any previous content.
     */
    showLoading(messageId: string): void {
        this.hide();
        this.ownerMessageId = messageId;

        const block = this.parent.createEl('div', { cls: 'session-insight-card is-loading' });

        this.renderTitle(block);

        const statusWrap = block.createEl('div', { cls: 'session-insight-card__status' });
        const spinner = statusWrap.createEl('span', { cls: 'session-insight-card__spinner' });
        setIcon(spinner, 'loader');
        const status = statusWrap.createEl('span', {
            cls: 'session-insight-card__status-text',
            text: t('view.insightCardLoading'),
        });

        this.el = block;
        this.spinnerEl = spinner;
        this.statusEl = status;
    }

    /**
     * Replace the block's body with the given insights. When `insights` is
     * empty, render a non-blocking "no insights" placeholder in place of
     * the list — the block stays mounted so the user gets explicit
     * feedback that extraction completed (rather than the card silently
     * disappearing). It will be cleared by the next user action that
     * triggers a fresh `showLoading` / `hide` on this card.
     */
    showResults(messageId: string, insights: ConversationInsight[]): void {
        // Stale callback (e.g. user already started a new turn).
        if (!this.el || this.ownerMessageId !== messageId) return;

        const block = this.el;
        block.removeClass('is-loading');
        block.empty();
        this.deepenBtns = [];

        if (insights.length === 0) {
            block.addClass('is-empty');
            this.renderTitle(block);
            block.createEl('div', {
                cls: 'session-insight-card__status-text',
                text: t('view.insightCardEmpty'),
            });
            this.spinnerEl = null;
            this.statusEl = null;
            return;
        }

        block.removeClass('is-empty');
        this.renderTitle(block);

        const list = block.createEl('div', { cls: 'session-insight-card__list' });
        for (const item of insights) {
            this.renderItem(list, item);
        }

        this.spinnerEl = null;
        this.statusEl = null;
    }

    /**
     * Replace the block body with a non-blocking error state. Called when
     * the extraction LLM call fails outright.
     */
    showError(messageId: string, message?: string): void {
        if (!this.el || this.ownerMessageId !== messageId) return;
        const block = this.el;
        block.removeClass('is-loading');
        block.addClass('is-error');
        block.empty();

        this.renderTitle(block, 'alert-triangle');

        block.createEl('div', {
            cls: 'session-insight-card__status-text',
            text: message ?? t('view.insightCardError'),
        });
    }

    /** Remove the block from the DOM if present. */
    hide(): void {
        if (this.el) {
            this.el.remove();
            this.el = null;
        }
        this.spinnerEl = null;
        this.statusEl = null;
        this.ownerMessageId = null;
        this.deepenBtns = [];
    }

    /**
     * Toggle the global "busy" state for this card. While busy, all
     * per-item "Deepen" buttons are visually and functionally disabled
     * to prevent concurrent triggers (the chat session can only run one
     * turn at a time anyway).
     */
    setBusy(busy: boolean): void {
        this.busy = busy;
        for (const btn of this.deepenBtns) {
            btn.disabled = busy;
            btn.toggleClass('is-disabled', busy);
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────

    /**
     * Plain-text section heading: small icon + "Insights" label, mirroring
     * the visual style of `.session-followup-bar__title`.
     */
    private renderTitle(parent: HTMLElement, iconName = 'lightbulb'): void {
        const title = parent.createEl('div', { cls: 'session-insight-card__title' });
        const titleIcon = title.createEl('span', { cls: 'session-insight-card__title-icon' });
        setIcon(titleIcon, iconName);
        title.createEl('span', {
            cls: 'session-insight-card__title-label',
            text: t('view.insightCardTitle'),
        });
    }

    private renderItem(parent: HTMLElement, item: ConversationInsight): void {
        const row = parent.createEl('div', { cls: 'session-insight-card__item' });

        const main = row.createEl('div', { cls: 'session-insight-card__item-main' });
        main.createEl('div', { cls: 'session-insight-card__item-title', text: item.title });
        main.createEl('div', { cls: 'session-insight-card__item-summary', text: item.summary });

        if (item.tags.length > 0 || item.linkedNotes.length > 0) {
            const meta = main.createEl('div', { cls: 'session-insight-card__item-meta' });
            for (const tag of item.tags) {
                meta.createEl('span', {
                    cls: 'session-insight-card__tag',
                    text: '#' + tag,
                });
            }
            for (const note of item.linkedNotes) {
                meta.createEl('span', {
                    cls: 'session-insight-card__link',
                    text: '[[' + note + ']]',
                });
            }
        }

        const actions = row.createEl('div', { cls: 'session-insight-card__item-actions' });

        // ── "Deepen" — kicks off a follow-up turn that expands this insight.
        // Hidden entirely when no host callback is wired (defensive — keeps
        // the card usable in contexts that haven't opted into the deepen
        // flow).
        if (this.onDeepen) {
            const deepenBtn = actions.createEl('button', {
                cls: 'session-insight-card__deepen-btn',
                attr: { type: 'button' },
            });
            const deepenIcon = deepenBtn.createEl('span', {
                cls: 'session-insight-card__deepen-icon',
            });
            setIcon(deepenIcon, 'sparkles');
            setTooltip(deepenBtn, t('view.insightCardDeepen'));
            deepenBtn.setAttr('aria-label', t('view.insightCardDeepen'));

            // Honour any in-flight busy state at the time of render.
            if (this.busy) {
                deepenBtn.disabled = true;
                deepenBtn.addClass('is-disabled');
            }

            deepenBtn.addEventListener('click', () => {
                if (this.busy || deepenBtn.disabled) return;
                this.onDeepen?.(item);
            });

            this.deepenBtns.push(deepenBtn);
        }
    }
}
