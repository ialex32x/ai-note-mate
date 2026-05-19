import { setTooltip } from "obsidian";

/**
 * Extra vertical breathing room between the anchor nav bar's bottom edge
 * and the aligned section's top border, in pixels. Mirrors the LESS
 * variable `@spacing-xl` (the same gap used between consecutive sections)
 * so the visual rhythm from "nav → first section" matches "section →
 * next section". Keep this in sync if `@spacing-xl` is ever changed.
 */
const NAV_SECTION_GAP = 24;

/**
 * Walks up the DOM tree from `start` to find the nearest ancestor that acts
 * as the true scroll container (`overflow-y: auto` or `scroll`). This
 * bridges the desktop/mobile gap:
 *
 * - On desktop, `PluginSettingTab.containerEl` (`.vertical-tab-content`) is
 *   itself the scroll container — the function returns it immediately.
 * - On mobile, Obsidian places the settings inside a modal where the actual
 *   scroll container is an ancestor of `containerEl` (typically
 *   `.modal-content`). Walking upward finds that ancestor.
 *
 * Falls back to `start` itself when no scrollable ancestor is found.
 */
function findScrollContainer(start: HTMLElement): HTMLElement {
	let current: HTMLElement | null = start;
	while (current && current !== activeDocument.documentElement) {
		const style = window.getComputedStyle(current);
		const overflowY = style.overflowY;
		if (overflowY === "auto" || overflowY === "scroll") {
			return current;
		}
		current = current.parentElement;
	}
	return start;
}

/**
 * One anchor entry corresponding to a settings section.
 */
export interface AnchorNavItem {
	/** Stable id (usually the section's `titleKey`). */
	id: string;
	/** Already-localized display name. */
	title: string;
	/** The outer section element (contains the header + body). */
	bodyEl: HTMLElement;
}

export interface AnchorNavOptions {
	/** Scrollable container that holds all sections. */
	scrollContainer: HTMLElement;
	/** Section list; order defines the anchor order. */
	items: AnchorNavItem[];
	/**
	 * Optional hook invoked before scrolling to a section. Reserved for the
	 * future collapsible-section feature — if the target is collapsed, the
	 * host can expand it inside this callback. Must complete synchronously
	 * (DOM layout is read immediately after it returns).
	 */
	ensureVisible?: (id: string) => void;
}

/**
 * A sticky, evenly-distributed dot-anchor navigation bar for the plugin
 * settings tab. Each section gets one equally sized segment along a single
 * horizontal line. Labels are always visible (faint by default, accent when
 * active, text-primary on hover). The section currently occupying the
 * largest portion of the viewport is marked active. Clicking a dot (or
 * pressing Enter/Space on a focused one) smoothly scrolls to the section.
 *
 * The component is self-contained: it creates its own DOM, manages its own
 * observers, and is torn down via {@link destroy}.
 */
export class SectionAnchorNav {
	private readonly hostEl: HTMLElement;
	private readonly barEl: HTMLElement;
	private readonly items: AnchorNavItem[];
	private readonly options: AnchorNavOptions;

	/**
	 * The actual scroll container — detected by walking up from
	 * `options.scrollContainer`. On desktop this is the same element as
	 * `containerEl`; on mobile it is an ancestor (e.g. `.modal-content`).
	 * All scroll-related operations (IntersectionObserver root, scroll
	 * events, geometry queries) use this element so they work correctly
	 * on both platforms.
	 */
	private readonly scroller: HTMLElement;

	private readonly itemEls = new Map<string, HTMLElement>();
	private readonly itemLabels = new Map<string, HTMLSpanElement>();
	private readonly visibleRatios = new Map<string, number>();

	private activeId: string | null = null;
	private intersectionObserver: IntersectionObserver | null = null;
	private resizeObserver: ResizeObserver | null = null;
	/**
	 * Invisible block appended to the end of the scroll container. Its
	 * height is tuned so that every section (including very short trailing
	 * ones) can have its top scrolled to the reference line. Without it,
	 * the last section would often sit mid-viewport after a header-aligned
	 * scroll, making it impossible for the "top crossed the ref line"
	 * highlight rule to select it.
	 */
	private bottomSpacerEl: HTMLElement | null = null;
	private readonly onScroll = () => this.updateActiveFromRatios();

