import { setIcon } from 'obsidian';
import { t } from '../../i18n';

// ── Preview content types (extensible) ─────────────────────────────────

export interface ImagePreviewContent {
	kind: 'image';
	src: string;
	alt?: string;
	/**
	 * Vault-relative path of the image file, when the source is a vault
	 * attachment (e.g. `assets/photo.png`). Present only for images
	 * rendered from `app://` resource URLs — not for data-URLs or external
	 * http images. Used by the overlay's "Open file" toolbar button.
	 */
	vaultPath?: string;
}

export interface MermaidPreviewContent {
	kind: 'mermaid';
	/**
	 * The live rendered mermaid `<svg>` node from the bubble.  The overlay
	 * clones it on render, so passing the live node is safe (it is never
	 * reparented out of the bubble).  Using the DOM node directly — rather
	 * than a serialized string — preserves `<foreignObject>` HTML labels and
	 * lets the overlay reuse the exact diagram the user sees in the bubble.
	 */
	svg: SVGElement;
	code?: string;
}

export type PreviewContent = ImagePreviewContent | MermaidPreviewContent;

/**
 * A snapshot of previewable items surrounding the currently-shown one.
 * Enables the overlay to render "previous / next" navigation controls
 * without knowing anything about the source of the items.
 *
 * Callers build the snapshot at open-time (e.g. by enumerating the DOM
 * of the containing view). The overlay treats it as immutable during
 * its lifetime — closing and reopening the overlay is the natural way
 * to pick up new items.
 */
export interface PreviewGallery {
	items: PreviewContent[];
	index: number;
}

// ── Zoom / pan state ───────────────────────────────────────────────────

interface TransformState {
	/** Scale factor (1 = 100%). Clamped to [MIN_SCALE, MAX_SCALE]. */
	scale: number;
	/** Pan offset in CSS pixels (unscaled). */
	tx: number;
	ty: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
const ZOOM_SENSITIVITY = 0.001;

// ── Preview overlay ────────────────────────────────────────────────────

/**
 * Full-viewport preview overlay mounted inside a session view.
 *
 * Covers the entire session view container. Displays a zoomable /
 * pannable preview of the given {@link PreviewContent}. A control bar at
 * the bottom provides a Close button. Escape and backdrop-click also
 * dismiss the overlay.
 *
 * ## Extensibility
 *
 * New content kinds are added by extending {@link PreviewContent} and
 * implementing a corresponding `render{Kind}` method that creates the
 * DOM element to be placed inside the zoom-pan wrapper. The wrapper
 * (`.session-preview__content`) always receives the same transform
 * treatment regardless of content type.
 */
export class PreviewOverlay {
	private el: HTMLElement | null = null;
	private contentWrapper: HTMLElement | null = null;
	private controlBar: HTMLElement | null = null;

	// ── Gallery navigation state ──────────────────────────────────────
	/** Prev/next buttons flanking the content (null until mounted). */
	private prevBtn: HTMLButtonElement | null = null;
	private nextBtn: HTMLButtonElement | null = null;
	/** Current gallery snapshot; null when only a single item is shown. */
	private gallery: PreviewGallery | null = null;
	/** The content item currently displayed, kept for the "Open file" action. */
	private currentContent: PreviewContent | null = null;

	/** "Open file" toolbar button; shown only when current item has a vaultPath. */
	private openFileBtn: HTMLButtonElement | null = null;

	/** Current transform state. */
	private transform: TransformState = { scale: 1, tx: 0, ty: 0 };
	/** Dragging state (pointer-tracking in viewport coordinates). */
	private dragging = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragStartTx = 0;
	private dragStartTy = 0;
	/** Pointer ID captured during drag, used to release capture on pinch. */
	private capturedPointerId = -1;

