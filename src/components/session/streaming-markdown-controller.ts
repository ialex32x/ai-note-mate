import { MarkdownRenderer, App, Component } from 'obsidian';
import {
    sanitizeStreamingMarkdown,
    normalizeMarkdownForObsidian,
    extractMermaidSources,
} from '../../utils/markdown-sanitizer';

/**
 * Default minimum interval (ms) between two consecutive renders.
 * Chosen to balance visual smoothness (~8-12 FPS) with performance.
 */
const DEFAULT_MIN_INTERVAL = 100;

/**
 * Content length (chars) above which streaming switches to a longer
 * render interval. Long markdown documents — especially those containing
 * tables, code blocks, or KaTeX — make each `MarkdownRenderer.render`
 * call disproportionately more expensive (Obsidian's renderer reparses
 * the whole document from scratch each time, not incrementally). At
 * 30 KB+ a single render can easily blow past the default 100 ms
 * throttle window on mid-range devices, leaving the main thread
 * saturated for the entire streaming phase and making the app feel
 * frozen. Stretching the throttle reclaims headroom for input events
 * and the rest of the UI without measurably hurting perceived
 * smoothness (the user is already reading a long answer).
 */
const LARGE_CONTENT_THRESHOLD = 30 * 1024;

/**
 * Render interval (ms) used when {@link LARGE_CONTENT_THRESHOLD} is
 * exceeded. 400 ms ≈ 2-3 FPS — still fast enough to feel like live
 * streaming, while leaving a comfortable margin for a single render
 * pass on heavy content.
 */
const LARGE_CONTENT_INTERVAL = 400;

/**
 * Minimum total time (ms) for a single doRender pass before a debug
 * log is emitted (sanitize + MarkdownRenderer.render combined). Below
 * this we stay silent — fast renders are uninteresting and would just
 * spam the console. 50 ms is half the default throttle window, i.e.
 * "starting to eat into the budget" territory; once renders exceed
 * that on every tick the UI will start to feel sluggish.
 */
const DORENDER_SLOW_LOG_THRESHOLD_MS = 50;

// ── Mermaid SVG preservation ───────────────────────────────────────────────

/**
 * A preserved mermaid SVG snapshot — the source code and a deep-cloned
 * copy of the rendered SVG DOM.  Used to transplant unchanged mermaid
 * diagrams across streaming render passes so their SVGs aren't torn down
 * and rebuilt on every tick (which causes visible flicker).
 */
interface PreservedMermaid {
    source: string;
    svgEl: SVGElement;
}

/**
 * Snapshot every closed mermaid block's rendered SVG from the live DOM.
 *
 * Uses `rawMarkdown` (the *previous* render's unsanitized content) to
 * extract source code for positional matching.  Only blocks that have a
 * closing fence and an actual rendered `<svg>` child are captured.
 */
function snapshotMermaidSvgs(container: HTMLElement, rawMarkdown: string): PreservedMermaid[] {
    const sources = extractMermaidSources(rawMarkdown);
    const mermaidEls = container.querySelectorAll('.mermaid');
    const result: PreservedMermaid[] = [];
    for (let i = 0; i < sources.length && i < mermaidEls.length; i++) {
        const svg = mermaidEls[i]!.querySelector('svg');
        if (svg) {
            result.push({
                source: sources[i]!,
                svgEl: svg.cloneNode(true) as SVGElement,
            });
        }
    }
    return result;
}

/**
 * Transplant unchanged mermaid SVGs from a previous render pass into the
 * freshly-rendered DOM.
 *
 * For each preserved entry, the new DOM must contain a mermaid block at
 * the same position with **identical source code**.  When matched, the
 * newly-rendered (expensive) SVG is replaced with the preserved one via
 * {@link ChildNode.replaceWith}.
 *
 * Blocks whose source changed (LLM edited them mid-stream) are left
 * alone so the renderer's fresh output is kept.
 */
function restoreMermaidSvgs(
    container: HTMLElement,
    rawMarkdown: string,
    preserved: PreservedMermaid[],
): void {
    const newSources = extractMermaidSources(rawMarkdown);
    const newMermaidEls = container.querySelectorAll('.mermaid');
    for (let i = 0; i < preserved.length && i < newSources.length && i < newMermaidEls.length; i++) {
        const entry = preserved[i]!;
        if (entry.source !== newSources[i]) continue;
        const newSvg = newMermaidEls[i]!.querySelector('svg');
        if (!newSvg) continue;
        newSvg.replaceWith(entry.svgEl.cloneNode(true));
    }
}

