/**
 * Singleton typing indicator (three bouncing dots). Lives as the last child
 * of `messagesEl` for the view's lifetime and is show/hidden via a CSS
 * modifier class — never removed and recreated. This prevents stale
 * indicator nodes from getting "stranded" between message bubbles when
 * callback paths forget to hide it before appending a new bubble.
 *
 * Extracted from SessionView.
 */
export class TypingIndicator {
    private el: HTMLElement | null = null;

    constructor(private readonly messagesEl: HTMLElement) {}

    /** Create the indicator DOM as the last child of `messagesEl`. */
    mount(): void {
        this.el = this.messagesEl.createEl('div', {
            cls: 'session-typing-indicator session-typing-indicator--hidden',
        });
        const dotsContainer = this.el.createEl('span', { cls: 'session-typing-indicator__dots' });
        for (let i = 0; i < 3; i++) {
            dotsContainer.createEl('span', { cls: 'session-typing-indicator__dot', text: '.' });
        }
    }

    /**
     * Drop the singleton typing indicator reference; its DOM node is
     * inside contentEl which will be torn down by the parent ItemView.
     */
    dispose(): void {
        this.el = null;
    }

    /**
     * Move the singleton typing indicator to the tail of messagesEl. This is
     * a no-op if the indicator is already last, and a DOM move (not a
     * recreate) otherwise — `appendChild` on an existing child relocates it.
     *
     * Any code that appends a new child to `messagesEl` must call this
     * afterwards to move this node back to the tail position.
     */
    pinToEnd(): void {
        const el = this.el;
        if (!el) return;
        if (el.parentElement !== this.messagesEl) {
            this.messagesEl.appendChild(el);
            return;
        }
        if (this.messagesEl.lastElementChild !== el) {
            this.messagesEl.appendChild(el);
        }
    }

    show(): void {
        const el = this.el;
        if (!el) return;
        this.pinToEnd();
        el.removeClass('session-typing-indicator--hidden');
    }

    hide(): void {
        const el = this.el;
        if (!el) return;
        el.addClass('session-typing-indicator--hidden');
    }

    /**
     * Detach the indicator node before callers empty `messagesEl`, then
     * call {@link reattachAfterEmpty} to put it back.
     */
    detach(): void {
        this.el?.detach();
    }

    /** Re-append the detached indicator to the (now empty) messagesEl tail. */
    reattachAfterEmpty(): void {
        if (this.el) {
            this.messagesEl.appendChild(this.el);
        }
    }
}
