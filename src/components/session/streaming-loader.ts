/**
 * Singleton "AI is working" placeholder anchored to the tail of
 * `messagesEl` for the view's lifetime. Renders as a simple `...`
 * trailing the message list while a runtime turn is in-flight, and
 * is hidden the moment the turn finishes / aborts / errors.
 *
 * Unlike the previous typing indicator, it stays visible for the
 * entire duration of a busy turn — including while the assistant is
 * streaming visible content or while a tool call is mid-flight — so
 * callers don't need to juggle per-`message-update` show/hide
 * transitions. The single piece of "is the AI still working?"
 * feedback for the user lives here.
 *
 * The DOM node is created once on mount and shown/hidden via the
 * `session-streaming-loader--hidden` modifier; it is never removed
 * and recreated. This prevents stale loader nodes from getting
 * stranded between bubbles when a callback path forgets to hide it
 * before appending a new bubble.
 */
export class StreamingLoader {
    private el: HTMLElement | null = null;
    /** Dots container — hidden when a status text is shown. */
    private dotsEl: HTMLElement | null = null;
    /** Status text element — created lazily and hidden by default. */
    private statusEl: HTMLElement | null = null;
    private threeDots: HTMLSpanElement[] = [];

    constructor(private readonly messagesEl: HTMLElement) {}

    /** Create the loader DOM as the last child of `messagesEl`. */
    mount(): void {
        this.el = this.messagesEl.createDiv({
            cls: 'session-streaming-loader session-streaming-loader--hidden',
        });
        this.dotsEl = this.el.createDiv({
            cls: 'session-streaming-loader__dots',
        });
        // Three independent dot spans so each can ride its own
        // staggered up/down keyframe — yielding the wave effect.
        for (let i = 0; i < 3; i++) {
            const dot = this.dotsEl.createSpan({
                cls: 'session-streaming-loader__dot',
                text: '.',
            });
            this.threeDots.push(dot);
        }
    }

    /** Drop the loader reference; its DOM node lives inside contentEl
     * which the parent ItemView tears down. */
    dispose(): void {
        this.el = null;
        this.dotsEl = null;
        this.statusEl = null;
        this.threeDots = [];
    }

    /**
     * Move the loader to the tail of `messagesEl`. No-op if it is
     * already last; otherwise a DOM move (not a recreate) — calling
     * `appendChild` on an existing child relocates it.
     *
     * Any code that appends a new child to `messagesEl` must call
     * this afterwards so the loader stays at the tail position.
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
        el.removeClass('session-streaming-loader--hidden');
    }

    hide(): void {
        this.hideStatus();
        this.el?.addClass('session-streaming-loader--hidden');
    }

    /**
     * Show a status message in place of the animated dots.
     * Used to surface transient states like "Compressing context…"
     * while the summarizer LLM is running.
     */
    showStatus(text: string): void {
        if (!this.el) return;
        // Hide the dots
        if (this.dotsEl) this.dotsEl.addClass('session-streaming-loader__dots--hidden');
        // Create or update the status element
        if (!this.statusEl) {
            this.statusEl = this.el.createDiv({
                cls: 'session-streaming-loader__status',
            });
        }
        this.statusEl.setText(text);
        this.statusEl.removeClass('session-streaming-loader__status--hidden');
    }

    /**
     * Hide the status text and restore the animated dots.
     */
    hideStatus(): void {
        if (this.statusEl) {
            this.statusEl.addClass('session-streaming-loader__status--hidden');
        }
        if (this.dotsEl) {
            this.dotsEl.removeClass('session-streaming-loader__dots--hidden');
        }
    }

    /**
     * Detach the loader node before callers empty `messagesEl`, then
     * call {@link reattachAfterEmpty} to put it back.
     */
    detach(): void {
        this.el?.detach();
    }

    /** Re-append the detached loader to the (now empty) messagesEl tail. */
    reattachAfterEmpty(): void {
        if (this.el) {
            this.messagesEl.appendChild(this.el);
        }
    }
}
