import { ChatMessage } from '../../services/chat-stream';
import { ScrollController } from './scroll-controller';
import { BubbleListController } from './bubble-list-controller';
import { MessageWindowController } from './message-window-controller';
import { SessionLoadingOverlay } from '../../components/session';
import { replayUnitsInFrames } from './history-replay-controller';
import { HISTORY_LOADING } from './history-loading-config';
import { isAbortError } from '../../utils/abortable-request';

export interface HistoryLoaderDeps {
    scroller: ScrollController;
    bubbleList: BubbleListController;
    messageWindow: MessageWindowController;
    historyLoadingOverlay: SessionLoadingOverlay;
    getHistoryReplaySignal: () => AbortSignal | undefined;
}

/**
 * Owns lazy history-window expansion (load-older + jump-to-message) and
 * the scroll/highlight bookkeeping that goes with it. All prepend
 * operations are serialized through {@link runHistoryMutation} so two
 * concurrent expansions can't scramble message order.
 */
export class HistoryLoader {
    private readonly deps: HistoryLoaderDeps;

    /**
     * Serializes history-prepend operations so {@link loadOlderMessages} and
     * {@link ensureMessageVisible} never interleave their `replayUnitsInFrames`
     * batches against a stale anchor / window bounds (which would scramble
     * message order). See {@link runHistoryMutation}.
     */
    private historyMutationChain: Promise<void> = Promise.resolve();

    constructor(deps: HistoryLoaderDeps) {
        this.deps = deps;
    }

    // ── Jump navigation ────────────────────────────────────────────────

    /**
     * Scroll to the user message that precedes the given message
     * (i.e. the user message that started the current turn).
     */
    handleJumpToPrevUser(msg: ChatMessage): void {
        this.jumpToUserMessage(this.deps.bubbleList.findPrevUserMessageId(msg));
    }

    /** Scroll to the next (following) user message (ID-based). */
    handleJumpToNextUser(msg: ChatMessage): void {
        this.jumpToUserMessage(this.deps.bubbleList.findNextUserMessageId(msg));
    }

    /** Returns true if the message has a previous user message in the data model. */
    canJumpToPrevUser(msg: ChatMessage): boolean {
        return this.deps.bubbleList.canJumpPrev(msg);
    }

    /** Returns true if the message has a next user message in the data model. */
    canJumpToNextUser(msg: ChatMessage): boolean {
        return this.deps.bubbleList.canJumpNext(msg);
    }

    /**
     * Single entry point for jump-to-user navigation. Always routes through
     * {@link ensureMessageVisible} so the rendered and not-yet-rendered cases
     * share one code path.
     */
    private jumpToUserMessage(targetId: string | null): void {
        if (!targetId) return;
        void this.jumpToMessageId(targetId);
    }

    /**
     * Unified "jump to a specific message by id" path shared by the
     * jump-to-prev/next-user buttons, checkpoint goto, and search-result
     * navigation. Routes through {@link ensureMessageVisible} which scrolls
     * to the target via {@link ScrollController.jumpScrollTo}.
     *
     * Auto-follow is suppressed up-front only as a TRANSIENT guard: a jump is
     * an explicit "leave the tail" gesture, so without this the
     * MutationObserver (during streaming) or the async history load could
     * re-pin to the bottom before the target lands. `jumpScrollTo` then makes
     * the authoritative decision from the landing position — resuming follow
     * when the target turns out to sit at the tail.
     */
    private jumpToMessageId(targetId: string): Promise<void> {
        this.deps.scroller.suppressAutoFollow();
        return this.ensureMessageVisible(targetId, targetId);
    }

    /**
     * Scroll to a message by id (checkpoint goto / search-result navigation).
     * Delegates to the unified {@link jumpToMessageId} path so it shares the
     * same guarded, landing-aware scroll + highlight as jump-to-user.
     */
    async scrollToMessage(messageId: string): Promise<void> {
        await this.jumpToMessageId(messageId);
    }