	constructor(container: HTMLElement, options: AnchorNavOptions) {
		this.hostEl = container;
		this.options = options;
		this.items = options.items.slice();

		this.hostEl.addClass("oap-settings-anchor-host");
		this.barEl = this.hostEl.createDiv({ cls: "oap-settings-anchor-bar" });

		// Detect the real scroll container (handles mobile vs desktop).
		this.scroller = findScrollContainer(this.options.scrollContainer);

		this.buildItems();
		this.installBottomSpacer();
		this.setupIntersectionObserver();
		this.setupResizeObserver();
		// Supplementary trigger: rely on scroll events too, because the
		// IntersectionObserver may not fire during tiny scroll deltas that
		// still cross the reference line for one of the sections.
		this.scroller.addEventListener("scroll", this.onScroll, {
			passive: true,
		});

		// Compute an initial active anchor without waiting for the first
		// IntersectionObserver callback (which can lag on first paint).
		queueMicrotask(() => {
			this.updateBottomSpacerHeight();
			this.computeInitialActive();
		});
	}

	/** Release observers and detach listeners. Safe to call multiple times. */
	destroy(): void {
		this.intersectionObserver?.disconnect();
		this.intersectionObserver = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.scroller.removeEventListener("scroll", this.onScroll);
		this.bottomSpacerEl?.remove();
		this.bottomSpacerEl = null;
		this.itemEls.clear();
		this.itemLabels.clear();
		this.visibleRatios.clear();
		this.hostEl.empty();
		this.hostEl.removeClass("oap-settings-anchor-host");
	}

	// ─────────────────────────────────────────────────────────────────────
	// Private — construction
	// ─────────────────────────────────────────────────────────────────────

	private buildItems(): void {
		for (const item of this.items) {
			// Use a <div> instead of <button> to avoid any default button
			// chrome (Obsidian's global styles, browser defaults). We restore
			// accessibility manually via role + tabindex + keyboard handler.
			const el = this.barEl.createDiv({ cls: "oap-settings-anchor-item" });
			el.setAttr("role", "button");
			el.setAttr("tabindex", "0");
			el.setAttr("aria-label", item.title);
			setTooltip(el, item.title);

			el.createSpan({ cls: "oap-settings-anchor-dot" });
			const label = el.createSpan({
				cls: "oap-settings-anchor-label",
				text: item.title,
			});

			el.addEventListener("click", () => this.scrollToItem(item.id));
			el.addEventListener("keydown", (evt) => {
				if (evt.key === "Enter" || evt.key === " ") {
					evt.preventDefault();
					this.scrollToItem(item.id);
				}
			});

			this.itemEls.set(item.id, el);
			this.itemLabels.set(item.id, label);
			this.visibleRatios.set(item.id, 0);
		}
	}

