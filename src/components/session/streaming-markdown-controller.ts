import { MarkdownRenderer, App, Component } from 'obsidian';
import { sanitizeStreamingMarkdown } from '../../utils/markdown-sanitizer';

/**
 * Default minimum interval (ms) between two consecutive renders.
 * Chosen to balance visual smoothness (~8-12 FPS) with performance.
 */
const DEFAULT_MIN_INTERVAL = 100;

/**
 * Controls the rendering of streaming markdown content with:
 * 1. **Throttling** — enforces a minimum interval between renders.
 * 2. **Async mutex** — prevents concurrent MarkdownRenderer.render() calls.
 * 3. **Markdown sanitization** — temporarily closes unclosed syntax elements
 *    during streaming so the renderer produces correct output.
 *
 * Usage:
 * - Call `update()` every time new content arrives (every SSE chunk).
 * - Call `finalize()` when streaming is complete — this renders the raw,
 *   un-sanitized content for a pixel-perfect final result.
 * - Call `dispose()` when the controller is no longer needed.
 */
export class StreamingMarkdownController {
    /** The most recent content received via update(). */
    private latestContent = '';

    /** The content that was last actually rendered. */
    private lastRenderedContent = '';

    /** The sanitized content that was last actually rendered. */
    private lastRenderedSanitized = '';

    /** Timestamp (ms) when the last render completed. */
    private lastRenderTime = 0;

    /** ID of the pending window.setTimeout, or null if none. */
    private pendingTimer: number | null = null;

    /** True while a MarkdownRenderer.render() call is in-flight. */
    private isRendering = false;

    /** Set to true once dispose() has been called. */
    private disposed = false;

    /** Resolve function for the rendering-complete promise (used by finalize). */
    private renderCompleteResolve: (() => void) | null = null;

    /** The target element for rendering. */
    private contentEl: HTMLElement | null = null;

    /** Callback invoked after each successful render (e.g. to attach context menus). */
    private onAfterRender: ((contentEl: HTMLElement) => void) | null = null;

    constructor(
        private readonly app: App,
        private readonly component: Component,
        private readonly minInterval: number = DEFAULT_MIN_INTERVAL
    ) {}

    /**
     * Register a callback that runs after each render completes.
     * Useful for attaching context menus, event listeners, etc.
     */
    setAfterRenderCallback(cb: (contentEl: HTMLElement) => void): void {
        this.onAfterRender = cb;
    }

    /**
     * Feed new streaming content.  The controller will schedule a throttled
     * render with markdown sanitization applied.
     */
    update(contentEl: HTMLElement, content: string): void {
        if (this.disposed) return;
        this.contentEl = contentEl;
        this.latestContent = content;
        // Skip rendering when content is empty (e.g. during thinking phase
        // before any answer content arrives).  This avoids unnecessary
        // contentEl.empty() calls that would destroy the streaming cursor.
        if (!content) return;
        this.scheduleRender();
    }

    /**
     * Perform the final render with the complete, un-sanitized content.
     * Waits for any in-flight render to finish first.
     */
    async finalize(contentEl: HTMLElement, content: string): Promise<void> {
        if (this.disposed) return;

        // Cancel any pending throttle timer
        this.clearPendingTimer();

        // Wait for in-flight render to complete
        if (this.isRendering) {
            await this.waitForRenderComplete();
        }

        // Final render — no sanitization, raw content
        contentEl.empty();
        await MarkdownRenderer.render(this.app, content, contentEl, '', this.component);
        this.onAfterRender?.(contentEl);

        this.latestContent = content;
        this.lastRenderedContent = content;
    }

    /**
     * Cancel any pending render and reset state.
     * Does NOT dispose the controller — it can be reused.
     */
    cancel(): void {
        this.clearPendingTimer();
        this.latestContent = '';
        this.lastRenderedContent = '';
        this.lastRenderedSanitized = '';
        this.lastRenderTime = 0;
        this.contentEl = null;
    }

    /**
     * Permanently dispose the controller.  Cancels pending timers and
     * marks the instance as unusable.
     */
    dispose(): void {
        this.disposed = true;
        this.clearPendingTimer();
        this.contentEl = null;
        this.onAfterRender = null;
        // If a render is in-flight, resolve the waiter so finalize() doesn't hang
        this.renderCompleteResolve?.();
        this.renderCompleteResolve = null;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private scheduleRender(): void {
        // If a render is in-flight, doRender() will self-check after completion
        if (this.isRendering) return;
        // If a timer is already pending, it will pick up the latest content
        if (this.pendingTimer !== null) return;

        const elapsed = Date.now() - this.lastRenderTime;
        if (elapsed >= this.minInterval) {
            // Enough time has passed — render immediately
            void this.doRender();
        } else {
            // Schedule a delayed render for the remaining interval
            this.pendingTimer = window.setTimeout(() => {
                this.pendingTimer = null;
                if (!this.disposed) {
                    void this.doRender();
                }
            }, this.minInterval - elapsed);
        }
    }

    private async doRender(): Promise<void> {
        if (this.disposed || !this.contentEl) return;

        this.isRendering = true;
        try {
            const contentToRender = this.latestContent;
            const sanitized = sanitizeStreamingMarkdown(contentToRender);

            // Skip rendering if the sanitized output is identical to what's
            // already on screen.  This avoids unnecessary DOM rebuilds that
            // cause table column-width recalculations and layout jumps.
            if (sanitized === this.lastRenderedSanitized) {
                this.lastRenderedContent = contentToRender;
                return;
            }

            // Double-buffer: render into an off-screen element first, then
            // swap children in one go to avoid the empty-state layout flash
            // that would occur with contentEl.empty() + async render().
            const buffer = createEl('div');
            await MarkdownRenderer.render(
                this.app,
                sanitized,
                buffer,
                '',
                this.component
            );

            // Swap: replace all children atomically to avoid intermediate
            // empty state that would trigger a layout reflow.
            if (!this.disposed && this.contentEl) {
                this.contentEl.replaceChildren(...Array.from(buffer.childNodes));
                this.onAfterRender?.(this.contentEl);
            }

            this.lastRenderedContent = contentToRender;
            this.lastRenderedSanitized = sanitized;
        } finally {
            this.isRendering = false;
            this.lastRenderTime = Date.now();

            // Notify any waiter (finalize) that the render is done
            this.renderCompleteResolve?.();
            this.renderCompleteResolve = null;
        }

        // Self-check: did new content arrive while we were rendering?
        if (!this.disposed && this.latestContent !== this.lastRenderedContent) {
            this.scheduleRender();
        }
    }

    /**
     * Returns a promise that resolves when the current in-flight render completes.
     */
    private waitForRenderComplete(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.renderCompleteResolve = resolve;
        });
    }

    private clearPendingTimer(): void {
        if (this.pendingTimer !== null) {
            window.clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
    }
}