    // ── Window expansion ───────────────────────────────────────────────

    /**
     * Serialize a history-prepend operation. Each call waits for the previous
     * one to finish before running `work`, so {@link loadOlderMessages} and
     * {@link ensureMessageVisible} can't interleave their `replayUnitsInFrames`
     * batches against stale window bounds. The chain swallows errors internally
     * to stay alive; callers still observe their own rejection via the returned
     * promise.
     */
    private runHistoryMutation(work: () => Promise<void>): Promise<void> {
        const run = this.historyMutationChain.then(work, work);
        this.historyMutationChain = run.catch(() => { /* keep the chain alive */ });
        return run;
    }

    /**
     * Prepend older history bubbles above the current window, preserving
     * scroll position via a scrollHeight delta anchor.
     */
    async loadOlderMessages(): Promise<void> {
        if (this.deps.messageWindow.loadingOlder || !this.deps.messageWindow.hasOlderUnrendered()) {
            return;
        }

        this.deps.messageWindow.setLoadingOlder(true);
        try {
            await this.runHistoryMutation(async () => {
                // Re-check after acquiring the lock: an interleaved
                // ensureMessageVisible may have already rendered these units
                // while this load was queued behind it.
                if (!this.deps.messageWindow.hasOlderUnrendered()) return;

                const newStart = Math.max(0, this.deps.messageWindow.start - HISTORY_LOADING.olderBatchUnits);
                const units = this.deps.messageWindow.slice(newStart, this.deps.messageWindow.start);
                const anchor = this.deps.messageWindow.getPrependAnchor();
                const anchorOffset = anchor ? this.deps.scroller.captureAnchorScroll(anchor) : null;

                this.deps.scroller.beginHistoryPrepend();
                try {
                    // Chronological order: each prepend inserts before the same anchor,
                    // so later units stack after earlier ones (0, 1, …, anchor). Reversing
                    // would yield descending order and scramble the conversation.
                    await replayUnitsInFrames(units, {
                        appendUnit: (unit) => {
                            this.deps.bubbleList.prepend({ ...unit.msg, streaming: false }, anchor);
                        },
                        onProgress: () => { /* sentinel shows loading state */ },
                        signal: this.deps.getHistoryReplaySignal(),
                    });
                    this.deps.messageWindow.applyOlderBatch(newStart);
                    // Trim oldest rendered bubbles if the window grew past the limit
                    // BEFORE restoring the scroll anchor. trimTail removes DOM nodes
                    // from the top, which changes every remaining node's offsetTop.
                    // If we restore the scroll first and then trim, the anchor-based
                    // scroll position becomes stale — the viewport jumps because the
                    // anchor's offsetTop shrinks after trimming.
                    this.deps.messageWindow.maybeTrimTail();
                    if (anchor && anchor.isConnected && anchorOffset !== null) {
                        this.deps.scroller.restoreAnchorScroll(anchor, anchorOffset);
                    }
                } catch (err) {
                    if (!isAbortError(err)) {
                        throw err;
                    }
                } finally {
                    this.deps.scroller.endHistoryPrepend();
                }
            });
        } finally {
            this.deps.messageWindow.setLoadingOlder(false);
        }
    }

