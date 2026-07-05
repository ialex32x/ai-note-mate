import { App, setIcon, setTooltip, TFile } from 'obsidian';
import type { ConversationInsight, InsightCardState } from '../../services/insights';
import { t } from '../../i18n';
import { resolveLinkOpenText, resolveLinkTarget } from '../../utils/workspace-utils';

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
         * Obsidian app handle. Used to open wiki-link targets (via
         * `workspace.openLinkText`) and to drive native hover-previews
         * when the user mouses over a linked note chip.
         */
        private app: App,
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

        const block = this.parent.createDiv({ cls: 'session-insight-card is-loading' });

        this.renderTitle(block);

        const statusWrap = block.createDiv({ cls: 'session-insight-card__status' });
        const spinner = statusWrap.createSpan({ cls: 'session-insight-card__spinner' });
        setIcon(spinner, 'loader');
        const status = statusWrap.createSpan({
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
     *
     * Cold-start safe: when the card hasn't been mounted yet (or is
     * bound to a different message id), this method tears down any
     * stale mount and creates a fresh block in one shot. The runtime
     * is the source of truth for "should this state be displayed",
     * not the card's previous DOM presence.
     */
    showResults(messageId: string, insights: ConversationInsight[]): void {
        if (!this.el || this.ownerMessageId !== messageId) {
            this.hide();
            this.ownerMessageId = messageId;
            this.el = this.parent.createDiv({ cls: 'session-insight-card' });
        }

        const block = this.el;
        block.removeClass('is-loading');
        block.empty();
        this.deepenBtns = [];

        if (insights.length === 0) {
            block.addClass('is-empty');
            this.renderTitle(block);
            block.createDiv({
                cls: 'session-insight-card__status-text',
                text: t('view.insightCardEmpty'),
            });
            this.spinnerEl = null;
            this.statusEl = null;
            return;
        }

        block.removeClass('is-empty');
        this.renderTitle(block);

        const list = block.createDiv({ cls: 'session-insight-card__list' });
        for (const item of insights) {
            this.renderItem(list, item);
        }

        this.spinnerEl = null;
        this.statusEl = null;
    }

    /**
     * Replace the block body with a non-blocking error state. Called when
     * the extraction LLM call fails outright. Cold-start safe (see
     * {@link showResults} for the same rationale).
     */
    showError(messageId: string, message?: string): void {
        if (!this.el || this.ownerMessageId !== messageId) {
            this.hide();
            this.ownerMessageId = messageId;
            this.el = this.parent.createDiv({ cls: 'session-insight-card' });
        }
        const block = this.el;
        block.removeClass('is-loading');
        block.addClass('is-error');
        block.empty();

        this.renderTitle(block, 'alert-triangle');

        block.createDiv({
            cls: 'session-insight-card__status-text',
            text: message ?? t('view.insightCardError'),
        });
    }

    /**
     * Render the card from a runtime state object in one call. This is
     * the high-level entry point used by SessionView both for live
     * `insight-update` events and for replay on session-bind.
     *
     * Passing `null` is equivalent to {@link hide}.
     */
    applyState(state: InsightCardState | null): void {
        if (state === null) {
            this.hide();
            return;
        }
        switch (state.phase) {
            case 'loading':
                this.showLoading(state.messageId);
                return;
            case 'results':
                this.showResults(state.messageId, state.insights);
                return;
            case 'empty':
                // showResults renders the "no insights" placeholder when
                // the list is empty, so we route through the same path.
                this.showResults(state.messageId, []);
                return;
            case 'error':
                this.showError(state.messageId);
                return;
        }
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
        const title = parent.createDiv({ cls: 'session-insight-card__title' });
        const titleIcon = title.createSpan({ cls: 'session-insight-card__title-icon' });
        setIcon(titleIcon, iconName);
        title.createSpan({
            cls: 'session-insight-card__title-label',
            text: t('view.insightCardTitle'),
        });
    }

    private renderItem(parent: HTMLElement, item: ConversationInsight): void {
        const row = parent.createDiv({ cls: 'session-insight-card__item' });

        const main = row.createDiv({ cls: 'session-insight-card__item-main' });
        main.createDiv({ cls: 'session-insight-card__item-title', text: item.title });
        main.createDiv({ cls: 'session-insight-card__item-summary', text: item.summary });

        if (item.tags.length > 0 || item.linkedNotes.length > 0) {
            const meta = main.createDiv({ cls: 'session-insight-card__item-meta' });
            for (const tag of item.tags) {
                this.renderTag(meta, tag);
            }
            for (const note of item.linkedNotes) {
                this.renderLinkedNote(meta, note);
            }
        }

        const actions = row.createDiv({ cls: 'session-insight-card__item-actions' });

        // ── "Deepen" — kicks off a follow-up turn that expands this insight.
        // Hidden entirely when no host callback is wired (defensive — keeps
        // the card usable in contexts that haven't opted into the deepen
        // flow).
        if (this.onDeepen) {
            const deepenBtn = actions.createEl('button', {
                cls: 'session-insight-card__deepen-btn',
                attr: { type: 'button' },
            });
            const deepenIcon = deepenBtn.createSpan({
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

    /**
     * Render a single tag as plain clickable hashtag text (no chrome),
     * mirroring how inline `#tag` is rendered in the Obsidian editor.
     * Clicking opens the global search pre-filled with `tag:#<tag>`.
     *
     * Implemented as an `<a class="tag">` so it picks up Obsidian's
     * native tag styling automatically while still giving us keyboard
     * focus and accessible labeling. We suppress default link
     * navigation in the click handler.
     */
    private renderTag(parent: HTMLElement, tag: string): void {
        const bare = tag.replace(/^#+/, '').trim();
        if (!bare) return;

        const link = parent.createEl('a', {
            cls: 'tag session-insight-card__tag',
            text: '#' + bare,
            attr: {
                href: '#' + bare,
                role: 'link',
            },
        });
        const label = t('view.insightCardSearchTag').replace('{tag}', bare);
        setTooltip(link, label);
        link.setAttr('aria-label', label);

        link.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            this.openTagSearch(bare);
        });
    }

    /**
     * Open the global search view pre-populated with `tag:#<tag>`.
     *
     * Uses Obsidian's `global-search` internal plugin, the same backdoor
     * the core app uses when the user clicks a `#tag` in the editor.
     * It is technically untyped / unofficial, but has been stable across
     * desktop and mobile for years and is the established pattern in the
     * plugin ecosystem. If for any reason the plugin is unavailable we
     * silently no-op rather than throwing.
     */
    private openTagSearch(tag: string): void {
        const app = this.app as unknown as {
            internalPlugins?: {
                getPluginById(id: string): {
                    instance?: { openGlobalSearch?: (query: string) => void };
                } | null;
            };
        };
        const search = app.internalPlugins?.getPluginById('global-search');
        search?.instance?.openGlobalSearch?.('tag:#' + tag);
    }

    /**
     * Render a single linked-note chip as a clickable anchor.
     *
     * The extractor emits raw wiki-link *targets* (the text between the
     * `[[...]]`), which may carry an Obsidian-style display alias
     * (`Target|Alias`) and/or a sub-heading (`Target#Heading`). We show
     * the alias (falling back to the bare target) while still routing
     * clicks to the full link text so Obsidian can resolve headings.
     *
     * Behaviour is aligned with chat bubbles' internal-link handling:
     *   - Left-click  → open in the current (or existing) leaf.
     *   - Cmd/Ctrl-click or middle-click → open in a new tab.
     *   - Hover       → trigger Obsidian's native link preview.
     *   - Unresolved targets are rendered with a muted "is-unresolved"
     *     style and still navigate (Obsidian will offer to create).
     */
    private renderLinkedNote(parent: HTMLElement, rawNote: string): void {
        // Strip surrounding `[[ ]]` if the extractor accidentally kept them.
        let target = rawNote.trim();
        if (target.startsWith('[[') && target.endsWith(']]')) {
            target = target.slice(2, -2).trim();
        }
        if (!target) return;

        // Split off display alias (`Target|Alias`).
        let linkText = target;
        let displayText = target;
        const pipeIdx = target.indexOf('|');
        if (pipeIdx >= 0) {
            linkText = target.slice(0, pipeIdx).trim();
            displayText = target.slice(pipeIdx + 1).trim() || linkText;
        }

        const link = parent.createEl('a', {
            cls: 'session-insight-card__link',
            text: displayText,
            attr: {
                href: linkText,
                // Prevent Obsidian from treating us as an external link.
                'data-href': linkText,
                'aria-label': linkText,
            },
        });

        // Mark unresolved targets so styling can distinguish them. We use
        // the link text with any `#heading` suffix stripped for lookup.
        const hashIdx = linkText.indexOf('#');
        const pathOnly = hashIdx >= 0 ? linkText.slice(0, hashIdx) : linkText;
        const resolved = resolveLinkTarget(this.app, pathOnly);
        if (!(resolved instanceof TFile)) {
            link.addClass('is-unresolved');
        }

        link.addEventListener('click', (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            const inNewTab = evt.metaKey || evt.ctrlKey || evt.button === 1;
            void this.app.workspace.openLinkText(
                resolveLinkOpenText(this.app, linkText),
                '',
                inNewTab,
            );
        });

        // Middle-click also opens in a new tab (covered above via `button === 1`
        // on `click`, but some environments only emit `auxclick` for button 1).
        link.addEventListener('auxclick', (evt) => {
            if (evt.button !== 1) return;
            evt.preventDefault();
            evt.stopPropagation();
            void this.app.workspace.openLinkText(
                resolveLinkOpenText(this.app, linkText),
                '',
                true,
            );
        });

        // Native hover-preview, same source tag used by chat bubbles.
        link.addEventListener('mouseover', (evt) => {
            this.app.workspace.trigger('hover-link', {
                event: evt,
                source: 'ai-assistant',
                hoverParent: parent,
                targetEl: link,
                linktext: resolved instanceof TFile ? resolved.path : linkText,
            });
        });
    }
}
