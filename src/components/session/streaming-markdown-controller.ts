import { MarkdownRenderer, App, Component } from 'obsidian';
import {
    sanitizeStreamingMarkdown,
    normalizeMarkdownForObsidian,
    substituteMermaidSvgs,
    mermaidSourceKey,
} from '../../utils/markdown-sanitizer';
import { logger } from '../../utils/logger';

const log = logger("[StreamingMarkdown]");

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

// ── Mermaid SVG pre-rendering ─────────────────────────────────────────────────

/**
 * Max time (ms) to wait for Obsidian's built-in mermaid post-processor to
 * finish rendering an SVG into a pre-render host.  Real renders finish well
 * under 100 ms even on slow machines; this bound just prevents us from
 * hanging forever if mermaid silently fails (e.g. malformed source that
 * neither errors nor produces a diagram).
 */
const MERMAID_PRERENDER_TIMEOUT_MS = 3000;

/**
 * Render a mermaid diagram source string to a cloned SVG **DOM node** by
 * running it through Obsidian's full MarkdownRenderer pipeline (the exact
 * same path used for the final, post-streaming render).  Returns null if
 * rendering fails or times out.
 *
 * We deliberately do NOT call `window.mermaid.render()` directly — that
 * bypasses Obsidian's mermaid post-processor, which applies its own theme
 * configuration and container structure.  The resulting SVG then looks
 * subtly different from what Obsidian produces natively, causing a visible
 * style flip when streaming ends and Obsidian re-renders the block.
 *
 * We also return a cloned DOM node rather than a serialized string: mermaid
 * flowchart labels live inside `<foreignObject>` as HTML, and serializing the
 * SVG then re-parsing it as HTML loses those labels (Obsidian's HTML sanitizer
 * strips foreignObject contents), producing diagrams with empty shapes.
 * Cloning the live node keeps everything intact.
 *
 * We render a synthetic markdown snippet (` ```mermaid\n...\n``` `) into an
 * off-screen host attached to `activeDocument.body` — deliberately OUTSIDE the
 * message list subtree.  Rendering scratch content inside the bubble's
 * `contentEl` would pollute the live DOM that other controllers watch
 * (scroll-follow and prompt-pin MutationObservers on `messagesEl`, and
 * `attachMermaidPreviewHandler`'s `.mermaid` query), causing scroll jitter,
 * source/diagram misalignment, and duplicate mermaid processing.  The host in
 * `body` is fully isolated.  Diagram colors are unaffected: they come from the
 * external `.mermaid` theme CSS applied when the cloned node is injected into
 * the bubble, not from where the SVG was generated.
 *
 * We wait for Obsidian's async post-processor to inject the `<svg>` element via
 * a MutationObserver (no polling), then clone it before removing the host.
 */
async function renderMermaidToSvg(
    app: App,
    component: Component,
    source: string,
): Promise<SVGElement | null> {
    // Attach the scratch host OUTSIDE the message subtree so it can't trigger
    // the observers/queries that operate on the live conversation DOM.
    const host = activeDocument.body.createDiv({ cls: 'mermaid-prerender-host' });
    try {
        // Kick off the full Obsidian markdown render (same code path as the
        // final render).  This creates a `.mermaid` container inside `host`
        // and asynchronously hands it to Obsidian's mermaid post-processor.
        await MarkdownRenderer.render(
            app,
            '```mermaid\n' + source + '\n```',
            host,
            '',
            component,
        );

        // Wait for the mermaid post-processor to inject an <svg> element.
        const svgEl = await waitForMermaidSvg(host, MERMAID_PRERENDER_TIMEOUT_MS);
        if (!svgEl) return null;

        // Clone before the host is removed so the node survives detachment.
        return svgEl.cloneNode(true) as SVGElement;
    } catch (err) {
        log.debug('[StreamingMarkdownController] mermaid pre-render failed:', err);
        return null;
    } finally {
        host.remove();
    }
}

/**
 * Resolve with the first `<svg>` element that appears inside a `.mermaid`
 * container under `host`, or null on timeout / render error.  Uses a
 * MutationObserver so we neither busy-wait nor over-delay past the moment the
 * SVG is ready.
 *
 * When mermaid fails to parse, Obsidian injects an error node (a `<pre>` with
 * the parse error, and/or marks the container) instead of an `<svg>`.  We
 * detect that and fail fast rather than waiting the full timeout.
 */
