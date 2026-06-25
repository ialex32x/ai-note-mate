import { setIcon } from 'obsidian';

/**
 * Owns the "pinned user prompt" bar that appears at the top of the
 * message area when the user scrolls past their original question.
 *
 * ## Behaviour
 *
 * Mirrors Cursor's prompt-pin UX:
 *
 * 1. On each scroll / DOM mutation, find the **first bubble** that is
 *    at least partially visible in the scroll viewport.
 * 2. Walk backward in the DOM from that bubble to find the nearest
 *    preceding user-message bubble (the one that started this turn).
 * 3. If that user bubble is **not fully visible** (its top has scrolled
 *    above the viewport) → show a compact pinned bar at the top
 *    displaying a truncated version of the user's prompt.
 * 4. If the user bubble IS fully visible → hide the pin.
 *
 * The pin bar is `position: absolute` inside `messagesWrapper`, so it
 * overlays the top of the scroll area without affecting layout.
 * Clicking the bar scrolls to the original user message.
 *
 * ## Lifecycle
 *
 * - {@link attach} registers scroll / mutation observers and creates
 *   the pin DOM element.
 * - {@link detach} tears everything down. Call from
 *   {@link SessionView.onClose}.
 * - {@link reset} clears state (call on session switch).
 */
export class PromptPinController {
    private pinEl: HTMLElement | null = null;
    private pinTextEl: HTMLElement | null = null;
    private pinnedMessageId: string | null = null;

    private pendingCheck = false;
    private mutationObserver: MutationObserver | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private scrollHandler: (() => void) | null = null;

    /** Max characters shown in the pinned bar before truncation. */
    private static readonly MAX_PIN_CHARS = 120;

    constructor(
        private readonly messagesWrapper: HTMLElement,
        private readonly messagesEl: HTMLElement,
        /**
         * Callback to scroll the view to a specific message by ID.
         * Late-bound — the history loader may not exist when this
         * controller is constructed in {@link buildMessageArea}.
         */
        private scrollToMessage: (messageId: string) => void,
    ) {}

    // ── Lifecycle ──────────────────────────────────────────────────────

