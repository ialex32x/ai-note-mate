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
 * State transitions are driven by explicit user gestures:
 *
 *   - `wheel` deltaY < 0                              → autoFollow = false
 *                                                       + autoFollowParked = true
 *   - `wheel` deltaY > 0 landing at absolute bottom
 *     (< 4 px from the tail)                          → autoFollow = true
 *   - `touchmove` first upward frame                 → autoFollow = false
 *                                                       + autoFollowParked = true
 *     (accumulated > THRESHOLD shows the button)
 *   - `touchmove` accumulating > THRESHOLD downward
 *     AND user landed near bottom                     → autoFollow = true
 *   - `keydown` PageUp / Home / ArrowUp               → autoFollow = false
 *                                                       + autoFollowParked = true
 *   - `keydown` PageDown / End / ArrowDown
 *     landing near bottom                             → autoFollow = true
 *   - click on the floating button                    → autoFollow = true
 *   - session switch / turn finish / abort / error    → autoFollow = true
 *
 * The `scroll` event participates only narrowly: it disables auto-follow
 * when the view actually moves UP and away from the tail with no
 * accompanying wheel/touch event — i.e. a scrollbar drag or inertial
 * momentum scroll, the only "browse history" gestures that produce no
 * other signal. It can NEVER re-enable auto-follow.
 *
 * The direction gate (`scrollTop` decreased vs. the previous event) is what
 * makes this safe on mobile, where the scroll event from a programmatic
 * `scrollTop = scrollHeight` may be coalesced and dispatched a frame or two
 * later — at which point `scrollHeight` has typically grown further
 * (streaming markdown rendered, image loaded, virtual keyboard pushed
 * layout, ...). Such a delayed event still reflects a DOWNWARD move, so it
 * fails the "moved up" test and cannot latch auto-follow off. A short-lived
 * {@link programmaticScrollGuard} additionally short-circuits the handler
 * during our own scrolls; the direction gate is the durable guarantee that
 * holds even if a coalesced event slips past that window.
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
     * "Parked" state: auto-follow is intentionally off and should STAY off
     * past the end of the current turn (i.e. trailing async content like the
     * insight card or follow-up bar must not yank the view to the tail).
     *
     * Set for three reasons:
     *   1. the user manually scrolled up (wheel / touch / key / scrollbar)
     *      — they want to browse history without the view snapping back;
     *   2. the last streaming message grew taller than the viewport
     *      (see {@link onAsyncContentChanged}); once set, the oversized check
     *      is suppressed for the remainder of the turn so manually scrolling
     *      back to the tail resumes follow without being kicked out again; and
     *   3. the user explicitly jumped to a specific message
     *      (see {@link suppressAutoFollow}) — they want to stay at the jump
     *      target until they act again.
     *
     * Cleared at the start of every new turn (via
     * {@link forceScrollToBottom}) and on session switch (via
     * {@link resetScrollIntent}).
     */
    private autoFollowParked = false;

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

    /**
     * `scrollTop` observed on the previous `scroll` event. Used to derive the
     * direction of movement so {@link onMessagesScroll} can disable auto-follow
     * ONLY on genuine upward movement (scrollbar drag / inertial momentum —
     * the no-gesture scrolls that produce no wheel/touch event). Programmatic
     * follow always moves DOWN, so its (possibly delayed/coalesced) scroll
     * events can never look like an upward user scroll and thus can't wrongly
     * latch follow off — this holds even if such an event slips past the
     * {@link programmaticScrollGuard} window.
     */
    private lastScrollTop = 0;
    /** Min `scrollTop` decrease (px) treated as a real upward movement. */
    private static readonly UP_MOVE_EPSILON_PX = 1;

    private mutationObserver: MutationObserver | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private viewportResizeListener: (() => void) | null = null;

    /**
     * Teardown callbacks for every DOM event listener registered in
     * {@link attach}. Populated via {@link addListener} so {@link detach}
     * can remove all of them — not just a hand-picked subset — and leave no
     * listener holding this controller (and its `messagesEl`) alive past the
     * view's lifetime.
     */
    private listenerCleanups: Array<() => void> = [];

    /**
     * Handle for the 500 ms guard-release timer armed by
     * {@link handleButtonClick}. Tracked so {@link detach} can cancel a
     * pending one instead of letting it fire against a torn-down view.
     */
    private buttonClickTimeout = 0;

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
        // Seed the direction baseline so the first user scroll is classified
        // correctly (a 0-baseline would mis-read an initial upward drag).
        this.lastScrollTop = this.messagesEl.scrollTop;
        this.addListener(this.scrollToBottomBtn, 'click', () => this.handleButtonClick());
        this.addListener(this.messagesEl, 'scroll', () => this.onMessagesScroll());

        this.addListener(
            this.messagesEl,
            'wheel',
            (e) => this.onUserWheel(e),
            { passive: true },
        );

        this.addListener(
            this.messagesEl,
            'touchstart',
            (e) => {
                const touch = e.touches[0];
                if (!touch) return;
                this.touchStartY = touch.clientY;
                this.touchAccumulatedDeltaY = 0;
                // Cancel any pending follow frame so a previously
                // scheduled programmatic scroll cannot yank the view
                // back to the tail mid-gesture.
                this.cancelPendingFollowFrame();
            },
            { passive: true },
        );
        this.addListener(
            this.messagesEl,
            'touchmove',
            (e) => this.onUserTouchMove(e),
            { passive: true },
        );

        // Keyboard fallback for desktop Page-Up/Down etc. Make the
        // message list focusable so these keys actually reach it when
        // the user clicks on the list area.
        if (!this.messagesEl.hasAttribute('tabindex')) {
            this.messagesEl.setAttribute('tabindex', '-1');
        }
        this.addListener(this.messagesEl, 'keydown', (e) => this.onUserKey(e));

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
        if (this.buttonClickTimeout !== 0) {
            window.clearTimeout(this.buttonClickTimeout);
            this.buttonClickTimeout = 0;
        }
        const vv = window.visualViewport;
        if (vv && this.viewportResizeListener) {
            vv.removeEventListener('resize', this.viewportResizeListener);
            this.viewportResizeListener = null;
        }
        // Remove every DOM listener registered in attach() (click / scroll /
        // wheel / touchstart / touchmove / keydown) so none of them keep this
        // controller — and the message list element — alive after teardown.
        for (const cleanup of this.listenerCleanups) cleanup();
        this.listenerCleanups = [];
    }

    /**
     * Register a DOM event listener and record its teardown so {@link detach}
     * can remove it. Using the same registration path for every listener
     * guarantees attach/detach symmetry — adding a new listener can no longer
     * silently leak by forgetting a matching `removeEventListener`.
     */
    private addListener<K extends keyof HTMLElementEventMap>(
        target: HTMLElement,
        type: K,
        handler: (e: HTMLElementEventMap[K]) => void,
        options?: AddEventListenerOptions,
    ): void {
        target.addEventListener(type, handler, options);
        this.listenerCleanups.push(
            () => target.removeEventListener(type, handler, options),
        );
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
        }
        this.updateButtonVisibility();
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

    /** Force-pin to the bottom AND re-enable auto-follow. Also
     * re-arms the oversized-message guard for the new turn. */
    forceScrollToBottom(): void {
        this.autoFollow = true;
        this.autoFollowParked = false;
        this.programmaticScrollToBottom();
        this.updateButtonVisibility();
    }

    /** Whether auto-follow is "parked" — intentionally off and meant to
     * persist past the end of the turn (because the last message grew taller
     * than the viewport, or the user jumped to a specific message). When
     * true, {@link restoreAutoFollow} should be skipped on stream finish so
     * the user stays at their current reading position instead of being
     * yanked to the bottom by async trailing content (e.g. insight card
     * results, follow-up bar). */
    isAutoFollowParked(): boolean {
        return this.autoFollowParked;
    }

    /**
     * Re-enable `autoFollow` without forcing a scroll. The next mutation
     * (or the safety-net observers) will pick it up. Called on stream
     * finish / abort / error.
     *
     * Note: callers should check {@link isAutoFollowParked} on
     * normal finish — when the user is reading a long streaming message
     * they should not be forced back to the tail. Abort / error paths
     * still call this unconditionally because the turn was interrupted.
     */
    restoreAutoFollow(): void {
        this.autoFollow = true;
        this.updateButtonVisibility();
    }

    /** Reset to default (autoFollow on, button hidden, oversized guard
     * cleared). Used on session switch. */
    resetScrollIntent(): void {
        this.autoFollow = true;
        this.autoFollowParked = false;
        this.updateButtonVisibility();
    }

    /**
     * Latch auto-follow off because the user explicitly navigated to a
     * specific message (jump-to-prev/next-user, search-result / checkpoint
     * goto). Mirrors an upward user gesture (wheel-up / PageUp): the view
     * should stay at the jump target and NOT be yanked back to the tail by
     * streaming mutations. Cancels any pending follow frame and shows the
     * rejoin button while a turn is in flight so the user can return manually.
     *
     * In the jump flow this is called up-front as a TRANSIENT guard so an
     * async history load (or in-flight streaming) can't re-pin to the tail
     * before the target lands. {@link jumpScrollTo} then makes the
     * authoritative follow decision based on where the target actually
     * settles — re-enabling follow when it lands at the tail.
     */
    suppressAutoFollow(): void {
        this.autoFollow = false;
        // Park: stay at the jump target even after the turn finishes, until
        // the user sends a new message (forceScrollToBottom) or switches
        // sessions (resetScrollIntent).
        this.autoFollowParked = true;
        this.cancelPendingFollowFrame();
        this.updateButtonVisibility();
    }

    /**
     * Scroll to an absolute offset as part of a user jump to a specific
     * message, then decide the auto-follow state from the LANDING position:
     *
     * - target lands at/near the tail (`isNearBottom()`) → the user hasn't
     *   really left the conversation, so resume follow (clear the park);
     * - target lands away from the tail → park at the target so streaming /
     *   trailing content won't yank the view back to the bottom.
     *
     * The scroll is guarded (`programmaticScrollGuard`) so the direction-aware
     * {@link onMessagesScroll} ignores the resulting event, and the direction
     * baseline is moved with it so a delayed coalesced event can't be misread.
     */
    jumpScrollTo(top: number): void {
        this.programmaticScrollGuard++;
        this.messagesEl.scrollTop = top;
        this.lastScrollTop = this.messagesEl.scrollTop;
        this.cancelPendingFollowFrame();

        if (this.isNearBottom()) {
            this.autoFollow = true;
            this.autoFollowParked = false;
        } else {
            this.autoFollow = false;
            this.autoFollowParked = true;
        }
        this.updateButtonVisibility();

        // Two RAFs cover iOS WebView's habit of coalescing the scroll event
        // for a programmatic write into the next frame.
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            this.programmaticScrollGuard = Math.max(0, this.programmaticScrollGuard - 1);
        }));
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
        // Move the direction baseline — same rationale as
        // programmaticScrollToBottom and jumpScrollTo: without this,
        // the next user scroll event would compare against a stale
        // pre-prepend scrollTop and misread the scroll direction.
        this.lastScrollTop = this.messagesEl.scrollTop;
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            this.programmaticScrollGuard = Math.max(0, this.programmaticScrollGuard - 1);
        }));
    }

    /** Register a callback invoked when the user scrolls near the top. */
    setNearTopCallback(cb: (() => void) | null): void {
        this.nearTopCallback = cb;
    }

    /** Current `scrollTop` of the messages container. */
    getScrollTop(): number {
        return this.messagesEl.scrollTop;
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
            // When the last message grows taller than the viewport,
            // forcing auto-scroll on every token creates a jarring
            // experience — the user cannot read the beginning of the
            // message. Exit auto-follow so the view stays put.
            //
            // The check is armed at the start of each turn and fires
            // exactly once per oversized message. Once fired,
            // `autoFollowParked` stays set so that if the user
            // manually scrolls to the tail to resume auto-follow,
            // subsequent tokens won't immediately kick them out again.
            if (!this.autoFollowParked && this.isLastMessageOversized()) {
                this.autoFollowParked = true;
                this.autoFollow = false;
                this.updateButtonVisibility();
                return;
            }
            this.programmaticScrollToBottom();
            this.updateButtonVisibility();
            return;
        }
        this.updateButtonVisibility();
    }

    /**
     * Returns true when the last message bubble is taller than the
     * viewport. Used to avoid forcing auto-scroll on every token of a
     * long streaming message — once the message fills the screen the
     * user should be able to read from the top without the view
     * constantly jumping to the tail.
     */
    private isLastMessageOversized(): boolean {
        const bubbles = this.messagesEl.querySelectorAll('.session-bubble');
        const lastBubble = bubbles[bubbles.length - 1];
        if (!lastBubble) return false;
        return lastBubble.getBoundingClientRect().height > this.messagesEl.clientHeight;
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

    /**
     * Single source of truth for scroll-to-bottom button visibility and
     * the unread-content indicator class.
     *
     * Shows the button whenever the view is not auto-following AND the
     * scroll position is not near the bottom. Adds the `--unread` class
     * (blinking border) when new streaming content is arriving at the
     * tail so the user knows fresh output is being generated.
     */
    private updateButtonVisibility(): void {
        const shouldShow = !this.autoFollow && !this.isNearBottom();
        const hasUnread = shouldShow && this.isStreamingProvider();

        if (shouldShow) {
            this.scrollToBottomBtn.show();
            this.scrollToBottomBtn.classList.toggle(
                'session-scroll-to-bottom-btn--unread',
                hasUnread,
            );
        } else {
            this.scrollToBottomBtn.hide();
            this.scrollToBottomBtn.classList.remove('session-scroll-to-bottom-btn--unread');
        }
    }

    private handleButtonClick(): void {
        this.autoFollow = true;
        this.updateButtonVisibility();
        this.programmaticScrollGuard++;
        this.messagesEl.scrollTo({
            top: this.messagesEl.scrollHeight,
            behavior: 'smooth',
        });
        // Smooth scroll dispatches many scroll events across its
        // animation; cover the window generously before allowing
        // user-gesture writes again. Tracked so detach() can cancel a
        // pending timer rather than let it fire against a torn-down view.
        if (this.buttonClickTimeout !== 0) window.clearTimeout(this.buttonClickTimeout);
        this.buttonClickTimeout = window.setTimeout(() => {
            this.buttonClickTimeout = 0;
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
        // Move the direction baseline to the new (downward) position now, so a
        // delayed coalesced scroll event for this write is never misread as an
        // upward user move regardless of guard timing.
        this.lastScrollTop = this.messagesEl.scrollTop;
        // Two RAFs cover iOS WebView's habit of coalescing the scroll
        // event for a programmatic write into the next frame.
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
            this.programmaticScrollGuard = Math.max(0, this.programmaticScrollGuard - 1);
        }));
    }

    private onMessagesScroll(): void {
        // Direction of this scroll relative to the previous one. Updated for
        // EVERY event (including guarded/programmatic ones) so the baseline
        // stays current; a programmatic scroll-to-bottom that bumped scrollTop
        // up therefore won't later read as an "upward" user move.
        const scrollTop = this.messagesEl.scrollTop;
        const movedUp = scrollTop < this.lastScrollTop - ScrollController.UP_MOVE_EPSILON_PX;
        this.lastScrollTop = scrollTop;

        // Programmatic scrolls never update intent. Short-circuit the
        // whole handler so the coalesced scroll event for our own
        // `scrollTop = scrollHeight` does not toggle the button to a
        // stale state either.
        if (this.programmaticScrollGuard > 0) return;

        // Scrollbar drag / inertial momentum move the view without a wheel or
        // touch event. Such no-gesture scrolling is the only thing this handler
        // is allowed to source intent from — and ONLY when it actually moves
        // UP and away from the tail (the user browsing history). Gating on
        // `movedUp` is what keeps programmatic follow (always downward) from
        // ever latching auto-follow off, even if its delayed scroll event
        // arrives after the guard window — auto-follow stays robust without
        // relying on guard timing alone.
        if (movedUp && !this.isNearBottom()) {
            this.autoFollow = false;
            this.autoFollowParked = true;
        }

        if (
            this.nearTopCallback
            && scrollTop < ScrollController.NEAR_TOP_THRESHOLD_PX
        ) {
            this.nearTopCallback();
        }

        this.updateButtonVisibility();
    }

    private onUserWheel(e: WheelEvent): void {
        if (e.deltaY < 0) {
            this.autoFollow = false;
            this.autoFollowParked = true;
            this.updateButtonVisibility();
        } else if (e.deltaY > 0) {
            // Only re-enable autoFollow when the user scrolls all the
            // way to the absolute bottom — not just "near" it.  Using
            // the generous isNearBottom() threshold here would cause
            // every tiny downward flick (trackpad momentum bounce,
            // mouse-wheel rebound) to latch autoFollow back on, pulling
            // the view away from where the user was reading.
            window.requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
                if (scrollHeight - scrollTop - clientHeight < 4) {
                    this.autoFollow = true;
                }
                this.updateButtonVisibility();
            });
        }
    }

    private onUserTouchMove(e: TouchEvent): void {
        const touch = e.touches[0];
        if (!touch) return;
        const deltaY = this.touchStartY - touch.clientY;
        this.touchAccumulatedDeltaY += deltaY;
        this.touchStartY = touch.clientY;

        // Immediately disable autoFollow on any upward drag — don't
        // wait for the accumulated threshold.  If we wait, streaming
        // content can fire a programmatic scroll (via the
        // MutationObserver → RAF → onAsyncContentChanged path) before
        // the threshold is met, yanking the view back to the tail and
        // effectively resetting the user's drag progress each frame.
        //
        // We still gate the *button* visibility on the accumulated
        // threshold so a fleeting upward jitter doesn't flash the
        // "scroll to bottom" button.
        if (deltaY > 0) {
            this.autoFollow = false;
            this.autoFollowParked = true;
        }

        if (this.touchAccumulatedDeltaY > ScrollController.TOUCH_GESTURE_THRESHOLD) {
            // autoFollow already disabled above; just show the button.
            this.updateButtonVisibility();
        } else if (this.touchAccumulatedDeltaY < -ScrollController.TOUCH_GESTURE_THRESHOLD) {
            window.requestAnimationFrame(() => {
                if (this.isNearBottom()) {
                    this.autoFollow = true;
                }
                this.updateButtonVisibility();
            });
        }
    }

    private onUserKey(e: KeyboardEvent): void {
        if (ScrollController.KEY_UP.has(e.key)) {
            this.autoFollow = false;
            this.autoFollowParked = true;
            this.updateButtonVisibility();
        } else if (ScrollController.KEY_DOWN.has(e.key)) {
            window.requestAnimationFrame(() => {
                if (this.isNearBottom()) {
                    this.autoFollow = true;
                }
                this.updateButtonVisibility();
            });
        }
    }
}