/**
 * Optional preprocessor applied to the raw content right before the
 * **final** render in {@link StreamingMarkdownController.finalize} (and
 * also exposed via {@link renderFinalMarkdown}). Lets callers strip
 * machine-only blocks (e.g. `<!--suggestions-->`) without coupling the
 * controller to feature-specific code.
 *
 * Intentionally *not* applied during streaming renders — the sanitizer
 * pipeline already keeps unclosed markup safe, and re-running a strip
 * pass on every throttled tick would just add cost.
 */
export type FinalContentPreprocessor = (content: string) => string;

/**
 * Render fully-formed markdown into `contentEl` using the obsidian
 * renderer, optionally stripping machine-only blocks first and firing
 * an after-render hook (e.g. to attach context menus).
 *
 * Shared between {@link StreamingMarkdownController.finalize} and
 * non-streaming history renders so both paths apply the same
 * preprocessing + post-render hooks. Keeping it as a free function
 * avoids forcing every caller through a controller instance for what
 * is essentially a one-shot render.
 */
export async function renderFinalMarkdown(
    app: App,
    component: Component,
    contentEl: HTMLElement,
    content: string,
    options: {
        preprocess?: FinalContentPreprocessor;
        afterRender?: (contentEl: HTMLElement) => void;
    } = {}
): Promise<void> {
    // 1. Normalize markdown for Obsidian compatibility (e.g. ensure blank
    //    lines around tables).  This runs unconditionally before any
    //    feature-specific preprocessing.
    let cleaned = normalizeMarkdownForObsidian(content);
    // 2. Optional feature-specific preprocessing (e.g. strip machine-only
    //    blocks like <!--suggestions-->).
    cleaned = options.preprocess ? options.preprocess(cleaned) : cleaned;
    contentEl.empty();
    await MarkdownRenderer.render(app, cleaned, contentEl, '', component);
    options.afterRender?.(contentEl);
}

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
 *
 * Lifecycle invariants:
 * - Once `finalize()` has been called, subsequent `update()` calls are
 *   ignored (the controller has already committed its terminal state).
 * - `dispose()` is permanent. `update()` and `finalize()` are no-ops
 *   afterwards.
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

    /**
     * True from the moment {@link finalize} starts until it resolves.
     * Streaming `update()` calls that arrive during this window are
     * silently ignored — finalize has already committed the terminal
     * content and any further mutation would race against its render.
     *
     * Stays true after finalize resolves so late updates remain no-ops
     * even before the host disposes the controller.
     */
    private finalizing = false;

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
     *
     * No-op once {@link finalize} has started or {@link dispose} has run —
     * see the class-level lifecycle invariants.
     */
    update(contentEl: HTMLElement, content: string): void {
        if (this.disposed || this.finalizing) return;
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
     *
     * @param contentEl - Target element (usually the same one passed to update())
     * @param content - The complete content to render
     * @param preprocess - Optional preprocessor applied before rendering;
     *   typically used to strip machine-only blocks like `<!--suggestions-->`.
     *   Streaming renders never run this — sanitization is enough mid-flight.
     */
    async finalize(
        contentEl: HTMLElement,
        content: string,
        preprocess?: FinalContentPreprocessor
    ): Promise<void> {
        if (this.disposed) return;

        // Lock out any racing update() calls before we await — once finalize
        // is in flight the terminal content is committed.
        this.finalizing = true;

        // Cancel any pending throttle timer
        this.clearPendingTimer();

        // Wait for in-flight render to complete
        if (this.isRendering) {
            await this.waitForRenderComplete();
        }

        // Final render — no streaming sanitization, optional preprocess pass.
        await renderFinalMarkdown(this.app, this.component, contentEl, content, {
            preprocess,
            afterRender: this.onAfterRender ?? undefined,
        });

        this.latestContent = content;
        this.lastRenderedContent = content;
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

        const interval = this.effectiveInterval();
        const elapsed = Date.now() - this.lastRenderTime;
        if (elapsed >= interval) {
            // Enough time has passed — render immediately
            void this.doRender();
        } else {
            // Schedule a delayed render for the remaining interval
            this.pendingTimer = window.setTimeout(() => {
                this.pendingTimer = null;
                if (!this.disposed) {
                    void this.doRender();
                }
            }, interval - elapsed);
        }
    }

    /**
     * Effective render throttle for the current content size. Returns
     * the configured base interval for small content, but stretches to
     * {@link LARGE_CONTENT_INTERVAL} once {@link LARGE_CONTENT_THRESHOLD}
     * is exceeded. Recomputed on every {@link scheduleRender} call so
     * a streaming response that grows past the threshold mid-flight
     * picks up the longer interval on the very next tick.
     *
     * The `Math.max` guard is defensive: a caller that explicitly set
     * a large `minInterval` (e.g. tests, future tuning) must not be
     * shortened by the large-content branch.
     */
    private effectiveInterval(): number {
        if (this.latestContent.length > LARGE_CONTENT_THRESHOLD) {
            return Math.max(this.minInterval, LARGE_CONTENT_INTERVAL);
        }
        return this.minInterval;
    }

    private async doRender(): Promise<void> {
        if (this.disposed || !this.contentEl) return;

        this.isRendering = true;
        // Timing instrumentation: track sanitize + render separately so
        // a slow log line can attribute the cost. Both default to 0 so
        // an early "duplicate output" return still produces a coherent
        // (zero-ish) log when total time happens to exceed the bar.
        const passStart = performance.now();
        let sanitizeMs = 0;
        let renderMs = 0;
        let skippedDuplicate = false;
        try {
            const contentToRender = this.latestContent;
            const sanitizeStart = performance.now();
            const sanitized = sanitizeStreamingMarkdown(contentToRender);
            sanitizeMs = performance.now() - sanitizeStart;

            // Skip rendering if the sanitized output is identical to what's
            // already on screen.  This avoids unnecessary DOM rebuilds that
            // cause table column-width recalculations and layout jumps.
            if (sanitized === this.lastRenderedSanitized) {
                this.lastRenderedContent = contentToRender;
                skippedDuplicate = true;
                return;
            }

            // Snapshot mermaid SVGs from the live DOM *before* we blow it
            // away with replaceChildren.  These are keyed by the previous
            // render's raw content so we can later check source equality.
            const preservedMermaids = this.lastRenderedContent
                ? snapshotMermaidSvgs(this.contentEl, this.lastRenderedContent)
                : [];

            // Double-buffer: render into an off-screen element first, then
            // swap children in one go to avoid the empty-state layout flash
            // that would occur with contentEl.empty() + async render().
            const buffer = createDiv();
            const renderStart = performance.now();
            await MarkdownRenderer.render(
                this.app,
                sanitized,
                buffer,
                '',
                this.component
            );
            renderMs = performance.now() - renderStart;

            // Swap: replace all children atomically to avoid intermediate
            // empty state that would trigger a layout reflow.
            if (!this.disposed && this.contentEl) {
                this.contentEl.replaceChildren(...Array.from(buffer.childNodes));

                // Transplant unchanged mermaid SVGs from the previous pass
                // so their expensive SVG render isn't repeated every tick.
                // This eliminates the flicker caused by tearing down and
                // rebuilding mermaid diagrams on each streaming update.
                if (preservedMermaids.length > 0) {
                    restoreMermaidSvgs(this.contentEl, contentToRender, preservedMermaids);
                }

                this.onAfterRender?.(this.contentEl);
            }

            this.lastRenderedContent = contentToRender;
            this.lastRenderedSanitized = sanitized;
        } finally {
            this.isRendering = false;
            this.lastRenderTime = Date.now();

            // Slow-render telemetry. Logs only when a single pass
            // exceeds the budget so the console isn't polluted by
            // fast (<50 ms) renders. Fields are deliberately compact
            // so a noisy streaming session is still grep-able:
            //   content: current latest length (chars), NOT the
            //     rendered slice — handy for spotting "we're well
            //     past the LARGE_CONTENT_THRESHOLD and renders are
            //     still expensive".
            //   sanitize / render / total: per-phase ms.
            //   skipped: duplicate-output early-return path (render
            //     phase didn't run; total ≈ sanitize).
            const totalMs = performance.now() - passStart;
            if (totalMs >= DORENDER_SLOW_LOG_THRESHOLD_MS) {
                console.debug(
                    `[StreamingMarkdownController] slow render: ` +
                    `content=${this.latestContent.length} chars, ` +
                    `sanitize=${sanitizeMs.toFixed(1)}ms, ` +
                    `render=${renderMs.toFixed(1)}ms, ` +
                    `total=${totalMs.toFixed(1)}ms` +
                    (skippedDuplicate ? ' (skipped: duplicate)' : ''),
                );
            }

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
