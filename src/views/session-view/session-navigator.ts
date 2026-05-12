import { App, Notice, setIcon } from 'obsidian';
import { t } from '../../i18n';
import type { SessionManager } from '../../session-manager';
import type { DropdownManager } from '../../components/session';
import { DeleteHistoryConfirmModal } from '../../modals/delete-history-confirm-modal';
import { rebuildSessionDropdown, type SessionRuntimeStatus } from './session-dropdown';

/**
 * Dependencies the navigator needs from the host SessionView.
 *
 * Kept intentionally narrow: anything that touches view-internal state
 * (chat lifecycle, message DOM, draft controllers, etc.) is exposed as a
 * callback rather than a direct reference, so the navigator does not get
 * tangled into the view's session-switching state machine.
 */
export interface SessionNavigatorDeps {
    app: App;
    sessionManager: SessionManager;
    dropdownManager: DropdownManager;
    /**
     * Whether the currently-attached session is mid-turn. Used purely
     * for UI hints (no longer blocks deletion — deletion of a busy
     * session forcibly aborts via `evictRuntime`).
     */
    isStreaming: () => boolean;
    /**
     * Resolve the runtime-pool status for the given (possibly
     * background) session. Used by the dropdown to render a small
     * status icon — distinguishing serialized-only sessions from
     * loaded/idle/busy/awaiting-confirm runtimes.
     */
    getSessionStatus: (sessionId: string) => SessionRuntimeStatus;
    /**
     * Forcefully tear down a SessionRuntime in the pool, aborting its
     * chat regardless of busy state. Called on explicit user deletion.
     */
    evictRuntime: (sessionId: string) => void;
    /**
     * Clear the active session's draft save timer. Called before deleting
     * the active session so the draft is not flushed to a session that's
     * about to disappear.
     */
    clearActiveDraftTimer: () => void;
    /**
     * Switch to the given session. The view owns the full switch pipeline
     * (detach + clearViewDOM + bindActiveSessionRuntime + isSwitchingSession
     * guard), so we just delegate.
     */
    onSwitchSession: (sessionId: string) => void;
    /**
     * Called after the *active* session was deleted and the SessionManager
     * has already promoted a new active session. The view should rebind
     * to whichever session is now active.
     */
    onActiveSessionDeleted: () => Promise<void>;
}

/**
 * Encapsulates the toolbar's session-switcher UI on the left:
 *   [📋 Sessions ▼]  [⋮ More actions ▼]
 *
 * Responsibilities:
 *   - Build the DOM (button group, dropdown panel, more-actions menu)
 *   - Rebuild the session list on demand
 *   - Hide both buttons when there's only one session
 *   - Handle "delete one session" (from the dropdown) and
 *     "delete all history sessions" (from the more-actions menu)
 *
 * Out of scope (stays in SessionView):
 *   - Switching between sessions (clearView/restoreSessionUI pipeline)
 *   - The new-chat button on the right
 *   - The session search modal
 *   - Token-usage status display
 */
export class SessionNavigator {
    private readonly deps: SessionNavigatorDeps;

    private sessionBtn: HTMLButtonElement | null = null;
    private moreActionsBtn: HTMLButtonElement | null = null;
    private dropdownEl: HTMLElement | null = null;

    constructor(deps: SessionNavigatorDeps) {
        this.deps = deps;
    }

    /**
     * Build the navigator DOM into `parent` and wire up dropdown toggles.
     * Mirrors the exact markup the view used to create inline.
     */
    mount(parent: HTMLElement): void {
        const sessionWrapper = parent.createEl('span', {
            cls: 'session-selector session-session-selector',
        });
        const sessionBtnGroup = sessionWrapper.createEl('span', {
            cls: 'session-toolbar__btn-group',
        });

        // Primary button: opens the session list dropdown.
        const sessionBtn = sessionBtnGroup.createEl('button', {
            cls: 'session-toolbar__btn session-toolbar__session-btn',
            attr: { 'aria-label': t('view.switchSession') },
        });
        setIcon(sessionBtn, 'list');
        this.sessionBtn = sessionBtn;

        const dropdownEl = sessionWrapper.createEl('div', {
            cls: 'session-dropdown',
        });
        this.dropdownEl = dropdownEl;

        this.deps.dropdownManager.registerToggle({
            wrapper: sessionWrapper,
            button: sessionBtn,
            dropdown: dropdownEl,
            onOpen: () => this.rebuildDropdown(),
        });

        // Secondary button: opens the more-actions menu (delete history).
        const moreActionsBtn = sessionBtnGroup.createEl('button', {
            cls: 'session-toolbar__btn session-toolbar__btn--dropdown',
            attr: { 'aria-label': t('view.moreSessionActions') },
        });
        setIcon(moreActionsBtn, 'chevron-down');
        this.moreActionsBtn = moreActionsBtn;

        const moreActionsDropdown = sessionBtnGroup.createEl('div', {
            cls: 'session-dropdown-menu session-dropdown-menu--toolbar',
        });

        const deleteHistoryItem = moreActionsDropdown.createEl('div', {
            cls: 'session-dropdown-item',
        });
        const deleteIcon = deleteHistoryItem.createEl('span', {
            cls: 'session-dropdown-item__icon',
        });
        setIcon(deleteIcon, 'trash-2');
        deleteHistoryItem.createEl('span', { text: t('view.deleteHistorySessions') });
        deleteHistoryItem.addEventListener('click', () => {
            this.deps.dropdownManager.closeActive();
            void this.handleDeleteHistorySessions();
        });

        this.deps.dropdownManager.registerToggle({
            wrapper: sessionBtnGroup,
            button: moreActionsBtn,
            dropdown: moreActionsDropdown,
            onOpen: () => {
                // DropdownManager automatically closes other active dropdowns
            },
        });
    }

