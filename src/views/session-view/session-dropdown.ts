import { setIcon, setTooltip } from 'obsidian';
import { t } from '../../i18n';
import type { SessionManager } from '../../session-manager';
import { formatCompact } from '../../utils/format';

/**
 * Lifecycle status of a session as reflected in the runtime pool.
 *
 * - `unloaded`        : pure history record, no live runtime in memory.
 * - `idle`            : runtime instantiated but not currently turning.
 * - `busy`            : runtime is mid-turn (streaming / tool calls).
 * - `awaitingConfirm` : runtime paused on a tool-call confirmation prompt.
 */
export type SessionRuntimeStatus =
    | 'unloaded'
    | 'idle'
    | 'busy'
    | 'awaitingConfirm';

export interface SessionDropdownDeps {
    dropdownEl: HTMLElement;
    sessionManager: SessionManager;
    closeDropdown: () => void;
    onSwitchSession: (sessionId: string) => void;
    onDeleteSession: (sessionId: string, itemEl: HTMLElement, isActive: boolean) => void;
    /**
     * Resolve the current runtime-pool status for a session. Used to
     * render a small status icon below the active-check on each entry
     * so the user can tell at a glance which sessions are loaded /
     * busy / waiting for confirmation.
     */
    getStatus?: (sessionId: string) => SessionRuntimeStatus;
    /**
     * Resolve the pending-checkpoint count for a session. When > 0
     * the dropdown renders a small icon+number badge to the left of
     * the title so the user can spot sessions that still hold
     * unresolved vault edits. Captured once at render time — the
     * dropdown does not subscribe to checkpoint-store changes.
     */
    getPendingCheckpoints?: (sessionId: string) => number;
}

interface StatusIconSpec {
    icon: string;
    tooltipKey:
        | 'view.sessionStatusUnloaded'
        | 'view.sessionStatusIdle'
        | 'view.sessionStatusBusy'
        | 'view.sessionStatusAwaitingConfirm';
    cls: string;
}

const STATUS_ICONS: Record<SessionRuntimeStatus, StatusIconSpec> = {
    unloaded: {
        icon: 'archive',
        tooltipKey: 'view.sessionStatusUnloaded',
        cls: 'session-dropdown__item-status--unloaded',
    },
    idle: {
        icon: 'circle',
        tooltipKey: 'view.sessionStatusIdle',
        cls: 'session-dropdown__item-status--idle',
    },
    busy: {
        icon: 'loader',
        tooltipKey: 'view.sessionStatusBusy',
        cls: 'session-dropdown__item-status--busy',
    },
    awaitingConfirm: {
        icon: 'help-circle',
        tooltipKey: 'view.sessionStatusAwaitingConfirm',
        cls: 'session-dropdown__item-status--awaiting-confirm',
    },
};

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

        // Left column: stacks the runtime status icon on top of the
        // active-check. Both slots are always rendered so column width
        // stays stable regardless of which session is active or which
        // runtimes are warm.
        const iconCol = item.createEl('span', { cls: 'session-dropdown__item-icons' });

        const status = deps.getStatus?.(session.id) ?? 'unloaded';
        const statusSpec = STATUS_ICONS[status];
        const statusIcon = iconCol.createEl('span', {
            cls: `session-dropdown__item-status ${statusSpec.cls}`,
        });
        setIcon(statusIcon, statusSpec.icon);
        const statusTooltip = t(statusSpec.tooltipKey);
        setTooltip(statusIcon, statusTooltip);
        statusIcon.setAttr('aria-label', statusTooltip);

        const checkIcon = iconCol.createEl('span', { cls: 'session-dropdown__item-check' });
        if (isActive) setIcon(checkIcon, 'check');

        const textWrapper = item.createEl('span', { cls: 'session-dropdown__item-body' });
        const titleRow = textWrapper.createEl('span', { cls: 'session-dropdown__item-text' });

        // Optional pending-checkpoint badge (icon + count). Sits to the
        // LEFT of the title so it never gets clipped by the title's
        // ellipsis. Hidden entirely when there are no pending checkpoints
        // — see `getPendingCheckpoints` contract.
        const pendingCount = deps.getPendingCheckpoints?.(session.id) ?? 0;
        if (pendingCount > 0) {
            const pendingEl = titleRow.createEl('span', {
                cls: 'session-dropdown__item-pending-checkpoints',
            });
            const pendingIcon = pendingEl.createEl('span', {
                cls: 'session-dropdown__item-pending-checkpoints-icon',
            });
            setIcon(pendingIcon, 'list-checks');
            pendingEl.createEl('span', {
                cls: 'session-dropdown__item-pending-checkpoints-count',
                text: String(pendingCount),
            });
            const pendingTooltip = t('view.sessionPendingCheckpoints', { count: pendingCount });
            setTooltip(pendingEl, pendingTooltip);
            pendingEl.setAttr('aria-label', pendingTooltip);
        }

        const titleEl = titleRow.createEl('span', { cls: 'session-dropdown__item-title' });
        const displayTitle = session.title || session.firstUserMessage || t('view.newChat');
        titleEl.setText(displayTitle);

        const metaRow = textWrapper.createEl('span', { cls: 'session-dropdown__item-meta' });
        const d = new Date(session.createdAt);
        const dateStr = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        metaRow.createEl('span', { cls: 'session-dropdown__item-time' })
            .setText(dateStr);

        // Token usage (prompt / completion). Hidden when no tokens were ever spent.
        const usage = session.tokenUsage;
        if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
            const tokensEl = metaRow.createEl('span', { cls: 'session-dropdown__item-time' });
            const promptStr = formatCompact(usage.promptTokens);
            const completionStr = formatCompact(usage.completionTokens);
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

        // Session ID
        const sessionIdEl = metaRow.createEl('span', { cls: 'session-dropdown__item-time' });
        sessionIdEl.setText(session.id);

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
