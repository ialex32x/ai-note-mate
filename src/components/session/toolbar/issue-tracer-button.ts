import { App, setIcon, setTooltip } from 'obsidian';
import {
    getIssueTracerSnapshot,
    subscribeIssueTracer,
    type IssueTracerSnapshot,
} from '../../../services/diagnostics/issue-tracer';
import { IssueTracerModal } from '../../../modals/issue-tracer-modal';

export interface IssueTracerButtonHandle {
    /** Unsubscribe tracer listener; safe to call multiple times. */
    dispose(): void;
}

/**
 * Mount the Issue Tracer entry on the input toolbar.
 *
 * Visibility policy: the button mounts unconditionally (so its slot
 * in the row stays stable across renders) but a `--hidden` modifier
 * toggles `display: none` whenever `activeCount === 0`. The healthy
 * "zero issues" user therefore never sees the entry — only sessions
 * that actually hit a known-bug path get an in-app surface.
 *
 * Badge: when records are present, a small numeric pill overlays the
 * icon (`99+` cap) so the user notices a new issue without opening
 * the modal first.
 *
 * Hard-coded English copy (aria-label, tooltip) is intentional —
 * matches the IssueTracer's documented non-i18n design.
 */
export function createIssueTracerButton(
    parent: HTMLElement,
    app: App,
): IssueTracerButtonHandle {
    const wrapper = parent.createSpan({
        cls: 'session-selector session-issue-tracer',
    });

    const button = wrapper.createEl('button', {
        cls: 'session-thinking-row__icon-btn session-issue-tracer__btn',
        attr: { type: 'button', 'aria-label': 'Open issue tracer' },
    });
    setIcon(button, 'bug');
    setTooltip(button, 'Open issue tracer (in-memory diagnostic clues)');

    const badge = button.createSpan({
        cls: 'session-issue-tracer__badge',
    });

    const update = (snapshot: IssueTracerSnapshot): void => {
        const count = snapshot.activeCount;
        if (count === 0) {
            wrapper.addClass('session-issue-tracer--hidden');
            badge.setText('');
            badge.removeClass('session-issue-tracer__badge--visible');
            return;
        }
        wrapper.removeClass('session-issue-tracer--hidden');
        badge.setText(count > 99 ? '99+' : String(count));
        badge.addClass('session-issue-tracer__badge--visible');

        // Pulse the icon briefly so a NEW arrival catches the user's
        // eye even if the button was already visible. Driven by class
        // toggle so animations sit purely in LESS.
        wrapper.removeClass('session-issue-tracer--pulse');
        // Force reflow so the class re-add re-triggers the animation.
        void wrapper.offsetWidth;
        wrapper.addClass('session-issue-tracer--pulse');
    };

    button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        new IssueTracerModal(app).open();
    });

    const unsubscribe = subscribeIssueTracer(update);
    update(getIssueTracerSnapshot());

    return {
        dispose: () => {
            unsubscribe();
        },
    };
}
