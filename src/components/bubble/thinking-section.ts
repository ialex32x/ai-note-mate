import { t } from '../../i18n';
import { createCollapsible, COLLAPSIBLE_CLASSES } from '../../utils/collapsible';
import { createCopyButton } from '../../utils/copy-button';

/**
 * Render the collapsible "thinking" section for an assistant message.
 *
 * Uses the unified `createCollapsible` utility so the visual treatment
 * (arrow toggle, keyboard support, expand/collapse animation) is
 * identical to every other collapsible in the plugin. The body wraps
 * the thinking text in a scrollable container with a hover-reveal copy
 * button — the same pattern used by `renderCollapsibleCodeBlock`.
 *
 * @param bubble Parent element (the enclosing bubble) to append into.
 * @param thinkingContent The reasoning text to display in the body.
 * @param thinkingComplete True once the thinking phase is done (content
 *        output has begun or the whole message has finalised).
 * @param startExpanded Initial expanded state. Used by the view to
 *        preserve the user's manual toggle across re-renders of the same
 *        message (which is common during streaming updates).
 */
export function renderThinkingSection(
    bubble: HTMLElement,
    thinkingContent: string,
    thinkingComplete: boolean,
    startExpanded = false,
): void {
    const summaryText = thinkingComplete ? t('view.thinkingDone') : t('view.thinkingInProgress');

    const collapsible = createCollapsible(bubble, {
        summary: summaryText,
        initiallyExpanded: startExpanded,
        ariaLabel: t('view.toggleThinking'),
    });

    // Think content gets the inline variant (styled body area)
    collapsible.wrapper.addClass('collapsible-block--inline');
    collapsible.wrapper.addClass('collapsible-block--spaced-bottom');

    // Streaming pulse when thinking is still in progress
    if (!thinkingComplete) {
        collapsible.wrapper.addClass('collapsible-block--streaming');
    }

    if (thinkingContent) {
        // Wrap content in the same code-wrap pattern for hover-reveal copy button
        const contentWrap = collapsible.body.createEl('div', { cls: COLLAPSIBLE_CLASSES.CODE_WRAP });
        contentWrap.createEl('div', { cls: COLLAPSIBLE_CLASSES.TEXT_CONTENT, text: thinkingContent });

        const copyBtn = createCopyButton(
            t('common.copy'),
            () => thinkingContent,
            COLLAPSIBLE_CLASSES.COPY_BTN,
        );
        contentWrap.appendChild(copyBtn);
    }
}