	private setupIntersectionObserver(): void {
		// Multiple thresholds give us a smooth `intersectionRatio` signal so
		// that whichever section is "most visible" can win the active slot.
		const thresholds: number[] = [];
		for (let i = 0; i <= 10; i++) thresholds.push(i / 10);

		this.intersectionObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const id = this.findIdByElement(entry.target as HTMLElement);
					if (!id) continue;
					this.visibleRatios.set(
						id,
						entry.isIntersecting ? entry.intersectionRatio : 0
					);
				}
				this.updateActiveFromRatios();
			},
			{
				root: this.scroller,
				threshold: thresholds,
			}
		);

		for (const item of this.items) {
			this.intersectionObserver.observe(item.bodyEl);
		}
	}

	// ─────────────────────────────────────────────────────────────────────
	// Private — state updates
	// ─────────────────────────────────────────────────────────────────────

	private computeInitialActive(): void {
		// Pick the section whose top is closest to (but not past) the
		// viewport top — a reasonable default before IO fires.
		const root = this.scroller.getBoundingClientRect();
		let bestId: string | null = null;
		let bestScore = Number.POSITIVE_INFINITY;
		for (const item of this.items) {
			const r = item.bodyEl.getBoundingClientRect();
			// Distance of the section's top from the container's top; prefer
			// sections already visible (top <= container top + small epsilon).
			const dist = Math.abs(r.top - root.top);
			if (dist < bestScore) {
				bestScore = dist;
				bestId = item.id;
			}
		}
		if (bestId) this.setActive(bestId);
	}

	private updateActiveFromRatios(): void {
		// Bail out early if no section is intersecting at all — keep the
		// previous active so we don't flicker back to null during fast
		// scrolls where the IO momentarily reports ratio=0 for everyone.
		let anyVisible = false;
		for (const item of this.items) {
			if ((this.visibleRatios.get(item.id) ?? 0) > 0) {
				anyVisible = true;
				break;
			}
		}
		if (!anyVisible) return;

		const scroller = this.scroller;

		// Highlight the section whose top has passed the reference line.
		// The reference line is the scroll container's top plus the sticky
		// nav bar's own height — i.e. exactly where clicked sections land
		// after smooth-scroll. A tiny tolerance absorbs sub-pixel rounding
		// so a just-clicked section highlights immediately on arrival
		// instead of waiting until the next scroll tick.
		//
		// The bottom spacer guarantees that every section (including a
		// very short last one) can have its top scrolled above this line,
		// so there is no need for a separate "near bottom" special case.
		const TOP_TOL = 1;
		const rootRect = scroller.getBoundingClientRect();
		const refLine = rootRect.top + this.getStickyOffset();

		let crossedId: string | null = null;
		let nearestId: string | null = null;
		let nearestDist = Number.POSITIVE_INFINITY;
		for (const item of this.items) {
			const top = item.bodyEl.getBoundingClientRect().top;
			if (top <= refLine + TOP_TOL) {
				// Items are iterated in DOM order, so the last one to pass
				// this branch is the deepest one already scrolled past the
				// reference line — exactly what we want.
				crossedId = item.id;
			}
			const dist = Math.abs(top - refLine);
			if (dist < nearestDist) {
				nearestDist = dist;
				nearestId = item.id;
			}
		}

		// Fallback: container is parked above the first section (possible
		// if there is padding/spacing before it). Highlight the section
		// whose top is closest to the reference line so there's always a
		// sensible active indicator.
		const bestId = crossedId ?? nearestId;
		if (bestId && bestId !== this.activeId) this.setActive(bestId);
	}

	private setActive(id: string): void {
		if (this.activeId === id) return;
		if (this.activeId) {
			this.itemEls.get(this.activeId)?.removeClass(
				"oap-settings-anchor-item--active"
			);
		}
		this.activeId = id;
		this.itemEls.get(id)?.addClass("oap-settings-anchor-item--active");
	}

	// ─────────────────────────────────────────────────────────────────────
	// Public — interactions
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Smoothly scroll to the section with the given anchor id. Exposed
	 * so external entry points (e.g. the onboarding tips popover) can
	 * deep-link into a specific section without duplicating the
	 * sticky-nav-aware scroll math.
	 *
	 * No-op when the id doesn't match any registered section.
	 */
	scrollToItem(id: string): void {
		const item = this.items.find((x) => x.id === id);
		if (!item) return;

		// Let the host expand the section first if it is collapsed (reserved
		// for the upcoming collapsible-section feature).
		this.options.ensureVisible?.(id);

		const scroller = this.scroller;

		// Every section — including the last one — is scrolled so its top
		// lands just below the sticky anchor bar. The bottom spacer makes
		// this possible even for very short trailing sections, so no
		// per-item special case is needed anymore.
		const scrollerRect = scroller.getBoundingClientRect();
		const targetRect = item.bodyEl.getBoundingClientRect();
		const stickyOffset = this.getStickyOffset();
		const delta = targetRect.top - scrollerRect.top - stickyOffset;
		scroller.scrollBy({ top: delta, left: 0, behavior: "smooth" });

		// Deliberately do NOT mark the clicked item active here. Doing so
		// would flash its accent color before the scroll actually reaches
		// the target section. We leave the active highlight entirely to
		// the IntersectionObserver, so the accent color follows the real
		// scroll position.
	}

	private findIdByElement(el: HTMLElement): string | null {
		for (const item of this.items) {
			if (item.bodyEl === el) return item.id;
		}
		return null;
	}

	// ─────────────────────────────────────────────────────────────────────
	// Private — bottom spacer
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Append an invisible block at the very end of the scroll container.
	 * Its height is computed in {@link updateBottomSpacerHeight}. We do
	 * NOT give it a background, border or content so it is visually
	 * neutral — the only thing visible to the user is the empty area
	 * beneath the last section when scrolled to the bottom, which is the
	 * unavoidable cost of being able to align the last section's top to
	 * the sticky nav's baseline.
	 */
	private installBottomSpacer(): void {
		const el = this.scroller.createDiv({ cls: "oap-settings-anchor-spacer" });
		// Force append to the end even if createDiv already did so, to be
		// explicit about ordering requirements.
		this.scroller.appendChild(el);
		this.bottomSpacerEl = el;
	}

	/**
	 * Size the spacer so that the last section can have its top aligned to
	 * the reference line (container top + sticky nav height).
	 *
	 * We compute this in terms of `offsetTop` / `scrollHeight` rather than
	 * individual section heights, so that any padding, margin, border or
	 * margin-collapse behaviour between sections is transparently accounted
	 * for. The previous version used `lastSection.getBoundingClientRect()
	 * .height` and silently lost the last section's `margin-bottom` (which
	 * becomes non-zero once the spacer takes over the `:last-child` slot),
	 * causing the section to stop short of the reference line by exactly
	 * that margin.
	 *
	 * Derivation:
	 *
	 *   - Desired max `scrollTop` so that `last.top === refLine`:
	 *       neededMaxScroll = lastOffsetTop - stickyOffset
	 *   - Required `scrollHeight`:
	 *       neededScrollHeight = neededMaxScroll + clientHeight
	 *   - Current content height (everything except the spacer itself):
	 *       contentHeight = scrollHeight - currentSpacerHeight
	 *   - Hence:
	 *       spacer = max(0, neededScrollHeight - contentHeight)
	 */
	private updateBottomSpacerHeight(): void {
		if (!this.bottomSpacerEl || this.items.length === 0) return;
		const last = this.items[this.items.length - 1]!;

		const stickyOffset = this.getStickyOffset();
		const lastOffsetTop = this.getOffsetTopWithin(last.bodyEl, this.scroller);

		const currentSpacer = this.bottomSpacerEl.offsetHeight;
		const contentHeight = this.scroller.scrollHeight - currentSpacer;

		const neededScrollHeight =
			lastOffsetTop - stickyOffset + this.scroller.clientHeight;
		const spacer = Math.max(
			0,
			Math.ceil(neededScrollHeight - contentHeight)
		);

		if (spacer !== currentSpacer) {
			this.bottomSpacerEl.style.height = `${spacer}px`;
		}
	}

	/**
	 * Visual height reserved by the sticky anchor bar.
	 *
	 * `hostEl.offsetHeight` only covers the border-box; it excludes
	 * `margin-bottom`. Since the host is sticky and pinned to the top, the
	 * user perceives the reference line to be *below* that bottom margin
	 * (otherwise a section scrolled flush against the host feels crammed
	 * against its border). Including the margin gives section titles a
	 * natural breathing space that matches the visual gap between the
	 * anchor bar and the first section in the unscrolled state.
	 *
	 * On top of that we add `NAV_SECTION_GAP` so the aligned section's
	 * border outer edge sits the same distance below the nav bar as the
	 * gap between consecutive sections (`@spacing-xl` in the stylesheet).
	 * This keeps the vertical rhythm consistent: the "drop" from the nav
	 * to the first visible section matches the "drop" from one section to
	 * the next.
	 */
	private getStickyOffset(): number {
		const cs = window.getComputedStyle(this.hostEl);
		const mb = parseFloat(cs.marginBottom) || 0;
		return this.hostEl.offsetHeight + mb + NAV_SECTION_GAP;
	}

	/**
	 * Returns the offset of `el`'s top edge relative to the top of
	 * `ancestor`'s content box. Walks up through `offsetParent` chain so
	 * it works even if there are intermediate positioned wrappers.
	 */
	private getOffsetTopWithin(
		el: HTMLElement,
		ancestor: HTMLElement
	): number {
		let top = 0;
		let node: HTMLElement | null = el;
		while (node && node !== ancestor) {
			top += node.offsetTop;
			node = node.offsetParent as HTMLElement | null;
		}
		// If we didn't reach the ancestor (e.g. positioning context ended
		// earlier), fall back to geometry-based measurement.
		if (node !== ancestor) {
			const a = ancestor.getBoundingClientRect();
			const e = el.getBoundingClientRect();
			return e.top - a.top + ancestor.scrollTop;
		}
		return top;
	}

	/**
	 * Recompute spacer height whenever the scroll container or the last
	 * section's body changes size. Covers window resize, plugin tab
	 * switching and content edits within the section.
	 */
	private setupResizeObserver(): void {
		if (typeof ResizeObserver === "undefined") return;
		this.resizeObserver = new ResizeObserver(() => {
			this.updateBottomSpacerHeight();
			// Spacer height change may alter which section is considered
			// active (e.g. at the bottom edge), so refresh immediately.
			this.updateActiveFromRatios();
		});
		this.resizeObserver.observe(this.scroller);
		const last = this.items[this.items.length - 1];
		if (last) this.resizeObserver.observe(last.bodyEl);
	}
}