    attach(): void {
        this.createPinElement();

        // Scroll listener — passive so it never blocks the compositor.
        this.scrollHandler = () => this.scheduleCheck();
        this.messagesEl.addEventListener('scroll', this.scrollHandler, { passive: true });

        // MutationObserver: catches appends, prepends, streaming re-renders,
        // and any other DOM change that could shift which bubbles are visible.
        if (typeof MutationObserver !== 'undefined') {
            this.mutationObserver = new MutationObserver(() => this.scheduleCheck());
            this.mutationObserver.observe(this.messagesEl, {
                childList: true,
                subtree: true,
                characterData: true,
            });
        }

        // ResizeObserver: catches container size changes (window resize,
        // mobile keyboard, sidebar toggle) so the pin state stays correct
        // even without an accompanying scroll event.
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => this.scheduleCheck());
            this.resizeObserver.observe(this.messagesWrapper);
        }
    }

    detach(): void {
        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.scrollHandler) {
            this.messagesEl.removeEventListener('scroll', this.scrollHandler);
            this.scrollHandler = null;
        }
        this.pinEl?.remove();
        this.pinEl = null;
        this.pinTextEl = null;
        this.pinnedMessageId = null;
        this.pendingCheck = false;
    }

    /** Reset pin state (call on session switch). */
    reset(): void {
        this.hidePin();
        this.pinnedMessageId = null;
    }

    // ── Internals ──────────────────────────────────────────────────────

    private createPinElement(): void {
        this.pinEl = this.messagesWrapper.createEl('div', {
            cls: 'session-prompt-pin session-prompt-pin--hidden',
        });

        // Icon
        const iconEl = this.pinEl.createEl('span', { cls: 'session-prompt-pin__icon' });
        setIcon(iconEl, 'message-square');

        // Text (truncated user prompt)
        this.pinTextEl = this.pinEl.createEl('span', { cls: 'session-prompt-pin__text' });

        // Click → scroll to original message
        this.pinEl.addEventListener('click', () => {
            if (this.pinnedMessageId) {
                this.scrollToMessage(this.pinnedMessageId);
            }
        });
    }

    /**
     * Coalesce rapid scroll / mutation events into a single check per
     * animation frame. Follows the same pattern as
     * {@link ScrollController.scheduleAsyncCheck}.
     */
    private scheduleCheck(): void {
        if (this.pendingCheck) return;
        this.pendingCheck = true;
        window.requestAnimationFrame(() => {
            this.pendingCheck = false;
            this.updatePinState();
        });
    }

    /**
     * Determine which (if any) user prompt should be pinned and
     * show/hide the pin bar accordingly.
     */
    private updatePinState(): void {
        const wrapperRect = this.messagesWrapper.getBoundingClientRect();
        const wrapperTop = wrapperRect.top;
        const wrapperBottom = wrapperRect.bottom;

        // ── 1. Find the first bubble partially visible in the viewport ──
        const allBubbles = this.messagesEl.querySelectorAll<HTMLElement>(
            '.session-bubble:not(.session-bubble--hidden)',
        );

        let firstVisible: HTMLElement | null = null;
        for (const bubble of Array.from(allBubbles)) {
            const rect = bubble.getBoundingClientRect();
            // At least partially visible: bottom is below wrapper top AND
            // top is above wrapper bottom.
            if (rect.bottom > wrapperTop && rect.top < wrapperBottom) {
                firstVisible = bubble;
                break;
            }
        }

        if (!firstVisible) {
            this.hidePin();
            return;
        }

        // ── 2. Walk backward to find the user message for this turn ──
        const userBubble = this.findTurnUserBubble(firstVisible);
        if (!userBubble) {
            this.hidePin();
            return;
        }

        // ── 3. Is the user message fully visible? ─────────────────────
        const userRect = userBubble.getBoundingClientRect();
        const fullyVisible =
            userRect.top >= wrapperTop - 1 && // -1 for sub-pixel tolerance
            userRect.bottom <= wrapperBottom + 1;

        if (fullyVisible) {
            this.hidePin();
            return;
        }

        // ── 4. Show pin ──────────────────────────────────────────────
        const messageId = this.extractMessageId(userBubble);
        // Guard: don't pin if the bubble lacks an ID (should not happen
        // in normal operation since every bubble gets data-message-id).
        if (!messageId) {
            this.hidePin();
            return;
        }

        const content = this.extractUserContent(userBubble);

        // Don't re-render if the same message is already pinned
        if (this.pinnedMessageId === messageId && this.pinEl && !this.pinEl.hasClass('session-prompt-pin--hidden')) {
            return;
        }

        this.showPin(messageId, content);
    }

    /**
     * Walk DOM siblings backward from `startEl` to find the nearest
     * `.session-bubble--user` element. Returns null if none found
     * (shouldn't happen in normal operation — every turn starts with
     * a user message).
     */
    private findTurnUserBubble(startEl: HTMLElement): HTMLElement | null {
        if (startEl.classList.contains('session-bubble--user')) {
            return startEl;
        }

        let el: Element | null = startEl.previousElementSibling;
        while (el) {
            if (el.classList.contains('session-bubble--user')) {
                return el as HTMLElement;
            }
            el = el.previousElementSibling;
        }

        return null;
    }

    /**
     * Extract the message ID from a bubble's data attribute.
     * Falls back to null if no ID is set.
     */
    private extractMessageId(bubble: HTMLElement): string | null {
        return bubble.getAttribute('data-message-id');
    }

    /**
     * Extract the user's prompt text from a bubble's content area.
     * Strips excess whitespace for compact display in the pin bar.
     */
    private extractUserContent(bubble: HTMLElement): string {
        const contentEl = bubble.querySelector('.session-bubble__content');
        const raw = contentEl?.textContent ?? '';
        // Collapse whitespace and trim
        const cleaned = raw.replace(/\s+/g, ' ').trim();
        if (cleaned.length <= PromptPinController.MAX_PIN_CHARS) {
            return cleaned;
        }
        return cleaned.slice(0, PromptPinController.MAX_PIN_CHARS) + '…';
    }

    private showPin(messageId: string, content: string): void {
        if (!this.pinEl || !this.pinTextEl) return;

        const wasHidden = this.pinEl.hasClass('session-prompt-pin--hidden');

        this.pinnedMessageId = messageId;

        this.pinTextEl.setText(content || '');

        this.pinEl.removeClass('session-prompt-pin--hidden');

        // Only animate the slide-in when transitioning from hidden to
        // visible. Content-only updates (different user message while
        // already pinned) skip the animation to avoid a flash/jump.
        if (wasHidden) {
            this.pinEl.classList.remove('session-prompt-pin--animate-in');
            // Force reflow so the browser registers the removal before
            // re-adding, restarting the CSS animation.
            void this.pinEl.offsetWidth;
            this.pinEl.classList.add('session-prompt-pin--animate-in');
        }
    }

    private hidePin(): void {
        if (!this.pinEl) return;
        this.pinEl.addClass('session-prompt-pin--hidden');
        this.pinnedMessageId = null;
    }
}
