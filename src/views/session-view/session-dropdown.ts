import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { SessionManager } from '../../session-manager';
import { SessionStatusDisplay } from '../../components/session';

export interface SessionDropdownDeps {
    dropdownEl: HTMLElement;
    sessionManager: SessionManager;
    closeDropdown: () => void;
    onSwitchSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string, itemEl: HTMLElement, isActive: boolean) => void;
    /**
     * Optional predicate: whether the given session is currently
     * running a turn in the background runtime pool. Used to render
     * a small "still working" indicator next to that entry so the
     * user can tell which detached sessions are still active.
     */
    isBusy?: (sessionId: string) => boolean;
}

/**
 * Populate the session-switcher dropdown menu with the current list of
 * sessions. Extracted from SessionView.rebuildSessionDropdown.
 */
export function rebuildSessionDropdown(deps: SessionDropdownDeps): void {
    const { dropdownEl, sessionManager } = deps;
    dropdownEl.empty();

    const sessions = sessionManager.getAllSessions();

    if (sessions.length === 0) {
        dropdownEl.createEl('div', { cls: 'session-dropdown__empty', text: t('view.noSessions') });
        return;
    }

    for (const session of sessions) {
        const item = dropdownEl.createEl('div', { cls: 'session-dropdown__item' });
        const isActive = session.id === sessionManager.activeSessionId;
        if (isActive) item.addClass('session-dropdown__item--active');

        const checkIcon = item.createEl('span', { cls: 'session-dropdown__item-check' });
        if (isActive) setIcon(checkIcon, 'check');

        const textWrapper = item.createEl('span', { cls: 'session-dropdown__item-body' });
        // Render the title row. If a background runtime is still
        // turning for this session, prepend a small loader icon so
        // the user can identify which detached sessions are still
        // running.
        const titleRow = textWrapper.createEl('span', { cls: 'session-dropdown__item-text' });
        if (deps.isBusy?.(session.id)) {
            const busyIcon = titleRow.createEl('span', {
                cls: 'session-dropdown__item-busy',
                attr: { 'aria-label': t('view.sessionBusy') },
            });
            setIcon(busyIcon, 'loader');
            setTooltip(busyIcon, t('view.sessionBusy'));
        }
        const displayTitle = session.title || session.firstUserMessage || t('view.newChat');
        titleRow.appendChild(document.createTextNode(displayTitle));

        const metaRow = textWrapper.createEl('span', { cls: 'session-dropdown__item-meta' });
        metaRow.createEl('span', { cls: 'session-dropdown__item-time' })
            .setText(new Date(session.createdAt).toLocaleString());

        // Token usage (prompt / completion). Hidden when no tokens were ever spent.
        const usage = session.tokenUsage;
        if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
            const tokensEl = metaRow.createEl('span', { cls: 'session-dropdown__item-tokens' });
            const promptStr = SessionStatusDisplay.formatCompact(usage.promptTokens);
            const completionStr = SessionStatusDisplay.formatCompact(usage.completionTokens);
            tokensEl.createEl('span', {
                cls: 'session-dropdown__item-token',
                text: `↑${promptStr}`,
            });
            tokensEl.createEl('span', {
                cls: 'session-dropdown__item-token',
                text: `↓${completionStr}`,
            });
            setTooltip(
                tokensEl,
                `${t('statusLabel.prompt')}: ${usage.promptTokens.toLocaleString()}\n` +
                `${t('statusLabel.completion')}: ${usage.completionTokens.toLocaleString()}`,
            );
        }

        // Delete button (shown for all sessions including active)
        const deleteBtn = item.createEl('button', {
            cls: 'session-dropdown__item-delete',
            attr: { 'aria-label': t('view.deleteSession') },
        });
        setIcon(deleteBtn, 'trash-2');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deps.onDeleteSession(session.id, item, isActive);
        });

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            deps.closeDropdown();
            if (!isActive) deps.onSwitchSession(session.id);
        });
    }
}
