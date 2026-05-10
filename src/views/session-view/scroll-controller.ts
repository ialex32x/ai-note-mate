import { setIcon } from 'obsidian';

/**
 * Encapsulates all scroll-related state and behaviour for the message list
 * inside {@link SessionView}:
 *
 *   - the scroll container (`messagesEl`)
 *   - the floating "scroll to bottom" button
 *   - the `userScrolledUp` flag (set via wheel/touch events so programmatic
 *     scrolls cannot flip it)
 *   - the helpers `isNearBottom` / `maybeScrollToBottom` / `forceScrollToBottom`
 *
 * Extracted from SessionView to reduce its size while preserving exact
 * behaviour. See the comments on `userScrolledUp` in the original code
 * for the rationale behind the wheel/touch detection strategy.
 */
export class ScrollController {
    private static readonly SCROLL_THRESHOLD = 100;

    /**
     * Set to true when the user manually scrolls up during streaming.
     * While true, auto-scroll-to-bottom is suppressed so the user can
     * read earlier content without being pulled back down on every
     * message update (especially during the thinking phase where tokens
     * arrive frequently but produce no visible output).
     */
    private userScrolledUp = false;
    private touchStartY = 0;

    constructor(
        private readonly messagesEl: HTMLElement,
        private readonly scrollToBottomBtn: HTMLButtonElement,
        private readonly isStreamingProvider: () => boolean,
    ) {}

    /**
     * Attach scroll / wheel / touch event handlers on the message list and
     * wire up the floating "scroll to bottom" button. Call once during
     * view initialization.
     */
    attach(): void {
        setIcon(this.scrollToBottomBtn, 'chevrons-down');
        this.scrollToBottomBtn.hide();
        this.scrollToBottomBtn.addEventListener('click', () => {
            this.userScrolledUp = false;
            this.scrollToBottomBtn.hide();
            this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
        });
        this.messagesEl.addEventListener('scroll', () => this.onMessagesScroll());

        // Detect user scroll intent via wheel / touch events.
        // These are guaranteed user-initiated and cannot be confused
        // with programmatic scrollTop changes (unlike the scroll event).
        this.messagesEl.addEventListener('wheel', (e: WheelEvent) => this.onMessagesWheel(e), { passive: true });

        this.messagesEl.addEventListener('touchstart', (e: TouchEvent) => {
            const touch = e.touches[0];
            if (touch) this.touchStartY = touch.clientY;
        }, { passive: true });
        this.messagesEl.addEventListener('touchmove', (e: TouchEvent) => {
            if (!this.isStreamingProvider()) return;
            const touch = e.touches[0];
            if (!touch) return;
            const deltaY = this.touchStartY - touch.clientY;
            if (deltaY > 10) {
                // Finger moved up → user wants to scroll up
                this.userScrolledUp = true;
            } else if (deltaY < -10) {
                // Finger moved down — check if they reached the bottom
                requestAnimationFrame(() => {
                    if (this.isNearBottom()) {
                        this.userScrolledUp = false;
                    }
                });
            }
            this.touchStartY = touch.clientY;
        }, { passive: true });
    }

    isNearBottom(): boolean {
        const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
        return scrollHeight - scrollTop - clientHeight < ScrollController.SCROLL_THRESHOLD;
    }

    maybeScrollToBottom(): void {
        if (this.userScrolledUp) {
            // User intentionally scrolled up — show the button so they
            // can jump back when ready, but don't force-scroll.
            if (this.isStreamingProvider()) {
                this.scrollToBottomBtn.show();
            }
            return;
        }
        if (this.isNearBottom()) {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            this.scrollToBottomBtn.hide();
        } else if (this.isStreamingProvider()) {
            this.scrollToBottomBtn.show();
        }
    }

    /**
     * Run a DOM-mutating callback while preserving "auto-follow" semantics.
     *
     * The default {@link maybeScrollToBottom} only inspects the *post*-mutation
     * scroll state, which breaks for any single mutation that grows the
     * scrollable content by more than {@link SCROLL_THRESHOLD} pixels at
     * once — typical examples being tool-call bubbles being created with
     * their (often tall) confirmation/detail UI, or sub-agent bubbles
     * appearing with collapsibles + badges. In those cases, even if the
     * user *was* pinned to the bottom right before the mutation, the new
     * scrollHeight delta pushes `isNearBottom()` over the threshold, and
     * the auto-scroll branch is silently skipped.
     *
     * This helper captures the "was near bottom" intent *before* the
     * mutation runs, then unconditionally re-pins to the bottom afterwards
     * (assuming the user has not manually scrolled away). Programmatic
     * scrollTop writes do not flip `userScrolledUp` (it is only set by
     * wheel/touch/keyboard handlers), so this is safe.
     */
    runWithAutoFollow<T>(fn: () => T): T {
        const wasNearBottom = !this.userScrolledUp && this.isNearBottom();
        const result = fn();
        if (this.userScrolledUp) {
            if (this.isStreamingProvider()) {
                this.scrollToBottomBtn.show();
            }
            return result;
        }
        if (wasNearBottom) {
            // Pre-mutation snapshot said we were pinned — re-pin regardless
            // of how much the content grew during fn().
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            this.scrollToBottomBtn.hide();
        } else if (this.isNearBottom()) {
            this.scrollToBottomBtn.hide();
        } else if (this.isStreamingProvider()) {
            this.scrollToBottomBtn.show();
        }
        return result;
    }

    forceScrollToBottom(): void {
        this.userScrolledUp = false;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        this.scrollToBottomBtn.hide();
    }

    /**
     * Clear the "user scrolled up" flag without touching the message list or
     * the scroll-to-bottom button. Called on stream end / abort / error so
     * the next auto-scroll is not suppressed. Button visibility will be
     * recomputed the next time `maybeScrollToBottom` runs.
     */
    clearUserScrolledUp(): void {
        this.userScrolledUp = false;
    }

    /** Clear the scrolled-up flag and hide the button. Used on session switch. */
    resetScrollIntent(): void {
        this.userScrolledUp = false;
        this.scrollToBottomBtn.hide();
    }

    /**
     * Scroll-event handler.  Only updates button visibility and
     * detects keyboard-based scroll-up during streaming.
     */
    private onMessagesScroll(): void {
        if (this.isNearBottom()) {
            this.scrollToBottomBtn.hide();
        } else if (this.isStreamingProvider()) {
            this.scrollToBottomBtn.show();
            // Also set the flag here as a fallback for keyboard
            // scrolling (Page-Up, Arrow-Up, etc.) which does NOT
            // fire wheel events.
            this.userScrolledUp = true;
        }
    }

    /**
     * Wheel-event handler for detecting user scroll intent.
     * Wheel events are guaranteed to be user-initiated, so they
     * cannot be confused with programmatic scrollTop changes.
     */
    private onMessagesWheel(e: WheelEvent): void {
        if (!this.isStreamingProvider()) return;
        if (e.deltaY < 0) {
            // User scrolled up → suppress auto-scroll
            this.userScrolledUp = true;
        } else if (e.deltaY > 0) {
            // User scrolled down — if they reached the bottom,
            // resume auto-scrolling.
            requestAnimationFrame(() => {
                if (this.isNearBottom()) {
                    this.userScrolledUp = false;
                }
            });
        }
    }
}
