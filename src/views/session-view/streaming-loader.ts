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

    constructor(private readonly messagesEl: HTMLElement) {}

    /** Create the loader DOM as the last child of `messagesEl`. */
    mount(): void {
        this.el = this.messagesEl.createEl('div', {
            cls: 'session-streaming-loader session-streaming-loader--hidden',
        });
        // Three independent dot spans so each can ride its own
        // staggered up/down keyframe — yielding the wave effect.
        for (let i = 0; i < 3; i++) {
            this.el.createEl('span', {
                cls: 'session-streaming-loader__dot',
                text: '.',
            });
        }
    }

    /**
     * Drop the loader reference; its DOM node lives inside contentEl
     * which the parent ItemView tears down.
     */
    dispose(): void {
        this.el = null;
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
        this.el?.addClass('session-streaming-loader--hidden');
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
