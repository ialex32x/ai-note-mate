import { setIcon } from 'obsidian';
import { t } from '../../i18n';

// ── Preview content types (extensible) ─────────────────────────────────

export interface ImagePreviewContent {
	kind: 'image';
	src: string;
	alt?: string;
}

export interface MermaidPreviewContent {
	kind: 'mermaid';
	svg: string;
	code?: string;
}

export type PreviewContent = ImagePreviewContent | MermaidPreviewContent;

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

	/** Current transform state. */
	private transform: TransformState = { scale: 1, tx: 0, ty: 0 };
	/** Dragging state (pointer-tracking in viewport coordinates). */
	private dragging = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private dragStartTx = 0;
	private dragStartTy = 0;
	/** Whether the overlay is currently visible. */
	private visible = false;

	constructor(private readonly host: HTMLElement) {}

	// ── Mount / dispose ──────────────────────────────────────────────────

	mount(): void {
		if (this.el) return;

		this.el = this.host.createEl('div', {
			cls: 'session-preview-overlay session-preview-overlay--hidden',
			attr: { 'aria-hidden': 'true', tabindex: '-1' },
		});

		// Backdrop: clicking it dismisses.
		const backdrop = this.el.createEl('div', { cls: 'session-preview__backdrop' });
		backdrop.addEventListener('click', () => this.hide());

		// ── Content wrapper (zoom-pan target) ──────────────────────────
		this.contentWrapper = this.el.createEl('div', {
			cls: 'session-preview__content',
		});

		// ── Control bar (bottom) ───────────────────────────────────────
		this.controlBar = this.el.createEl('div', {
			cls: 'session-preview__controls',
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
		}
		this.hide();
		this.el.remove();
		this.el = null;
		this.contentWrapper = null;
		this.controlBar = null;
	}

	// ── Show / hide ─────────────────────────────────────────────────────

	/**
	 * Show the overlay and render the given preview content.
	 */
	show(content: PreviewContent): void {
		if (!this.el || !this.contentWrapper) return;

		// Reset transform.
		this.transform = { scale: 1, tx: 0, ty: 0 };

		// Clear previous content.
		this.contentWrapper.empty();

		// Render according to kind.
		let contentEl: HTMLElement;
		switch (content.kind) {
			case 'image':
				contentEl = this.renderImage(content);
				break;
			case 'mermaid':
				contentEl = this.renderMermaid(content);
				break;
			default:
				return;
		}

		this.contentWrapper.appendChild(contentEl);

		// Apply initial transform.
		this.applyTransform();

		// Show.
		this.el.removeClass('session-preview-overlay--hidden');
		this.el.setAttribute('aria-hidden', 'false');
		this.el.focus();
		this.visible = true;
	}

	hide(): void {
		if (!this.el) return;
		this.el.addClass('session-preview-overlay--hidden');
		this.el.setAttribute('aria-hidden', 'true');
		this.visible = false;
	}

	// ── Content renderers ───────────────────────────────────────────────

	private renderImage(content: ImagePreviewContent): HTMLElement {
		const img = activeDocument.createElement('img');
		img.className = 'session-preview__image';
		img.src = content.src;
		if (content.alt) img.alt = content.alt;
		// Prevent native drag on the image (our pan gesture handles it).
		img.draggable = false;
		return img;
	}

	private renderMermaid(content: MermaidPreviewContent): HTMLElement {
		const wrapper = activeDocument.createElement('div');
		wrapper.className = 'session-preview__mermaid';
		wrapper.innerHTML = content.svg;
		return wrapper;
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
		// Only respond to left button.
		if (e.button !== 0) return;
		// Don't capture if the target is inside the control bar.
		if (this.controlBar && this.controlBar.contains(e.target as Node)) return;

		this.dragging = true;
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
		this.contentWrapper?.removeClass('is-dragging');
		try {
			this.contentWrapper?.releasePointerCapture(e.pointerId);
		} catch {
			// Pointer may already be released.
		}
	};
}
