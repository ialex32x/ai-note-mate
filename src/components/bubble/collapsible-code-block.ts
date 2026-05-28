import { createCollapsible, type CollapsibleHandle, COLLAPSIBLE_CLASSES } from '../../utils/collapsible';
import { createCopyButton } from '../../utils/copy-button';

/**
 * Options for the unified collapsible code-block component.
 *
 * Produces a toggle-header (arrow + label) plus a monospaced `<pre>` body
 * with a hover-reveal copy button. Replaces the previously duplicated
 * "Arguments / Result / Handoff seed" code-block patterns in tool-call
 * and sub-agent bubbles.
 */
export interface CollapsibleCodeBlockOptions {
    /** Label text shown in the collapsible header (e.g. "Arguments"). */
    label: string;
    /** The code / JSON string to display in the `<pre>` body. */
    code: string;
    /** Start expanded? Default: `false`. */
    initiallyExpanded?: boolean;
    /**
     * Persist expanded state to `data-${persistKey}-expanded` on the
     * persist host element. When omitted, state is ephemeral.
     */
    persistKey?: string;
    /** Element to carry the persist data attribute. Defaults to the collapsible wrapper. */
    persistHost?: HTMLElement;
    /** Accessible label for the copy button. When omitted, no copy button is rendered. */
    copyLabel?: string;
}


/**
 * Render a collapsible code block into `parent`.
 *
 * Structure:
 * ```
 * [collapsible-block]
 *   [collapsible-block__header] ▸/▾ label
 *   [collapsible-block__body]
 *     [collapsible-block__code-wrap]
 *       [collapsible-block__code] <pre>code</pre>
 *       [collapsible-block__copy-btn]  (optional)
 * ```
 *
 * @returns The collapsible handle so the caller can programmatically
 *          toggle / query state if needed.
 */
export function renderCollapsibleCodeBlock(
    parent: HTMLElement,
    options: CollapsibleCodeBlockOptions,
): CollapsibleHandle {
    const {
        label,
        code,
        initiallyExpanded = false,
        persistKey,
        persistHost,
        copyLabel,
    } = options;

    const collapsible = createCollapsible(parent, {
        summary: label,
        initiallyExpanded,
        persistKey,
        persistHost,
    });

    // Add code-specific styling marker on the wrapper
    collapsible.wrapper.addClass('collapsible-block--code');

    const codeWrap = collapsible.body.createEl('div', { cls: COLLAPSIBLE_CLASSES.CODE_WRAP });
    codeWrap.createEl('pre', { cls: COLLAPSIBLE_CLASSES.CODE, text: code });

    if (copyLabel) {
        const copyBtn = createCopyButton(copyLabel, () => code, COLLAPSIBLE_CLASSES.COPY_BTN);
        codeWrap.appendChild(copyBtn);
    }

    return collapsible;
}