    /**
     * Repopulate the session list dropdown from the current SessionManager
     * state. Safe to call when the dropdown is closed (the contents will be
     * ready when it's next opened).
     */
    rebuildDropdown(): void {
        if (!this.dropdownEl) return;
        rebuildSessionDropdown({
            dropdownEl: this.dropdownEl,
            sessionManager: this.deps.sessionManager,
            closeDropdown: () => this.deps.dropdownManager.closeActive(),
            onSwitchSession: (id) => this.deps.onSwitchSession(id),
            onDeleteSession: (id, itemEl, isActive) => {
                void this.handleDeleteSession(id, itemEl, isActive);
            },
            getStatus: (id) => this.deps.getSessionStatus(id),
        });
    }

    /**
     * Show or hide the session-switcher buttons based on session count.
     * With only one session there's nothing to switch between, so both the
     * primary list button and the more-actions chevron are hidden.
     */
    updateButtonVisibility(): void {
        const shouldShow = this.deps.sessionManager.sessionCount > 1;
        if (this.sessionBtn) {
            this.sessionBtn.style.display = shouldShow ? '' : 'none';
        }
        if (this.moreActionsBtn) {
            this.moreActionsBtn.style.display = shouldShow ? '' : 'none';
        }
    }

    // ── Internal handlers ───────────────────────────────────────────────

    private async handleDeleteSession(
        sessionId: string,
        itemEl: HTMLElement,
        isActive: boolean,
    ): Promise<void> {
        // Streaming no longer blocks deletion — we forcibly evict the
        // runtime which aborts its chat. This is consistent with the
        // user's intent ("delete this session") even if a background
        // turn is still in progress.
        this.deps.evictRuntime(sessionId);

        // Clear draft save timer before deleting (draft will be lost with the session)
        if (isActive) {
            this.deps.clearActiveDraftTimer();
        }

        const newActiveId = await this.deps.sessionManager.deleteSession(sessionId);
        if (newActiveId === undefined) {
            // Delete failed (session not found)
            return;
        }

        // Remove from dropdown with animation
        itemEl.addClass('session-dropdown__item--deleting');
        setTimeout(() => {
            itemEl.remove();
            this.updateButtonVisibility();
            // Show empty placeholder if the list became empty
            if (
                this.dropdownEl &&
                this.dropdownEl.querySelectorAll('.session-dropdown__item').length === 0
            ) {
                this.dropdownEl.createEl('div', {
                    cls: 'session-dropdown__empty',
                    text: t('view.noSessions'),
                });
            }
        }, 200);

        // If deleted session was active, switch to the new active session
        if (isActive && newActiveId !== null) {
            this.deps.dropdownManager.closeActive();
            await this.deps.sessionManager.ensureActiveMessagesLoaded();
            await this.deps.onActiveSessionDeleted();
        }

        new Notice(t('view.sessionDeleted'));
    }

    private async handleDeleteHistorySessions(): Promise<void> {
        // Check if there are any sessions to delete (excluding current)
        const allSessions = this.deps.sessionManager.getAllSessions();
        const activeId = this.deps.sessionManager.activeSessionId;
        const historySessions = allSessions.filter(s => s.id !== activeId);
        const historySessionsCount = historySessions.length;

        if (historySessionsCount === 0) {
            new Notice(t('view.noHistorySessionsToDelete'));
            return;
        }

        const confirmed = await new DeleteHistoryConfirmModal(
            this.deps.app,
            historySessionsCount,
        ).waitForResult();
        if (!confirmed) return;

        // Forcibly evict every soon-to-be-deleted runtime first. Doing
        // this before the disk delete means a background turn can't
        // race in another saveSession() call after the metadata is
        // already gone.
        for (const s of historySessions) {
            this.deps.evictRuntime(s.id);
        }

        try {
            const deletedCount = await this.deps.sessionManager.deleteAllHistorySessions();

            if (deletedCount > 0) {
                new Notice(t('view.historySessionsDeleted', { count: deletedCount }));
                this.updateButtonVisibility();

                // Rebuild dropdown if it's currently open
                if (
                    this.dropdownEl &&
                    this.dropdownEl.classList.contains('session-dropdown--open')
                ) {
                    this.rebuildDropdown();
                }
            } else {
                new Notice(t('view.noHistorySessionsDeleted'));
            }
        } catch (error) {
            console.error('Failed to delete history sessions:', error);
            new Notice(t('view.deleteHistorySessionsFailed'));
        }
    }
}
