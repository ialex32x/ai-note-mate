import { setIcon, setTooltip } from 'obsidian';
import type { SuggestedAction } from '../../services/suggestions';
import { t } from '../../i18n';

/**
 * Callback invoked when the user picks a suggestion. The host decides
 * whether to auto-send or just prefill the input.
 */
export type FollowUpPickHandler = (action: SuggestedAction) => void;

/**
 * A one-shot horizontal bar of quick-pick buttons rendered after the last
 * assistant message, offering follow-up actions extracted from the reply.
 *
 * Lifecycle: host calls `show()` with new suggestions to (re)render, and
 * `hide()` to dismiss. The bar removes itself automatically after any pick.
 */
export class FollowUpBar {
    private el: HTMLElement | null = null;
    /** Associates the bar with a particular assistant message id. */
    private ownerMessageId: string | null = null;

    constructor(
        private parent: HTMLElement,
        private onPick: FollowUpPickHandler,
    ) {}

    /** True when the bar is currently mounted. */
    get isVisible(): boolean {
        return this.el !== null;
    }

    /** Message id this bar is currently attached to (for ownership checks). */
    get messageId(): string | null {
        return this.ownerMessageId;
    }

    /** Render (or re-render) the bar for the given message with the given actions. */
    show(messageId: string, actions: SuggestedAction[]): void {
        this.hide();
        if (actions.length === 0) return;

        this.ownerMessageId = messageId;
        const bar = this.parent.createDiv({ cls: 'session-followup-bar' });

        const title = bar.createDiv({
            cls: 'session-followup-bar__title',
            text: t('view.suggestionBarTitle'),
        });
        const titleIcon = title.createSpan({ cls: 'session-followup-bar__title-icon' });
        setIcon(titleIcon, 'sparkles');

        const list = bar.createDiv({ cls: 'session-followup-bar__list' });

        for (const action of actions) {
            const btn = list.createEl('button', {
                cls: 'session-followup-bar__btn',
                attr: { type: 'button' },
            });
            const iconEl = btn.createSpan({ cls: 'session-followup-bar__btn-icon' });
            setIcon(iconEl, 'arrow-right');
            btn.createSpan({
                cls: 'session-followup-bar__btn-label',
                text: action.label,
            });
            // Show the full prompt on hover for long / truncated labels.
            setTooltip(btn, action.prompt);
            btn.addEventListener('click', (evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                // Capture the action before the bar is torn down.
                const picked = action;
                this.hide();
                this.onPick(picked);
            });
        }

        this.el = bar;
    }

    /** Remove the bar from the DOM if present. */
    hide(): void {
        if (this.el) {
            this.el.remove();
            this.el = null;
        }
        this.ownerMessageId = null;
    }
}