    /**
     * Expand the rendered window until `messageId` is in the DOM.
     *
     * @param messageId - The message whose display unit range must be loaded.
     * @param scrollToId - Optional: when provided, scroll to this specific
     *   bubble after loading instead of restoring the scroll anchor. Used
     *   for jump-to-message operations where the user explicitly navigates
     *   to a target; the anchor-restore path is for passive "load older"
     *   scrolling where the viewport should stay put.
     */
    private async ensureMessageVisible(messageId: string, scrollToId?: string): Promise<void> {
        await this.runHistoryMutation(async () => {
            const idx = this.deps.messageWindow.findUnitIndex(messageId);
            if (idx < 0 || idx >= this.deps.messageWindow.start) {
                // Already visible. If we still need to scroll, do it after a
                // double RAF so any in-flight layout from a concurrent load
                // (unlikely here, but defensive) has settled.
                if (scrollToId) {
                    this.scrollToBubbleSync(scrollToId);
                }
                return;
            }

            const units = this.deps.messageWindow.slice(idx, this.deps.messageWindow.start);
            // The prepend anchor is ALWAYS needed for correct DOM insertion
            // position (older messages go before the first rendered bubble).
            // When jumping we skip the scroll-anchor capture/restore because
            // we're going to scroll to the target after loading — preserving
            // the old viewport would create a visual "bounce".
            const isJump = !!scrollToId;
            const anchor = this.deps.messageWindow.getPrependAnchor();
            const anchorOffset = isJump ? null : (anchor ? this.deps.scroller.captureAnchorScroll(anchor) : null);
            const showOverlay = units.length >= HISTORY_LOADING.showOverlayMinUnits;

            if (showOverlay) {
                this.deps.historyLoadingOverlay.show(units.length);
            }

            this.deps.scroller.beginHistoryPrepend();
            try {
                await replayUnitsInFrames(units, {
                    appendUnit: (unit) => {
                        this.deps.bubbleList.prepend({ ...unit.msg, streaming: false }, anchor);
                    },
                    onProgress: (done, total) => {
                        if (showOverlay) {
                            this.deps.historyLoadingOverlay.setProgress(done, total);
                        }
                    },
                    signal: this.deps.getHistoryReplaySignal(),
                });
                this.deps.messageWindow.expandRenderedStart(idx);
                // Trim BEFORE any scroll, otherwise the anchor's / target's
                // offsetTop changes after the scroll position was set and the
                // viewport lands at a stale offset.
                this.deps.messageWindow.maybeTrimTail();
                this.deps.messageWindow.updateSentinel();
                if (isJump && scrollToId) {
                    // Jump mode: scroll to the target instead of restoring
                    // the anchor. Use a double RAF to let the browser flush
                    // layout after the bulk prepend + trim mutations before
                    // we read offsetTop and set scrollTop.
                    this.scheduleScrollToBubble(scrollToId);
                } else if (anchor && anchor.isConnected && anchorOffset !== null) {
                    this.deps.scroller.restoreAnchorScroll(anchor, anchorOffset);
                }
            } catch (err) {
                if (!isAbortError(err)) {
                    throw err;
                }
            } finally {
                if (showOverlay) {
                    this.deps.historyLoadingOverlay.hide();
                }
                this.deps.scroller.endHistoryPrepend();
            }
        });
    }

    /**
     * Schedule a scroll to a specific bubble after the next two animation
     * frames. Double RAF ensures the browser has finished layout for any
     * recently-inserted DOM nodes (e.g. from {@link replayUnitsInFrames})
     * before we read `offsetTop`.
     */
    private scheduleScrollToBubble(messageId: string): void {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                this.scrollToBubbleSync(messageId);
            });
        });
    }

    /**
     * Immediately scroll a bubble into view using synchronous `scrollTop`
     * and flash the highlight class.
     *
     * Uses `scrollTop` (not `scrollIntoView`) to avoid the async smooth-
     * scroll animation which can be interrupted by competing DOM mutations
     * or conflicting scroll operations (e.g. after a bulk history prepend).
     */
    private scrollToBubbleSync(messageId: string): void {
        const bubble = this.deps.bubbleList.messageBubbles.get(messageId);
        if (!bubble) return;
        // 80 px padding from the top so the bubble isn't flush against the
        // viewport edge and has some surrounding context visible. Routed
        // through the scroller so the scroll is guarded and auto-follow is
        // re-evaluated from the landing position (resume follow if the target
        // sits at the tail, otherwise park at it).
        this.deps.scroller.jumpScrollTo(bubble.offsetTop - 80);
        bubble.addClass('session-bubble--highlight');
        window.setTimeout(() => bubble.removeClass('session-bubble--highlight'), 2000);
    }
}
