import { setIcon } from 'obsidian';
import type { ChatMessage, QuickAskTurn } from '../../services/chat-stream';
import { t } from '../../i18n';
import { BUBBLE_BASE_CLS, computeBubbleClasses } from '../bubble/chat-bubble';

const PANEL_HIDDEN_CLS = 'session-quick-ask-panel--hidden';

/**
 * One-shot floating panel for QuickAsk (追问) side-conversations.
 *
 * Mounted on `activeDocument.body` with `position: fixed` so it never
 * interferes with the session view's scroll layout. Positioned relative
 * to the target assistant bubble via viewport coordinates.
 */

type PanelState = 'hidden' | 'input' | 'loading' | 'result';

export class QuickAskPanel {
    private el: HTMLElement | null = null;
    private bodyEl: HTMLElement | null = null;
    private textareaEl: HTMLTextAreaElement | null = null;
    private outsideClickHandler: ((ev: MouseEvent) => void) | null = null;

    private _state: PanelState = 'hidden';
    private _activeMessageId: string | null = null;

    get state(): PanelState { return this._state; }
    get activeMessageId(): string | null { return this._activeMessageId; }
    get isVisible(): boolean { return this.el !== null && this._state !== 'hidden'; }

    constructor(
        private getMessageBubbleEl: (messageId: string) => HTMLElement | undefined,
        private getQuickAskTurns: () => ReadonlyArray<QuickAskTurn>,
        private onSubmit: (parentMessageId: string, input: string) => Promise<void>,
        private onDelete: (parentMessageId: string) => void,
    ) {}

    show(messageId: string): void {
        this._activeMessageId = messageId;
        const existing = this.getQuickAskTurns().find(t => t.parentMessageId === messageId);
        if (existing) {
            this._state = existing.loading ? 'loading' : 'result';
        } else {
            this._state = 'input';
        }
        this.render();
        this.attachOutsideClick();
    }

    hide(): void {
        this._state = 'hidden';
        this._activeMessageId = null;
        this.detachOutsideClick();
        if (this.el) {
            this.el.addClass(PANEL_HIDDEN_CLS);
        }
    }

    refresh(): void {
        if (this._activeMessageId === null) return;
        const existing = this.getQuickAskTurns().find(t => t.parentMessageId === this._activeMessageId);
        this._state = existing ? (existing.loading ? 'loading' : 'result') : 'input';
        this.render();
    }

    // ── Rendering ────────────────────────────────────────────────────────

    private render(): void {
        if (!this.el) {
            this.el = activeDocument.body.createDiv({
                cls: `session-quick-ask-panel ${PANEL_HIDDEN_CLS}`,
            });
        }

        if (this._state === 'hidden') {
            this.el.addClass(PANEL_HIDDEN_CLS);
            return;
        }

        this.el.removeClass(PANEL_HIDDEN_CLS);
        this.el.empty();

        // Header
        const header = this.el.createDiv({ cls: 'session-quick-ask-panel__header' });
        const titleEl = header.createSpan({ cls: 'session-quick-ask-panel__title' });
        const titleIcon = titleEl.createSpan({ cls: 'session-quick-ask-panel__title-icon' });
        setIcon(titleIcon, 'message-circle-question');
        titleEl.appendText(' ' + t('view.quickAskTitle'));

        // Button group (delete + close)
        const btnGroup = header.createDiv({ cls: 'session-quick-ask-panel__header-actions' });

        if (this._activeMessageId && (this._state === 'result' || this._state === 'loading')) {
            const deleteBtn = btnGroup.createEl('button', {
                cls: 'session-quick-ask-panel__delete clickable-icon',
                attr: { type: 'button' },
            });
            setIcon(deleteBtn, 'trash-2');
            deleteBtn.addEventListener('click', (e: MouseEvent) => {
                e.stopPropagation();
                const id = this._activeMessageId;
                if (id) {
                    this.hide();
                    this.onDelete(id);
                }
            });
        }

        const closeBtn = btnGroup.createEl('button', {
            cls: 'session-quick-ask-panel__close clickable-icon',
            attr: { type: 'button' },
        });
        setIcon(closeBtn, 'x');
        closeBtn.addEventListener('click', () => this.hide());

        // Body
        this.bodyEl = this.el.createDiv({ cls: 'session-quick-ask-panel__body' });

        switch (this._state) {
            case 'input': this.renderInput(); break;
            case 'loading': this.renderLoading(); break;
            case 'result': this.renderResult(); break;
        }

        this.positionPanel();
    }

