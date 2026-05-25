import { setIcon } from 'obsidian';

/**
 * Owns all scroll-related state and behaviour for the message list inside
 * {@link SessionView}.
 *
 * ## Model: explicit `autoFollow` state machine
 *
 * Auto-scroll is driven by a single boolean `autoFollow` flag.
 *
 * - When `true`, every content mutation (sync or async) re-pins the view to
 *   the tail of the message list — unconditionally, regardless of how much
 *   the content grew in one shot.
 * - When `false`, the view stays put. While a turn is in flight the
 *   floating "scroll to bottom" button is shown so the user can rejoin
 *   manually.
 *
 * State transitions are driven ONLY by explicit user gestures:
 *
 *   - `wheel` deltaY < 0                              → autoFollow = false
 *   - `wheel` deltaY > 0 landing near bottom          → autoFollow = true
 *   - `touchmove` accumulating > THRESHOLD upward     → autoFollow = false
 *   - `touchmove` accumulating > THRESHOLD downward
 *     AND user landed near bottom                     → autoFollow = true
 *   - `keydown` PageUp / Home / ArrowUp               → autoFollow = false
 *   - `keydown` PageDown / End / ArrowDown
 *     landing near bottom                             → autoFollow = true
 *   - click on the floating button                    → autoFollow = true
 *   - session switch / turn finish / abort / error    → autoFollow = true
 *
 * The `scroll` event itself NEVER writes the flag. It only adjusts the
 * floating button's visibility. This decoupling is the key to robust
 * behaviour on mobile, where the scroll event from a programmatic
 * `scrollTop = scrollHeight` may be coalesced and dispatched a frame or
 * two later — at which point `scrollHeight` has typically grown further
 * (streaming markdown rendered, image loaded, virtual keyboard pushed
 * layout, ...). Treating that delayed event as a user upward scroll —
 * which the previous implementation did — would incorrectly latch
 * `userScrolledUp = true` and disable auto-scroll for the rest of the
 * turn. We avoid this entire failure mode by sourcing intent only from
 * actual user-gesture events.
 *
 * ## Programmatic-scroll guard
 *
 * Every programmatic scroll bumps a guard counter, decremented two RAFs
 * later. While the counter is non-zero the scroll handler is a no-op.
 * Two RAFs cover iOS WKWebView's habit of coalescing scroll events into
 * the next frame.
 *
 * ## Safety net: MutationObserver + ResizeObserver
 *
 * Any DOM mutation under `messagesEl` (new bubble, streaming markdown
 * re-render via `replaceChildren`, late-mounted Obsidian embed, image
 * `src` swap, character-data change, ...) schedules a single
 * `onAsyncContentChanged()` for the next animation frame. When
 * `autoFollow` is on, this re-pins to the bottom — so callers no longer
 * need to manually plumb `onScrollNeeded()` into every async render
 * callback for correctness; the per-callsite calls remain only as a
 * fast path (they bring the pin forward by ~1 frame).
 *
 * Container size changes (`ResizeObserver` on `messagesEl`,
 * `visualViewport.resize`) are treated the same way: when `autoFollow`
 * is on we re-pin, otherwise we just leave it.
 *
 * ## Relative threshold for "near bottom"
 *
 * Only used by user gesture handlers to decide whether scrolling
 * downward should re-enable `autoFollow`. Computed as
 * `max(120, clientHeight * 0.25)` so narrow mobile viewports — where
 * each line of content adds 40+ CSS px to `scrollHeight` — get a
 * proportionally larger tolerance. The old fixed 100 px constant
 * was too tight for typical mobile streaming markdown jumps.
 *
 * The follow logic itself does NOT consult `isNearBottom()` — only the
 * explicit `autoFollow` flag does. The threshold thus cannot cause the
 * "we were pinned then a tall mutation pushed us past the threshold so
 * auto-scroll silently stops" failure mode that motivated the original
 * `runWithAutoFollow` workaround.
 */
export class ScrollController {
    private static readonly TOUCH_GESTURE_THRESHOLD = 30;
    private static readonly KEY_UP = new Set(['PageUp', 'Home', 'ArrowUp']);
    private static readonly KEY_DOWN = new Set(['PageDown', 'End', 'ArrowDown']);

    private autoFollow = true;

    /**
     * Non-zero while a programmatic scroll's coalesced `scroll` event is
     * still in flight. Bumped before every programmatic scroll and
     * decremented two RAFs later.
     */
    private programmaticScrollGuard = 0;

