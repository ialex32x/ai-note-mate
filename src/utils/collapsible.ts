/**
 * Lightweight collapsible-section utility.
 *
 * Produces a `<header>` + `<body>` pair with:
 *  - Arrow toggling (▸ / ▾)
 *  - Click + keyboard (Enter / Space) toggle
 *  - Optional persisted-expanded state via `data-*` attribute
 *
 * All DOM elements get a shared CSS class prefix so a single set of
 * stylesheet rules can cover every collapsible in the plugin (thinking
 * sections, sub-agent replies, delegate inputs, tool-call details, …).
 *
 * ── CSS classes emitted ───────────────────────────────
 *
 *   .collapsible-block                  (wrapper, only when `wrapperClass` omitted)
 *   .collapsible-block__header          (inline-flex, clickable)
 *   .collapsible-block__arrow           (▸ / ▾ text node)
 *   .collapsible-block__summary         (italic label text)
 *   .collapsible-block__body            (display:none by default)
 *   .collapsible-block__body--expanded  (display:block)
 */

export interface CollapsibleConfig {
    /** Summary text rendered in the header (after the arrow). */
    summary: string;
    /** Start in expanded state. Default: `false`. */
    initiallyExpanded?: boolean;
    /**
     * If provided, the expanded state is persisted on `persistHost` via
     * `data-${persistKey}-expanded="1"` so re-renders preserve the user's
     * manual toggle choice.
     */
    persistKey?: string;
    /**
     * Element whose `dataset` stores the persist flag. Defaults to the
     * wrapper when omitted.
     */
    persistHost?: HTMLElement;
    /**
     * Accessibility label for the header (used as `aria-label`).
     * When omitted, falls back to `summary`.
     */
    ariaLabel?: string;
}

export interface CollapsibleHandle {
    /** The outermost wrapper element. */
    wrapper: HTMLElement;
    /** The clickable header element. */
    header: HTMLElement;
    /** The collapsible body element. */
    body: HTMLElement;
    /** Programmatic toggle. */
    toggle: () => void;
    /** Query current expanded state. */
    isExpanded: () => boolean;
    /** Set expanded state programmatically. */
    setExpanded: (expanded: boolean) => void;
}

const CLASS_WRAPPER = 'collapsible-block';
const CLASS_HEADER = 'collapsible-block__header';
const CLASS_ARROW = 'collapsible-block__arrow';
const CLASS_SUMMARY = 'collapsible-block__summary';
const CLASS_BODY = 'collapsible-block__body';
const CLASS_BODY_EXPANDED = 'collapsible-block__body--expanded';

// Shared sub-element class names used by collapsible content renderers
// (code blocks, thinking sections, etc.)
export const COLLAPSIBLE_CLASSES = {
    CODE_WRAP: 'collapsible-block__code-wrap',
    CODE: 'collapsible-block__code',
    TEXT_CONTENT: 'collapsible-block__text-content',
    COPY_BTN: 'collapsible-block__copy-btn',
} as const;

/**
 * Create a self-contained collapsible section and append it to `parent`.
 */
export function createCollapsible(
    parent: HTMLElement,
    config: CollapsibleConfig,
): CollapsibleHandle {
    const {
        summary,
        initiallyExpanded = false,
        persistKey,
        persistHost,
        ariaLabel,
    } = config;

    const host = persistHost ?? parent; // default persist target

    // Resolve persisted state
    const persistedExpanded = persistKey
        ? host.dataset[`${persistKey}Expanded`] === '1'
        : false;
    const startExpanded = initiallyExpanded || persistedExpanded;

    // ── DOM ─────────────────────────────────────────────

    const wrapper = parent.createEl('div', { cls: CLASS_WRAPPER });

    const header = wrapper.createEl('span', {
        cls: CLASS_HEADER,
        attr: {
            role: 'button',
            tabindex: '0',
            'aria-label': ariaLabel ?? summary,
        },
    });

    const arrowEl = header.createEl('span', {
        cls: CLASS_ARROW,
        text: startExpanded ? '▾' : '▸',
    });
    header.appendText(' ');
    header.createEl('span', { cls: CLASS_SUMMARY, text: summary });

    const body = wrapper.createEl('div', {
        cls: startExpanded
            ? `${CLASS_BODY} ${CLASS_BODY_EXPANDED}`
            : CLASS_BODY,
    });

    // ── State ───────────────────────────────────────────

    let expanded = startExpanded;

    const persistState = () => {
        if (!persistKey) return;
        if (expanded) {
            host.dataset[`${persistKey}Expanded`] = '1';
        } else {
            delete host.dataset[`${persistKey}Expanded`];
        }
    };

    const setExpanded = (value: boolean) => {
        if (expanded === value) return;
        expanded = value;
        arrowEl.setText(expanded ? '▾' : '▸');
        body.toggleClass(CLASS_BODY_EXPANDED, expanded);
        persistState();
    };

    const toggle = () => setExpanded(!expanded);

    // ── Events ──────────────────────────────────────────

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
        }
    });

    return {
        wrapper,
        header,
        body,
        toggle,
        isExpanded: () => expanded,
        setExpanded,
    };
}