    private renderInput(): void {
        if (!this.bodyEl) return;
        const wrapper = this.bodyEl.createDiv({ cls: 'session-quick-ask-panel__input-wrapper' });
        this.textareaEl = wrapper.createEl('textarea', {
            cls: 'session-quick-ask-panel__input',
            attr: { placeholder: t('view.quickAskPlaceholder'), rows: '3' },
        });

        const actions = wrapper.createDiv({ cls: 'session-quick-ask-panel__actions' });
        const sendBtn = actions.createEl('button', {
            cls: 'session-quick-ask-panel__send-btn clickable-icon',
            attr: { type: 'button' },
        });
        setIcon(sendBtn, 'send');
        sendBtn.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            const input = this.textareaEl?.value.trim();
            if (!input || !this._activeMessageId) return;
            this._state = 'loading';
            this.render();
            void this.onSubmit(this._activeMessageId, input).then(() => this.refresh());
        });
        this.textareaEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendBtn.click();
            }
        });
        window.setTimeout(() => this.textareaEl?.focus(), 0);
    }

    private renderLoading(): void {
        if (!this.bodyEl || !this._activeMessageId) return;
        const turns = this.getQuickAskTurns();
        const turn = turns.find(t => t.parentMessageId === this._activeMessageId);
        if (turn) {
            this.renderCompactBubble(this.bodyEl, turn.userMessage, 'user');
        }
        this.bodyEl.createDiv({
            cls: 'session-quick-ask-panel__loading',
            text: '\u00A0' + t('view.quickAskWaiting'),
        }, (el) => { el.createSpan({ cls: 'session-quick-ask-panel__spinner' }); });
    }

    private renderResult(): void {
        if (!this.bodyEl || !this._activeMessageId) return;
        const turns = this.getQuickAskTurns();
        const turn = turns.find(t => t.parentMessageId === this._activeMessageId);
        if (!turn) return;
        this.renderCompactBubble(this.bodyEl, turn.userMessage, 'user');
        this.renderCompactBubble(this.bodyEl, turn.assistantMessage, 'assistant');
    }

    private renderCompactBubble(parent: HTMLElement, msg: ChatMessage, role: 'user' | 'assistant'): void {
        const cls = computeBubbleClasses(msg);
        const bubble = parent.createDiv({ cls: `${BUBBLE_BASE_CLS} ${cls}` });
        const roleLabel = role === 'user' ? t('view.roleYou') : t('view.roleAI');
        bubble.createDiv({ cls: 'session-bubble__role', text: roleLabel });
        const body = bubble.createDiv({ cls: 'session-bubble__body' });
        const content = body.createDiv({ cls: 'session-bubble__content' });
        content.setText(msg.content || '');
    }

    // ── Positioning ──────────────────────────────────────────────────────

    /**
     * Anchor the panel near the target bubble using viewport coordinates.
     * Mounted on body with `position: fixed`, so it never affects the
     * session view's scroll layout.
     *
     * Rule: if the target button's midpoint is in the bottom half of the
     * viewport, open the panel ABOVE the button; otherwise BELOW.
     *
     * Uses `requestAnimationFrame` to ensure the browser has completed
     * layout before we measure `offsetWidth`.
     */
    private positionPanel(): void {
        window.requestAnimationFrame(() => this.doPosition());
    }

    private doPosition(): void {
        if (!this.el || !this._activeMessageId) return;

        // Anchor to the QuickAsk button, not the entire bubble.
        const parentBubble = this.getMessageBubbleEl(this._activeMessageId);
        const btnEl = parentBubble?.querySelector('[data-action="quick-ask"]') as HTMLElement | null;

        if (!btnEl) {
            this.el.setCssStyles({ left: '50%', top: '120px', transform: 'translateX(-50%)' });
            return;
        }

        const btnRect = btnEl.getBoundingClientRect();
        const panelWidth = this.el.offsetWidth || 420;
        const panelHeight = this.el.offsetHeight;
        const edgePad = 12;

        // Centre the panel on the button horizontally
        const rawLeft = btnRect.left + btnRect.width / 2 - panelWidth / 2;
        const maxLeft = window.innerWidth - panelWidth - edgePad;
        const left = Math.max(edgePad, Math.min(rawLeft, maxLeft));

        // Decide vertical direction
        const btnMidY = btnRect.top + btnRect.height / 2;
        const spaceBelow = window.innerHeight - btnRect.bottom - edgePad;
        const spaceAbove = btnRect.top - edgePad;
        const openAbove = btnMidY > window.innerHeight * 0.5 && spaceAbove >= panelHeight * 0.4;

        if (openAbove) {
            // Panel bottom edge at button top edge, minus a gap
            this.el.setCssStyles({
                left: `${left}px`,
                top: 'auto',
                bottom: `${window.innerHeight - btnRect.top + edgePad}px`,
                maxHeight: `${spaceAbove}px`,
            });
        } else {
            // Panel top edge at button bottom edge, plus a gap
            this.el.setCssStyles({
                left: `${left}px`,
                top: `${btnRect.bottom + edgePad}px`,
                bottom: 'auto',
                maxHeight: `${spaceBelow}px`,
            });
        }
    }

    // ── Outside-click handling ────────────────────────────────────────

    private attachOutsideClick(): void {
        this.detachOutsideClick();
        window.requestAnimationFrame(() => {
            if (this._state === 'hidden') return;
            const handler = (ev: MouseEvent) => {
                const target = ev.target as Node | null;
                if (!target) return;
                if (this.el?.contains(target)) return;
                // Don't close on click of the triggering QuickAsk button
                const parentBubble = this._activeMessageId
                    ? this.getMessageBubbleEl(this._activeMessageId) : undefined;
                if (parentBubble) {
                    const btn = parentBubble.querySelector('[data-action="quick-ask"]');
                    if (btn?.contains(target)) return;
                }
                this.hide();
            };
            this.outsideClickHandler = handler;
            activeDocument.addEventListener('click', handler);
        });
    }

    private detachOutsideClick(): void {
        if (this.outsideClickHandler) {
            activeDocument.removeEventListener('click', this.outsideClickHandler);
            this.outsideClickHandler = null;
        }
    }
}