    /** Y of the most recent `touchstart`, used to compute incremental drag delta. */
    private touchStartY = 0;
    /** Accumulated drag delta across `touchmove` events of the current gesture. */
    private touchAccumulatedDeltaY = 0;

    private mutationObserver: MutationObserver | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private viewportResizeListener: (() => void) | null = null;
    private boundKeydown: ((e: KeyboardEvent) => void) | null = null;

    /** Pending RAF handle for {@link scheduleAsyncCheck}; `0` when none. */
    private pendingFollowFrame = 0;

    /**
     * When non-zero, async follow checks are suppressed so bulk DOM
     * mutations (e.g. prepending older history) do not yank scroll to
     * the tail between inserts.
     */
    private suspendDepth = 0;

    /** Fired on user scroll when `scrollTop` is near the top (load-older hook). */
    private nearTopCallback: (() => void) | null = null;
    private static readonly NEAR_TOP_THRESHOLD_PX = 200;

    constructor(
        private readonly messagesEl: HTMLElement,
        private readonly scrollToBottomBtn: HTMLButtonElement,
        private readonly isStreamingProvider: () => boolean,
    ) {}

    attach(): void {
        setIcon(this.scrollToBottomBtn, 'chevrons-down');
        this.scrollToBottomBtn.hide();
        this.scrollToBottomBtn.addEventListener('click', () => this.handleButtonClick());
        this.messagesEl.addEventListener('scroll', () => this.onMessagesScroll());

        this.messagesEl.addEventListener(
            'wheel',
            (e: WheelEvent) => this.onUserWheel(e),
            { passive: true },
        );

        this.messagesEl.addEventListener(
            'touchstart',
            (e: TouchEvent) => {
                const touch = e.touches[0];
                if (!touch) return;
                this.touchStartY = touch.clientY;
                this.touchAccumulatedDeltaY = 0;
            },
            { passive: true },
        );
        this.messagesEl.addEventListener(
            'touchmove',
            (e: TouchEvent) => this.onUserTouchMove(e),
            { passive: true },
        );

        // Keyboard fallback for desktop Page-Up/Down etc. Make the
        // message list focusable so these keys actually reach it when
        // the user clicks on the list area.
        if (!this.messagesEl.hasAttribute('tabindex')) {
            this.messagesEl.setAttribute('tabindex', '-1');
        }
        this.boundKeydown = (e: KeyboardEvent) => this.onUserKey(e);
        this.messagesEl.addEventListener('keydown', this.boundKeydown);

        // MutationObserver: catches every DOM mutation under messagesEl
        // (new bubble append, streaming markdown replaceChildren, late
        // image src swap, embed mount, ...) and schedules a single
        // follow check on the next frame.
        if (typeof MutationObserver !== 'undefined') {
            this.mutationObserver = new MutationObserver(() => this.scheduleAsyncCheck());
            this.mutationObserver.observe(this.messagesEl, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        }

        // ResizeObserver: catches container size changes (window resize,
        // mobile keyboard, URL-bar show/hide affecting clientHeight via
        // padding-bottom on the view root, ...).
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.scheduleAsyncCheck());
            this.resizeObserver.observe(this.messagesEl);
        }