	// ── Pinch-to-zoom state (mobile multi-touch) ─────────────────────
	/** Whether a two-finger pinch gesture is in progress. */
	private pinching = false;
	/** Distance (px) between the two touch points in the previous frame. */
	private prevPinchDistance = 0;
	/** Midpoint (viewport coords) of the two fingers in the previous frame. */
	private prevPinchCenterX = 0;
	private prevPinchCenterY = 0;

	constructor(
		private readonly host: HTMLElement,
		/**
		 * Called when the user clicks the "Open file" button in the control
		 * bar. Receives the vault-relative path of the currently-shown image.
		 * When omitted the button is never shown.
		 */
		private readonly onOpenFile?: (vaultPath: string) => void,
	) {}

	// ── Mount / dispose ──────────────────────────────────────────────────

	mount(): void {
		if (this.el) return;

		this.el = this.host.createDiv({
			cls: 'session-preview-overlay session-preview-overlay--hidden',
			attr: { 'aria-hidden': 'true', tabindex: '-1' },
		});

		// Backdrop: clicking it dismisses.
		const backdrop = this.el.createDiv({ cls: 'session-preview__backdrop' });
		backdrop.addEventListener('click', () => this.hide());

		// ── Content wrapper (zoom-pan target) ──────────────────────────
		this.contentWrapper = this.el.createDiv({
			cls: 'session-preview__content',
		});

		// ── Side navigation buttons (prev / next) ──────────────────────
		// Rendered as siblings of the content wrapper so their position is
		// unaffected by the zoom/pan transform applied to the content.
		this.prevBtn = this.createNavButton('prev');
		this.nextBtn = this.createNavButton('next');

		// ── Control bar (bottom) ───────────────────────────────────────
		this.controlBar = this.el.createDiv({
			cls: 'session-preview__controls',
		});

		// "Open file" button — only visible for vault images.
		// Created unconditionally so show/hide is a simple class toggle;
		// the actual callback guard means clicking it when hidden is a no-op.
		this.openFileBtn = this.controlBar.createEl('button', {
			cls: 'session-preview__open-file-btn session-preview__open-file-btn--hidden',
			attr: { 'aria-label': t('preview.openFile'), type: 'button' },
		});
		setIcon(this.openFileBtn, 'external-link');
		this.openFileBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.triggerOpenFile();
		});

