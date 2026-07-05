import type { BubbleContext } from './bubble-context';

/**
 * Where to anchor a dropdown relative to its anchor element.
 *
 *  - `below`: dropdown's top edge sits 4px below the anchor's bottom edge.
 *  - `above`: dropdown's bottom edge sits 4px above the anchor's top edge.
 */
export type AnchoredDropdownPlacement = 'below' | 'above';

/**
 * Region(s) that should NOT trigger the outside-click close behaviour. The
 * anchor element is implicitly included; pass any additional surfaces
 * (e.g. an entire `speak-group` wrapper) that the user might click on
 * legitimately while the dropdown is open.
 */
export type AnchoredDropdownInsideRegion = HTMLElement | (() => HTMLElement | null | undefined);

export interface AnchoredDropdownHandle {
    /** Underlying menu element. Useful for repopulating contents async. */
    readonly menu: HTMLElement;
    /** Close the dropdown and run cleanup (idempotent). */
    close(): void;
    /**
     * Recompute the dropdown's position relative to its anchor. Call this
     * after the menu's contents change in a way that affects its size and
     * the existing position would now overflow the viewport.
     *
     * Note: the helper already runs an edge-clamp on next animation frame
     * after open, so most callers won't need to invoke this manually.
     */
    reposition(): void;
}

export interface OpenAnchoredDropdownOptions {
    /** Element the dropdown is anchored to (used for positioning + outside-click). */
    anchor: HTMLElement;
    /** Above or below the anchor. */
    placement: AnchoredDropdownPlacement;
    /**
     * Extra CSS classes appended to the menu in addition to the base
     * `session-dropdown-menu session-dropdown-menu--anchored` pair.
     */
    cls?: string;
    /**
     * Extra `data-*` attributes set on the menu element.
     */
    attr?: Record<string, string>;
    /**
     * Additional regions where clicks should NOT close the dropdown.
     * The anchor and the menu itself are always considered "inside".
     */
    insideRegions?: AnchoredDropdownInsideRegion[];
    /** Build the dropdown's contents. `close` is the same callback returned in the handle. */
    build(menu: HTMLElement, close: () => void): void;
    /** Side-effect when the dropdown opens (e.g. add a pinned modifier). */
    onOpen?(): void;
    /** Side-effect when the dropdown closes (e.g. remove pinned modifier, detach listeners). */
    onClose?(): void;
}

/**
 * Open an anchored dropdown menu inside the bubble renderer's floating
 * layer.
 *
 * Replaces the bespoke open/close/edge-clamp/outside-click code that used
 * to live in `tool-call.ts` and `speech-controller.ts`. Both call-sites
 * shared the same dance:
 *
 *   1. Create a menu in `ctx.getFloatingLayer()`.
 *   2. Translate the anchor's viewport rect into layer-relative
 *      coordinates so absolute positioning lands accurately regardless of
 *      transformed/contained ancestors.
 *   3. After paint, edge-clamp the menu against the viewport.
 *   4. Listen for outside clicks on the active document and close on
 *      first hit outside the anchor + menu.
 *   5. Auto-close when the owning renderer unloads (via `ctx.register`).
 *
 * The helper is intentionally one-shot: each call builds a fresh menu and
 * destroys it on close, mirroring the cleaner of the two original
 * implementations (voice picker). Tool-confirm callers that previously
 * created the dropdown once and toggled `display` instead now simply
 * re-call this on each open — there's no measurable difference and the
 * state surface shrinks considerably.
 */
export function openAnchoredDropdown(
    ctx: BubbleContext,
    opts: OpenAnchoredDropdownOptions,
): AnchoredDropdownHandle {
    const layer = ctx.getFloatingLayer();
    const baseCls = 'session-dropdown-menu session-dropdown-menu--anchored';
    const fullCls = opts.cls ? `${baseCls} ${opts.cls}` : baseCls;
    const menu = layer.createDiv({
        cls: fullCls,
        attr: opts.attr,
    });

    let closed = false;
    let outsideClickDoc: Document | null = null;
    let outsideClickHandler: ((ev: MouseEvent) => void) | null = null;
    let unregister: (() => void) | null = null;

    const close = () => {
        if (closed) return;
        closed = true;
        if (outsideClickHandler && outsideClickDoc) {
            outsideClickDoc.removeEventListener('click', outsideClickHandler);
            outsideClickHandler = null;
            outsideClickDoc = null;
        }
        if (menu.isConnected) {
            menu.remove();
        }
        opts.onClose?.();
        unregister = null;
    };

    const isInside = (target: Node): boolean => {
        if (opts.anchor.contains(target)) return true;
        if (menu.contains(target)) return true;
        if (opts.insideRegions) {
            for (const region of opts.insideRegions) {
                const el = typeof region === 'function' ? region() : region;
                if (el && el.contains(target)) return true;
            }
        }
        return false;
    };

    const positionMenu = () => {
        const anchorRect = opts.anchor.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        // Horizontal: align left edges to the anchor.
        menu.style.left = `${anchorRect.left - layerRect.left}px`;
        menu.style.removeProperty('right');
        if (opts.placement === 'below') {
            menu.style.top = `${anchorRect.bottom - layerRect.top + 4}px`;
            menu.style.removeProperty('bottom');
        } else {
            // `above`: anchor menu by its bottom edge so growing content
            // expands upward without overlapping the anchor.
            menu.style.bottom = `${layerRect.bottom - anchorRect.top + 4}px`;
            menu.style.removeProperty('top');
        }
    };

    const clampToViewport = () => {
        if (closed || !menu.isConnected) return;
        const rect = menu.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            const clampedViewportLeft = window.innerWidth - rect.width - 8;
            menu.style.left = `${clampedViewportLeft - layerRect.left}px`;
        }
        if (rect.left < 0) {
            menu.style.left = `${-layerRect.left + 8}px`;
        }
    };

    // Build user contents BEFORE positioning so the menu's natural width
    // is known when we measure for edge-clamping.
    opts.build(menu, close);
    positionMenu();
    menu.addClass('session-dropdown-menu--open');
    opts.onOpen?.();

    window.requestAnimationFrame(clampToViewport);

    // Defer attaching the outside-click listener until after the click
    // event that opened the dropdown has finished bubbling — otherwise
    // the same click would immediately close it.
    window.requestAnimationFrame(() => {
        if (closed) return;
        outsideClickDoc = activeDocument;
        outsideClickHandler = (ev: MouseEvent) => {
            const target = ev.target as Node | null;
            if (!target) return;
            if (!isInside(target)) close();
        };
        outsideClickDoc.addEventListener('click', outsideClickHandler);
    });

    // Auto-close when the owning renderer unloads.
    unregister = () => close();
    ctx.register(() => {
        unregister?.();
    });

    return {
        menu,
        close,
        reposition: () => {
            if (closed) return;
            positionMenu();
            window.requestAnimationFrame(clampToViewport);
        },
    };
}