        // VisualViewport: explicit signal for virtual keyboard / URL bar
        // visibility on mobile — fires earlier than the indirect
        // clientHeight change picked up by ResizeObserver.
        const vv = window.visualViewport;
        if (vv) {
            this.viewportResizeListener = () => this.scheduleAsyncCheck();
            vv.addEventListener('resize', this.viewportResizeListener);
        }
    }

    /**
     * Tear down observers and external listeners. Safe to call multiple
     * times. Should be invoked from {@link SessionView.onClose} so that
     * a backgrounded session does not keep these references alive past
     * the view's lifetime.
     */
    detach(): void {
        this.mutationObserver?.disconnect();
        this.mutationObserver = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.pendingFollowFrame !== 0) {
            window.cancelAnimationFrame(this.pendingFollowFrame);
            this.pendingFollowFrame = 0;
        }
        const vv = window.visualViewport;
        if (vv && this.viewportResizeListener) {
            vv.removeEventListener('resize', this.viewportResizeListener);
            this.viewportResizeListener = null;
        }
        if (this.boundKeydown) {
            this.messagesEl.removeEventListener('keydown', this.boundKeydown);
            this.boundKeydown = null;
        }
    }

    isNearBottom(): boolean {
        const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
        return scrollHeight - scrollTop - clientHeight < this.scrollThreshold();
    }

    /**
     * Run a synchronous DOM-mutating callback while preserving the
     * auto-follow contract: if `autoFollow` was on going in, re-pin to
     * the bottom after `fn()` returns regardless of how much the content
     * grew. This is the fast path; the MutationObserver safety net
     * would catch the same growth one frame later.
     */
    runWithAutoFollow<T>(fn: () => T): T {
        const shouldFollow = this.autoFollow;
        const result = fn();
        if (shouldFollow) {
            this.programmaticScrollToBottom();
            this.scrollToBottomBtn.hide();
        } else if (this.isStreamingProvider()) {
            this.scrollToBottomBtn.show();
        }
        return result;
    }

    /**
     * Called from async render callbacks AND from the
     * Mutation/Resize/VisualViewport observers. Re-pins when
     * `autoFollow` is on. Otherwise updates button visibility.
     *
     * Retains the historical name as the public API for callsites that
     * already wire into it (e.g. `BubbleRenderer.onScrollNeeded`,
     * `appendErrorBubble`).
     */
    maybeScrollToBottom(): void {
        this.onAsyncContentChanged();
    }

    /** Force-pin to the bottom AND re-enable auto-follow. */
    forceScrollToBottom(): void {
        this.autoFollow = true;
        this.programmaticScrollToBottom();
        this.scrollToBottomBtn.hide();
    }

    /**
     * Re-enable `autoFollow` without forcing a scroll. The next mutation
     * (or the safety-net observers) will pick it up. Called on stream
     * finish / abort / error.
     */
    restoreAutoFollow(): void {
        this.autoFollow = true;
        if (this.isNearBottom()) this.scrollToBottomBtn.hide();
    }

    /** Reset to default (autoFollow on, button hidden). Used on session switch. */
    resetScrollIntent(): void {
        this.autoFollow = true;
        this.scrollToBottomBtn.hide();
    }

    /** Suppress auto-follow safety-net checks during bulk prepend passes. */
    suspend(): void {
        this.suspendDepth++;
    }

    resume(): void {
        this.suspendDepth = Math.max(0, this.suspendDepth - 1);
    }

    /**
     * Enter history-prepend mode: suppress observer follow checks AND
     * latch `autoFollow` off so async bubble renders cannot yank the
     * view back to the tail when older messages are inserted above.
     */
    beginHistoryPrepend(): void {
        this.suspendDepth++;
        this.autoFollow = false;
        this.cancelPendingFollowFrame();
    }

    endHistoryPrepend(): void {
        this.suspendDepth = Math.max(0, this.suspendDepth - 1);
        this.autoFollow = false;
        this.cancelPendingFollowFrame();
    }

    /**
     * Distance from the top of `anchor` to the current scroll position.
     * Pass the return value to {@link restoreAnchorScroll} after prepends.
     */
    captureAnchorScroll(anchor: HTMLElement): number {
        return anchor.offsetTop - this.messagesEl.scrollTop;
    }

    /** Restore the viewport so `anchor` stays at the same visual offset. */
    restoreAnchorScroll(anchor: HTMLElement, anchorScrollOffset: number): void {
        this.programmaticScrollGuard++;
        this.messagesEl.scrollTop = anchor.offsetTop - anchorScrollOffset;
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            this.programmaticScrollGuard = Math.max(0, this.programmaticScrollGuard - 1);
        }));
    }

    /** Register a callback invoked when the user scrolls near the top. */
    setNearTopCallback(cb: (() => void) | null): void {
        this.nearTopCallback = cb;
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /**
     * Threshold used by user-gesture handlers to decide whether a downward
     * scroll has reached the tail closely enough to re-enable
     * `autoFollow`. Relative to viewport height to stay sane on narrow
     * mobile screens where a single content jump can easily exceed the
     * old 100 px constant.
     */
    private scrollThreshold(): number {
        return Math.max(120, this.messagesEl.clientHeight * 0.25);
    }

    private onAsyncContentChanged(): void {
        if (this.suspendDepth > 0) return;
        if (this.autoFollow) {
            this.programmaticScrollToBottom();
            this.scrollToBottomBtn.hide();
            return;
        }
        if (this.isStreamingProvider() && !this.isNearBottom()) {
            this.scrollToBottomBtn.show();
        }
    }

    /**
     * Coalesce many synchronous mutations into one follow check per frame.
     * MutationObserver fires in a microtask, before layout — RAF'ing
     * defers the geometry read to after layout has settled.
     */
    private scheduleAsyncCheck(): void {
        if (this.suspendDepth > 0) return;
        if (this.pendingFollowFrame !== 0) return;
        this.pendingFollowFrame = window.requestAnimationFrame(() => {
            this.pendingFollowFrame = 0;
            this.onAsyncContentChanged();
        });
    }

    private cancelPendingFollowFrame(): void {
        if (this.pendingFollowFrame === 0) return;
        window.cancelAnimationFrame(this.pendingFollowFrame);
        this.pendingFollowFrame = 0;
    }

    private handleButtonClick(): void {
        this.autoFollow = true;
        this.scrollToBottomBtn.hide();
        this.programmaticScrollGuard++;
        this.messagesEl.scrollTo({
            top: this.messagesEl.scrollHeight,
            behavior: 'smooth',
        });
        // Smooth scroll dispatches many scroll events across its
        // animation; cover the window generously before allowing
        // user-gesture writes again.
        window.setTimeout(() => {
            this.programmaticScrollGuard = Math.max(0, this.programmaticScrollGuard - 1);
        }, 500);
    }

    private programmaticScrollToBottom(): void {
        const target = this.messagesEl.scrollHeight;
        // Skip when already at or near the bottom. Repeatedly writing
        // scrollTop to an unchanged scroll position causes unnecessary
        // layout operations that can interfere with iOS WKWebView's
        // touch-gesture recognition during streaming renders.
        if (Math.abs(this.messagesEl.scrollTop - target) < 2) return;
        this.programmaticScrollGuard++;
        this.messagesEl.scrollTop = target;
        // Two RAFs cover iOS WebView's habit of coalescing the scroll
        // event for a programmatic write into the next frame.
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            this.programmaticScrollGuard = Math.max(0, this.programmaticScrollGuard - 1);
        }));
    }

    private onMessagesScroll(): void {
        // Programmatic scrolls never update intent. Short-circuit the
        // whole handler so the coalesced scroll event for our own
        // `scrollTop = scrollHeight` does not toggle the button to a
        // stale state either.
        if (this.programmaticScrollGuard > 0) return;

        // Scrollbar / trackpad momentum can move the view without a wheel
        // event — treat any non-programmatic scroll away from the tail as
        // the user browsing history so auto-follow does not fight prepend.
        if (!this.isNearBottom()) {
            this.autoFollow = false;
        }

        if (
            this.nearTopCallback
            && this.messagesEl.scrollTop < ScrollController.NEAR_TOP_THRESHOLD_PX
        ) {
            this.nearTopCallback();
        }

        if (this.autoFollow || this.isNearBottom()) {
            this.scrollToBottomBtn.hide();
        } else if (this.isStreamingProvider()) {
            this.scrollToBottomBtn.show();
        }
    }

    private onUserWheel(e: WheelEvent): void {
        if (e.deltaY < 0) {
            this.autoFollow = false;
            if (this.isStreamingProvider()) this.scrollToBottomBtn.show();
        } else if (e.deltaY > 0) {
            // RAF so layout has settled before we check geometry.
            window.requestAnimationFrame(() => {
                if (this.isNearBottom()) {
                    this.autoFollow = true;
                    this.scrollToBottomBtn.hide();
                }
            });
        }
    }

    private onUserTouchMove(e: TouchEvent): void {
        const touch = e.touches[0];
        if (!touch) return;
        // Per-frame delta is small and noisy on iOS (sub-pixel reports
        // during momentum decel). Accumulate so brief unintentional
        // jitter cannot flip autoFollow.
        const deltaY = this.touchStartY - touch.clientY;
        this.touchAccumulatedDeltaY += deltaY;
        this.touchStartY = touch.clientY;

        if (this.touchAccumulatedDeltaY > ScrollController.TOUCH_GESTURE_THRESHOLD) {
            this.autoFollow = false;
            if (this.isStreamingProvider()) this.scrollToBottomBtn.show();
        } else if (this.touchAccumulatedDeltaY < -ScrollController.TOUCH_GESTURE_THRESHOLD) {
            window.requestAnimationFrame(() => {
                if (this.isNearBottom()) {
                    this.autoFollow = true;
                    this.scrollToBottomBtn.hide();
                }
            });
        }
    }

    private onUserKey(e: KeyboardEvent): void {
        if (ScrollController.KEY_UP.has(e.key)) {
            this.autoFollow = false;
            if (this.isStreamingProvider()) this.scrollToBottomBtn.show();
        } else if (ScrollController.KEY_DOWN.has(e.key)) {
            window.requestAnimationFrame(() => {
                if (this.isNearBottom()) {
                    this.autoFollow = true;
                    this.scrollToBottomBtn.hide();
                }
            });
        }
    }
}