		const closeBtn = this.controlBar.createEl('button', {
			cls: 'session-preview__close-btn',
			attr: { 'aria-label': t('preview.close') },
		});
		setIcon(closeBtn, 'x');
		closeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.hide();
		});

		// ── Global keyboard handler ────────────────────────────────────
		this.el.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				this.hide();
				return;
			}
			if (e.key === 'ArrowLeft') {
				if (this.navigate(-1)) e.preventDefault();
				return;
			}
			if (e.key === 'ArrowRight') {
				if (this.navigate(1)) e.preventDefault();
				return;
			}
		});

		// ── Zoom (wheel) on the content wrapper ────────────────────────
		// Using the content wrapper so the wheel event doesn't fire on
		// the control bar area.
		this.contentWrapper.addEventListener('wheel', this.handleWheel, { passive: false });

		// ── Pan (pointer events) on the content wrapper ────────────────
		this.contentWrapper.addEventListener('pointerdown', this.handlePointerDown);
		// Register on the overlay element so dragging continues even
		// when the pointer moves off the content wrapper.
		this.el.addEventListener('pointermove', this.handlePointerMove);
		this.el.addEventListener('pointerup', this.handlePointerUp);
		this.el.addEventListener('pointercancel', this.handlePointerUp);
		// Prevent default drag behaviors (image drag, text selection).
		this.el.addEventListener('dragstart', (e) => e.preventDefault());

		// ── Pinch-to-zoom (mobile multi-touch) ─────────────────────────
		this.el.addEventListener('touchstart', this.handleTouchStart, { passive: false });
		this.el.addEventListener('touchmove', this.handleTouchMove, { passive: false });
		this.el.addEventListener('touchend', this.handleTouchEnd);
		this.el.addEventListener('touchcancel', this.handleTouchEnd);
	}

	dispose(): void {
		if (!this.el) return;
		if (this.contentWrapper) {
			this.contentWrapper.removeEventListener('wheel', this.handleWheel);
			this.contentWrapper.removeEventListener('pointerdown', this.handlePointerDown);
		}
		if (this.el) {
			this.el.removeEventListener('pointermove', this.handlePointerMove);
			this.el.removeEventListener('pointerup', this.handlePointerUp);
			this.el.removeEventListener('pointercancel', this.handlePointerUp);
			this.el.removeEventListener('touchstart', this.handleTouchStart);
			this.el.removeEventListener('touchmove', this.handleTouchMove);
			this.el.removeEventListener('touchend', this.handleTouchEnd);
			this.el.removeEventListener('touchcancel', this.handleTouchEnd);
		}
		this.hide();
		this.el.remove();
		this.el = null;
		this.contentWrapper = null;
		this.controlBar = null;
		this.prevBtn = null;
		this.nextBtn = null;
		this.openFileBtn = null;
		this.gallery = null;
		this.currentContent = null;
	}

	// ── Show / hide ─────────────────────────────────────────────────────

	/**
	 * Show the overlay and render the given preview content.
	 *
	 * When `gallery` is supplied and holds more than one item, previous
	 * / next side buttons (and arrow-key navigation) are enabled. The
	 * `content` argument must match `gallery.items[gallery.index]` —
	 * callers may pass any equivalent instance; the gallery version is
	 * what's actually rendered.
	 */
	show(content: PreviewContent, gallery?: PreviewGallery): void {
		if (!this.el || !this.contentWrapper) return;

		// Store gallery snapshot (null when single-item mode).
		this.gallery = gallery && gallery.items.length > 1 ? gallery : null;

		this.renderContent(this.gallery ? this.gallery.items[this.gallery.index] ?? content : content);
		this.updateNavButtons();

		// Show.
		this.el.removeClass('session-preview-overlay--hidden');
		this.el.setAttribute('aria-hidden', 'false');
		this.el.focus();
	}

	hide(): void {
		if (!this.el) return;
		// Reset gesture state in case hide() was called mid-gesture
		// (e.g. Escape key while pinching).
		this.dragging = false;
		this.pinching = false;
		this.capturedPointerId = -1;
		this.contentWrapper?.removeClass('is-dragging');
		this.gallery = null;
		this.currentContent = null;
		this.updateNavButtons();
		this.updateOpenFileButton(null);
		this.el.addClass('session-preview-overlay--hidden');
		this.el.setAttribute('aria-hidden', 'true');
	}

	// ── Content renderers ───────────────────────────────────────────────

	/**
	 * Reset gesture / transform state and render the given content into
	 * the content wrapper. Shared by initial show and gallery navigation.
	 */
	private renderContent(content: PreviewContent): void {
		if (!this.contentWrapper) return;

		// Reset transform and gesture state for each new item.
		this.transform = { scale: 1, tx: 0, ty: 0 };
		this.dragging = false;
		this.pinching = false;
		this.capturedPointerId = -1;
		this.contentWrapper.removeClass('is-dragging');

		// Clear previous content.
		this.contentWrapper.empty();

		// Render according to kind.
		let contentEl: HTMLElement | null;
		switch (content.kind) {
			case 'image':
				contentEl = this.renderImage(content);
				break;
			case 'mermaid':
				contentEl = this.renderMermaid(content);
				break;
			default:
				contentEl = null;
		}

		if (contentEl) {
			this.contentWrapper.appendChild(contentEl);
		}

		this.currentContent = content;
		this.applyTransform();
		this.updateOpenFileButton(content);
	}

	private renderImage(content: ImagePreviewContent): HTMLElement {
		const img = createEl('img');
		img.className = 'session-preview__image';
		img.src = content.src;
		if (content.alt) img.alt = content.alt;
		// Prevent native drag on the image (our pan gesture handles it).
		img.draggable = false;
		return img;
	}

	private renderMermaid(content: MermaidPreviewContent): HTMLElement {
		// The `.mermaid` class lets Obsidian's theme CSS recolor the diagram
		// exactly as in the bubble (style consistency); `data-processed`
		// prevents mermaid.js from re-scanning / re-rendering the clone.
		const wrapper = createDiv();
		wrapper.className = 'mermaid session-preview__mermaid';
		wrapper.setAttribute('data-processed', 'true');
		// Clone the bubble's live SVG node so the overlay shows the identical
		// diagram (labels, colors, layout) without detaching it from the bubble.
		wrapper.appendChild(content.svg.cloneNode(true));
		return wrapper;
	}

	// ── Gallery navigation ──────────────────────────────────────────────

	/**
	 * Create a chevron nav button for the given direction and wire it
	 * to {@link navigate}. Returns the button element.
	 */
	private createNavButton(direction: 'prev' | 'next'): HTMLButtonElement {
		if (!this.el) throw new Error('createNavButton called before mount');
		const btn = this.el.createEl('button', {
			cls: `session-preview__nav-btn session-preview__nav-btn--${direction} session-preview__nav-btn--hidden`,
			attr: {
				type: 'button',
				'aria-label': t(direction === 'prev' ? 'preview.previous' : 'preview.next'),
			},
		});
		setIcon(btn, direction === 'prev' ? 'chevron-left' : 'chevron-right');
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.navigate(direction === 'prev' ? -1 : 1);
		});
		return btn;
	}

	/**
	 * Move the gallery cursor by `delta` (-1 for prev, +1 for next) and
	 * re-render. No-op when no gallery is active or the boundary is
	 * reached (no wrap-around). Returns true if navigation happened.
	 */
	private navigate(delta: number): boolean {
		if (!this.gallery) return false;
		const nextIndex = this.gallery.index + delta;
		if (nextIndex < 0 || nextIndex >= this.gallery.items.length) return false;
		const nextItem = this.gallery.items[nextIndex];
		if (!nextItem) return false;
		this.gallery = { items: this.gallery.items, index: nextIndex };
		this.renderContent(nextItem);
		this.updateNavButtons();
		return true;
	}

	/**
	 * Toggle visibility / disabled state of the prev/next buttons
	 * according to the current gallery position. Hidden entirely when
	 * there's no gallery (single-item view).
	 */
	private updateNavButtons(): void {
		if (!this.prevBtn || !this.nextBtn) return;
		if (!this.gallery) {
			this.prevBtn.addClass('session-preview__nav-btn--hidden');
			this.nextBtn.addClass('session-preview__nav-btn--hidden');
			return;
		}
		this.prevBtn.removeClass('session-preview__nav-btn--hidden');
		this.nextBtn.removeClass('session-preview__nav-btn--hidden');
		this.prevBtn.disabled = this.gallery.index <= 0;
		this.nextBtn.disabled = this.gallery.index >= this.gallery.items.length - 1;
	}

	/**
	 * Show or hide the "Open file" button depending on whether the current
	 * content item is a vault image. Pass `null` to always hide (e.g. on close).
	 */
	private updateOpenFileButton(content: PreviewContent | null): void {
		if (!this.openFileBtn) return;
		const vaultPath =
			content?.kind === 'image' && this.onOpenFile ? content.vaultPath : undefined;
		if (vaultPath) {
			this.openFileBtn.removeClass('session-preview__open-file-btn--hidden');
		} else {
			this.openFileBtn.addClass('session-preview__open-file-btn--hidden');
		}
	}

	/** Fire the host's open-file callback for the current vault image. */
	private triggerOpenFile(): void {
		if (!this.currentContent || this.currentContent.kind !== 'image') return;
		const vaultPath = this.currentContent.vaultPath;
		if (vaultPath && this.onOpenFile) {
			this.onOpenFile(vaultPath);
		}
	}

	// ── Transform helpers ───────────────────────────────────────────────

	private applyTransform(): void {
		if (!this.contentWrapper) return;
		const { scale, tx, ty } = this.transform;
		this.contentWrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
	}

	private clampScale(s: number): number {
		return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
	}

	// ── Zoom (wheel) ────────────────────────────────────────────────────

	private handleWheel = (e: WheelEvent): void => {
		e.preventDefault();

		const rect = this.contentWrapper!.getBoundingClientRect();
		// `rect` reflects the visual position AFTER transform, but the zoom
		// formula needs coordinates relative to the element's original
		// (untransformed) layout position. Recover that by subtracting the
		// current translate offset.
		const layoutX = rect.left - this.transform.tx;
		const layoutY = rect.top - this.transform.ty;
		// Mouse position relative to the untransformed origin.
		const mx = e.clientX - layoutX;
		const my = e.clientY - layoutY;

		const prevScale = this.transform.scale;
		// Zoom direction: deltaY < 0 = zoom in, deltaY > 0 = zoom out.
		const delta = -e.deltaY * ZOOM_SENSITIVITY;
		const newScale = this.clampScale(prevScale * (1 + delta));

		if (newScale === prevScale) return;

		// Zoom centered on the mouse position:
		// We want the point under the mouse to stay fixed.
		// new_tx = mx - (mx - old_tx) * (newScale / oldScale)
		const scaleRatio = newScale / prevScale;
		this.transform.tx = mx - (mx - this.transform.tx) * scaleRatio;
		this.transform.ty = my - (my - this.transform.ty) * scaleRatio;
		this.transform.scale = newScale;

		this.applyTransform();
	};

	// ── Pan (pointer drag) ──────────────────────────────────────────────

	private handlePointerDown = (e: PointerEvent): void => {
		// Only respond to left button (or touch).
		if (e.button !== 0) return;
		// Don't capture if the target is inside the control bar.
		if (this.controlBar && this.controlBar.contains(e.target as Node)) return;
		// Don't start a new drag if a pinch is already in progress.
		if (this.pinching) return;

		this.dragging = true;
		this.capturedPointerId = e.pointerId;
		this.contentWrapper?.addClass('is-dragging');
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;
		this.dragStartTx = this.transform.tx;
		this.dragStartTy = this.transform.ty;
		// Capture pointer so we get move/up events even outside the
		// content wrapper.
		this.contentWrapper!.setPointerCapture(e.pointerId);
	};

	private handlePointerMove = (e: PointerEvent): void => {
		if (!this.dragging) return;
		const dx = e.clientX - this.dragStartX;
		const dy = e.clientY - this.dragStartY;
		this.transform.tx = this.dragStartTx + dx;
		this.transform.ty = this.dragStartTy + dy;
		this.applyTransform();
	};

	private handlePointerUp = (e: PointerEvent): void => {
		if (!this.dragging) return;
		this.dragging = false;
		this.capturedPointerId = -1;
		this.contentWrapper?.removeClass('is-dragging');
		try {
			this.contentWrapper?.releasePointerCapture(e.pointerId);
		} catch {
			// Pointer may already be released.
		}
	};

	// ── Pinch-to-zoom (mobile multi-touch) ──────────────────────────────

	/**
	 * When a second finger touches the screen, cancel any ongoing drag
	 * and initialize a pinch-to-zoom gesture.
	 */
	private handleTouchStart = (e: TouchEvent): void => {
		const touches = e.touches;
		if (touches.length < 2) return;

		// Prevent browser defaults and stop propagation so Obsidian's
		// built-in swipe gestures (e.g. side-drawer) are never triggered
		// while a pinch gesture is in progress.
		e.preventDefault();
		e.stopPropagation();

		const t0 = touches[0];
		const t1 = touches[1];
		if (!t0 || !t1) return;

		// Cancel any ongoing single-finger drag.
		if (this.dragging) {
			this.dragging = false;
			this.contentWrapper?.removeClass('is-dragging');
			// Release pointer capture so the second pointer won't be
			// intercepted.
			if (this.capturedPointerId !== -1 && this.contentWrapper) {
				try {
					this.contentWrapper.releasePointerCapture(this.capturedPointerId);
				} catch { /* already released */ }
			}
			this.capturedPointerId = -1;
		}

		this.pinching = true;
		this.prevPinchDistance = Math.hypot(
			t1.clientX - t0.clientX,
			t1.clientY - t0.clientY,
		);
		this.prevPinchCenterX = (t0.clientX + t1.clientX) / 2;
		this.prevPinchCenterY = (t0.clientY + t1.clientY) / 2;
	};

	/**
	 * During an active pinch gesture, apply a per-frame incremental zoom
	 * centered on the current two-finger midpoint — so the zoom center
	 * follows the fingers as they move.
	 */
	private handleTouchMove = (e: TouchEvent): void => {
		const touches = e.touches;
		if (touches.length === 1) {
			// Single-finger move → prevent page scroll while overlay is open.
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		if (touches.length < 2 || !this.pinching) return;

		const t0 = touches[0];
		const t1 = touches[1];
		if (!t0 || !t1) return;

		e.preventDefault();
		e.stopPropagation();

		const currentDistance = Math.hypot(
			t1.clientX - t0.clientX,
			t1.clientY - t0.clientY,
		);

		if (this.prevPinchDistance === 0) {
			this.prevPinchDistance = currentDistance;
			return;
		}

		// Snapshot state BEFORE any changes this frame.
		const oldTx = this.transform.tx;
		const oldTy = this.transform.ty;
		const oldScale = this.transform.scale;

		// Content wrapper's untransformed layout origin in viewport.
		// Because of flex centering this is NOT (0, 0); we recover it
		// from the current bounding rect and translate.
		const rect = this.contentWrapper!.getBoundingClientRect();
		const layoutLeft = rect.left - oldTx;
		const layoutTop = rect.top - oldTy;

		// Current finger midpoint in viewport.
		const cx = (t0.clientX + t1.clientX) / 2;
		const cy = (t0.clientY + t1.clientY) / 2;

		// ── 1. Two-finger pan: move by the midpoint delta ──────────────
		this.transform.tx = oldTx + (cx - this.prevPinchCenterX);
		this.transform.ty = oldTy + (cy - this.prevPinchCenterY);

		// ── 2. Pinch zoom centered on current midpoint ─────────────────
		const scaleRatio = currentDistance / this.prevPinchDistance;
		const newScale = this.clampScale(oldScale * scaleRatio);
		const effectiveRatio = newScale / oldScale;

		// visual_x = layoutLeft + local_x * scale + tx
		// Keep the viewport point (cx, cy) fixed during zoom:
		// newTx = cx - layoutLeft - (cx - layoutLeft - tx) * (newScale/oldScale)
		this.transform.tx = cx - layoutLeft
			- (cx - layoutLeft - this.transform.tx) * effectiveRatio;
		this.transform.ty = cy - layoutTop
			- (cy - layoutTop - this.transform.ty) * effectiveRatio;
		this.transform.scale = newScale;

		// Store for the next frame.
		this.prevPinchDistance = currentDistance;
		this.prevPinchCenterX = cx;
		this.prevPinchCenterY = cy;

		this.applyTransform();
	};

	/**
	 * When fingers are lifted, end the pinch gesture.
	 * If exactly one finger remains, the user may continue with a
	 * single-finger drag (handled by pointer events).
	 */
	private handleTouchEnd = (e: TouchEvent): void => {
		if (e.touches.length < 2) {
			this.pinching = false;
		}
	};
}
