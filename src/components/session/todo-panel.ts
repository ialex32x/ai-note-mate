import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { TodoItem, TodoState, TodoStatus } from '../../services/tools/todo-state';

    /**
     * Read-only pinned panel showing the current TODO list for the
     * active session. Mounted just ABOVE the input container so the
     * panel stays within thumb / cursor reach regardless of scroll
     * position, and so the user never has to leave the compose area
     * to glance at the plan.
     *
     * The panel is a pure renderer driven by `SessionRuntime`'s
     * `todo-update` events and by the runtime's persisted snapshot —
     * the view never decides what state to show on its own, and the
     * user never edits items here (the LLM is the single writer).
     *
     * State model: two states, `collapsed` (header only) or expanded
     * (full list + header). The list is rendered ABOVE the header
     * so expansion grows UPWARD into the chat area (bottom-sheet
     * pattern); a CSS `max-height` + scroll cap on the list keeps
     * that growth bounded.
     *
     * Layout (expanded):
     *   .session-todo-panel-host                  (host slot in session-view)
     *     .session-todo-panel                     (only present when items exist)
     *       .session-todo-panel__list             (every item row, scrolls if tall)
     *       .session-todo-panel__header           (title + count + collapse chevron)
     *
     * Layout (collapsed): only the header remains, list is omitted.
     */
export class TodoPanel {
    private el: HTMLElement | null = null;
    /**
     * True when the user has folded the panel down to a single-line
     * header. New sessions start collapsed; we preserve the user's
     * choice across subsequent `todo-update` re-renders.
     */
    private collapsed = true;
    /** Latest state snapshot. Source of truth for re-renders. */
    private currentState: TodoState | null = null;

    constructor(private parent: HTMLElement) {}

    /** True when the panel currently owns a DOM node. */
    get isVisible(): boolean {
        return this.el !== null;
    }

    /**
     * Project a runtime TODO snapshot onto the DOM. Passing `null`
     * (or a snapshot with an empty `items` array) tears the panel
     * down entirely — we never render an "empty" placeholder because
     * having the user permanently see a TODO header for sessions
     * that never use the tool would be noise.
     */
    applyState(state: TodoState | null): void {
        if (!state || state.items.length === 0) {
            this.hide();
            return;
        }

        this.currentState = state;
        if (!this.el) {
            this.el = this.parent.createDiv({ cls: 'session-todo-panel' });
        }
        this.render();
    }

    /** Tear the panel down. Idempotent. */
    hide(): void {
        if (this.el) {
            this.el.remove();
            this.el = null;
        }
        this.currentState = null;
        // Reset the fold preference too — switching sessions starts
        // fresh with the default collapsed state.
        this.collapsed = true;
    }

    // ── Internals ───────────────────────────────────────────────────

    private render(): void {
        const block = this.el;
        const state = this.currentState;
        if (!block || !state) return;

        block.empty();
        block.toggleClass('session-todo-panel--collapsed', this.collapsed);

        const completed = state.items.filter(i => i.status === 'completed').length;
        const cancelled = state.items.filter(i => i.status === 'cancelled').length;
        const total = state.items.length;

        // List first, header second — DOM order = visual order in
        // a flex column, so the list ends up ABOVE the header.
        // This realises the "expand upward" gesture: the header
        // stays glued to the input edge while expansion eats space
        // from the message area above.
        //
        // Collapsed mode skips the list element entirely (rather
        // than visibility-hidden) so the panel collapses to its
        // true single-line minimum height with no leftover padding
        // from an empty scroll viewport.
        if (!this.collapsed) {
            const list = block.createDiv({ cls: 'session-todo-panel__list' });
            for (const item of state.items) {
                this.renderItem(list, item);
            }
        }

        this.renderHeader(block, completed + cancelled, total);
    }

    private renderHeader(parent: HTMLElement, done: number, total: number): void {
        // The whole header is the toggle — bigger hit target than a
        // tiny chevron button, and matches the "click anywhere on
        // the bar to collapse" pattern used by other Obsidian panels.
        const header = parent.createDiv({
            cls: 'session-todo-panel__header',
            attr: {
                role: 'button',
                tabindex: '0',
                'aria-expanded': String(!this.collapsed),
            },
        });
        const tip = this.collapsed
            ? t('view.todoPanelExpand')
            : t('view.todoPanelCollapse');
        setTooltip(header, tip);
        header.setAttr('aria-label', tip);

        const titleWrap = header.createDiv({ cls: 'session-todo-panel__title' });
        const titleIcon = titleWrap.createSpan({ cls: 'session-todo-panel__title-icon' });
        setIcon(titleIcon, 'list-checks');
        titleWrap.createSpan({
            cls: 'session-todo-panel__title-label',
            text: t('view.todoPanelTitle'),
        });

        header.createSpan({
            cls: 'session-todo-panel__count',
            text: `${done}/${total}`,
        });

        // Chevron is decorative — the click handler lives on the
        // header itself. Direction follows the bottom-sheet
        // convention: an upward chevron when collapsed (meaning
        // "click to expand upward"), downward when expanded
        // (meaning "click to fold back down toward the input").
        const chevron = header.createSpan({
            cls: 'session-todo-panel__chevron',
        });
        setIcon(chevron, this.collapsed ? 'chevron-up' : 'chevron-down');

        const toggle = () => {
            this.collapsed = !this.collapsed;
            this.render();
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                toggle();
            }
        });
    }

    private renderItem(parent: HTMLElement, item: TodoItem): void {
        const row = parent.createDiv({
            cls: `session-todo-panel__item session-todo-panel__item--${item.status}`,
        });

        const statusIcon = row.createSpan({
            cls: 'session-todo-panel__status',
        });
        setIcon(statusIcon, TodoPanel.iconForStatus(item.status));
        setTooltip(statusIcon, statusLabel(item.status));
        statusIcon.setAttr('aria-label', statusLabel(item.status));

        // The panel renders ONLY `brief` — `content` is the model's
        // long-form scratchpad and would visually overwhelm the
        // pinned list. The model is contractually required to write
        // `brief`, and the SessionManager loader synthesises one for
        // legacy v4 items, so this never silently shows nothing.
        row.createSpan({
            cls: 'session-todo-panel__text',
            text: item.brief,
        });
    }

    private static iconForStatus(status: TodoStatus): string {
        switch (status) {
            case 'pending':
                return 'circle';
            case 'in_progress':
                return 'loader-2';
            case 'completed':
                return 'check-circle-2';
            case 'cancelled':
                return 'x-circle';
        }
    }
}

function statusLabel(status: TodoStatus): string {
    switch (status) {
        case 'pending':
            return t('view.todoStatusPending');
        case 'in_progress':
            return t('view.todoStatusInProgress');
        case 'completed':
            return t('view.todoStatusCompleted');
        case 'cancelled':
            return t('view.todoStatusCancelled');
    }
}