function waitForMermaidSvg(
    host: HTMLElement,
    timeoutMs: number,
): Promise<SVGElement | null> {
    const probe = (): SVGElement | null | undefined => {
        const svg = host.querySelector('.mermaid svg');
        if (svg) return svg as SVGElement;
        // Mermaid parse error → Obsidian renders a <pre> error block. Treat as
        // failure (undefined = keep waiting, null = fail fast).
        if (host.querySelector('pre')) return null;
        return undefined;
    };

    // Fast path: SVG (or error) may already be present.
    const immediate = probe();
    if (immediate !== undefined) return Promise.resolve(immediate);

    return new Promise<SVGElement | null>((resolve) => {
        let done = false;
        const finish = (result: SVGElement | null) => {
            if (done) return;
            done = true;
            observer.disconnect();
            window.clearTimeout(timer);
            resolve(result);
        };
        const observer = new MutationObserver(() => {
            const r = probe();
            if (r !== undefined) finish(r);
        });
        observer.observe(host, { childList: true, subtree: true });
        const timer = window.setTimeout(() => finish(null), timeoutMs);
    });
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
 * 4. **Mermaid pre-rendering** — complete mermaid blocks are rendered to SVG
 *    strings via `window.mermaid.render()` and cached.  Subsequent render
 *    passes substitute the cached SVG directly into the markdown as inline
 *    HTML, bypassing Obsidian's async mermaid post-processor entirely and
 *    eliminating the source-code↔diagram flicker.
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

    /** The sanitized+substituted content that was last actually rendered. */
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

    /**
     * Cache of pre-rendered mermaid SVG DOM nodes keyed by
     * {@link mermaidSourceKey}(source).  Populated lazily as complete mermaid
     * blocks appear during streaming.  Values are cloned on injection so the
     * cached node is never mutated.  Entries are never evicted — a streaming
     * session is short-lived and the controller itself is disposed after
     * finalize().
     */
    private mermaidSvgCache = new Map<string, SVGElement>();

    /**
     * Set of mermaid source keys currently being rendered asynchronously.
     * Prevents duplicate concurrent render() calls for the same diagram.
     */
    private mermaidRendering = new Set<string>();

    /**
     * Keys of mermaid sources whose pre-render failed or timed out (e.g.
     * malformed syntax).  We never retry these — they stay as raw ```mermaid
     * fences and Obsidian renders them (showing its own error message) both
     * during streaming and at finalize.  Without this guard a permanently
     * invalid diagram would be re-attempted on every render tick.
     */
    private mermaidFailed = new Set<string>();

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
        this.mermaidSvgCache.clear();
        this.mermaidRendering.clear();
        this.mermaidFailed.clear();
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

    /**
     * Fire-and-forget: start async mermaid pre-renders for any `pending`
     * source strings that are not already in-flight.  When each render
     * completes the result is stored in {@link mermaidSvgCache} and a new
     * render pass is scheduled so the diagram appears as soon as the SVG
     * is available.
     */
    private kickMermaidRenders(pending: string[]): void {
        for (const source of pending) {
            const key = mermaidSourceKey(source);
            if (this.mermaidSvgCache.has(key)) continue;
            if (this.mermaidRendering.has(key)) continue;
            if (this.mermaidFailed.has(key)) continue;
            this.mermaidRendering.add(key);
            void renderMermaidToSvg(this.app, this.component, source).then((svg) => {
                this.mermaidRendering.delete(key);
                if (this.disposed) return;
                if (svg) {
                    this.mermaidSvgCache.set(key, svg);
                    // Trigger a new render pass so the diagram is injected
                    // into the bubble immediately.
                    this.scheduleRender();
                } else {
                    // Pre-render failed or timed out (e.g. malformed syntax).
                    // Mark as failed so we don't retry every tick; the raw
                    // fence stays and Obsidian renders it (with its own error
                    // message) during streaming and at finalize.
                    this.mermaidFailed.add(key);
                }
            });
        }
    }

    /**
     * Fill every mermaid placeholder in `container` with a clone of its cached
     * SVG node.  Placeholders are the empty `<div class="mermaid"
     * data-mermaid-key="…">` elements produced by
     * {@link substituteMermaidSvgs}.  Cloning keeps the cached node pristine so
     * it can be reused across render passes.
     */
    private injectCachedMermaids(container: HTMLElement): void {
        const placeholders = container.querySelectorAll<HTMLElement>(
            '.mermaid[data-mermaid-key]',
        );
        placeholders.forEach((el) => {
            const key = el.dataset.mermaidKey;
            if (!key) return;
            const svg = this.mermaidSvgCache.get(key);
            if (!svg) return;
            el.appendChild(svg.cloneNode(true));
        });
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

            // Step 1: sanitize (strips unclosed mermaid/dataview, closes open
            // fences, etc.).  Complete mermaid blocks are kept intact at this
            // point so substituteMermaidSvgs can find them in step 2.
            const sanitized = sanitizeStreamingMarkdown(contentToRender);

            // Step 2: replace complete mermaid blocks whose SVG is already
            // cached with empty placeholders (tagged with a source key).
            // pending[] holds sources that are not yet cached — we kick off
            // their async renders below so they'll be ready by the next tick.
            const { result: sanitizedWithSvg, pending } = substituteMermaidSvgs(
                sanitized,
                new Set(this.mermaidSvgCache.keys()),
            );
            sanitizeMs = performance.now() - sanitizeStart;

            // Kick off async pre-renders for any mermaid blocks we haven't
            // seen before.  The renders run concurrently with the current DOM
            // update and will schedule a follow-up render pass when done.
            if (pending.length > 0) {
                this.kickMermaidRenders(pending);
            }

            // Skip rendering if the output (including SVG substitutions) is
            // identical to what's already on screen.  This avoids unnecessary
            // DOM rebuilds that cause table column-width recalculations and
            // layout jumps.
            if (sanitizedWithSvg === this.lastRenderedSanitized) {
                this.lastRenderedContent = contentToRender;
                skippedDuplicate = true;
                return;
            }

            // Double-buffer: render into an off-screen element first, then
            // swap children in one go to avoid the empty-state layout flash
            // that would occur with contentEl.empty() + async render().
            const buffer = createDiv();
            const renderStart = performance.now();
            await MarkdownRenderer.render(
                this.app,
                sanitizedWithSvg,
                buffer,
                '',
                this.component
            );
            renderMs = performance.now() - renderStart;

            // Inject cached mermaid SVG DOM nodes into their placeholders
            // *before* swapping into the live DOM, so the diagram appears
            // fully-formed with no empty-shape flash.
            this.injectCachedMermaids(buffer);

            // Swap: replace all children atomically to avoid intermediate
            // empty state that would trigger a layout reflow.
            if (!this.disposed && this.contentEl) {
                this.contentEl.replaceChildren(...Array.from(buffer.childNodes));
                this.onAfterRender?.(this.contentEl);
            }

            this.lastRenderedContent = contentToRender;
            this.lastRenderedSanitized = sanitizedWithSvg;
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
                log.debug(
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
