import { t } from '../../i18n';

/**
 * Render the collapsible "thinking" section for an assistant message.
 *
 * Assistant models often emit a distinct reasoning stream (either
 * inline-delimited or separate from the final answer) while they work on
 * the user's query. We surface that stream in a de-emphasised collapsible
 * block above the actual reply, so the user can verify the model's
 * reasoning when helpful without it dominating the bubble visually.
 *
 * The section is intentionally self-contained:
 *  - Click/keyboard toggle with its own local `expanded` state — no need
 *    to thread callbacks back into the renderer for such a simple widget.
 *  - Streaming indicator (`--streaming` class + "Thinking…" summary) is
 *    driven by the `thinkingComplete` flag passed by the caller, which is
 *    computed from both the explicit `thinkingComplete` marker and the
 *    outer `streaming` state.
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
    const wrapper = bubble.createEl('div', {
        cls: thinkingComplete
            ? 'session-bubble__thinking'
            : 'session-bubble__thinking session-bubble__thinking--streaming',
    });

    const summaryText = thinkingComplete ? t('view.thinkingDone') : t('view.thinkingInProgress');
    const arrow = startExpanded ? '▾' : '▸';

    const header = wrapper.createEl('span', {
        cls: startExpanded
            ? 'session-bubble__thinking-header session-bubble__thinking-header--expanded'
            : 'session-bubble__thinking-header',
        attr: { 'aria-label': t('view.toggleThinking'), role: 'button', tabindex: '0' },
    });
    header.createEl('span', { cls: 'session-bubble__thinking-arrow', text: arrow });
    header.appendText(' ');
    header.createEl('span', { cls: 'session-bubble__thinking-summary', text: summaryText });

    const body = wrapper.createEl('div', {
        cls: startExpanded
            ? 'session-bubble__thinking-body session-bubble__thinking-body--expanded'
            : 'session-bubble__thinking-body',
    });
    if (thinkingContent) {
        body.setText(thinkingContent);
    }

    let expanded = startExpanded;
    const toggle = () => {
        expanded = !expanded;
        body.toggleClass('session-bubble__thinking-body--expanded', expanded);
        header.toggleClass('session-bubble__thinking-header--expanded', expanded);
        header.querySelector('.session-bubble__thinking-arrow')!.setText(expanded ? '▾' : '▸');
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
        }
    });
}
