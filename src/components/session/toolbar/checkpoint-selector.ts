import { App, setIcon, setTooltip, Notice } from 'obsidian';
import { t } from '../../../i18n';
import { DropdownManager } from '../dropdown-manager';
import { CheckpointActionConfirmModal } from '../../../modals/checkpoint-action-confirm-modal';
import type { SessionRuntime } from '../../../services/session-runtime';
import type { Checkpoint, CheckpointFileEntry } from '../../../services/vault';

/**
 * Per-session input-row dropdown that exposes the session's
 * round-grouped vault checkpoints.
 *
 * Each entry shows:
 *   - the round it belongs to (anchored to a user message id; the
 *     "Goto" action scrolls the chat there),
 *   - the list of files mutated in that round,
 *   - the current status (pending / accepted / discarded),
 *   - "Accept" / "Discard" actions on pending entries.
 *
 * The selector is per-VIEW (one instance per SessionView), but it
 * reflects the currently-bound runtime's checkpoint store. Call
 * {@link CheckpointSelectorHandle.setRuntime} on every bind /
 * detach so the button count and dropdown contents stay in sync
 * across session switches.
 *
 * Popup shell uses {@link DropdownManager} + `.session-dropdown`; the
 * trigger is mounted in `.session-checkpoint-row` at the top of the
 * compose card; the open panel is full width and opens **upward** from
 * that row (see checkpoint.less).
 */
export interface CheckpointSelectorOptions {
    app: App;
    /** Scrolls the chat to the message with the given id. */
    onGotoMessage: (messageId: string) => void;
}

export interface CheckpointSelectorHandle {
    /**
     * Bind (or unbind) the runtime whose checkpoint store this
     * selector should reflect. Pass `undefined` when no session is
     * active. Safe to call repeatedly across switches; listeners
     * from the previous runtime are detached cleanly.
     */
    setRuntime(runtime: SessionRuntime | undefined): void;
    /** Detach listeners. Called from SessionView.onClose. */
    dispose(): void;
}

const STATUS_ICON: Record<Checkpoint['status'], string> = {
    pending: 'clock',
    accepted: 'check',
    discarded: 'x',
};

const STATUS_LABEL_KEY: Record<Checkpoint['status'], string> = {
    pending: 'view.checkpointStatusPending',
    accepted: 'view.checkpointStatusAccepted',
    discarded: 'view.checkpointStatusDiscarded',
};

/** True when `accept(id)` would also accept an earlier pending checkpoint. */
function acceptAffectsEarlierPending(checkpoints: readonly Checkpoint[], id: string): boolean {
    const targetIdx = checkpoints.findIndex(c => c.id === id);
    if (targetIdx <= 0) return false;
    for (let i = 0; i < targetIdx; i++) {
        if (checkpoints[i]?.status === 'pending') return true;
    }
    return false;
}

/** True when `discard(id)` would also discard a later pending checkpoint. */
function discardAffectsLaterPending(checkpoints: readonly Checkpoint[], id: string): boolean {
    const targetIdx = checkpoints.findIndex(c => c.id === id);
    if (targetIdx < 0 || targetIdx >= checkpoints.length - 1) return false;
    for (let i = targetIdx + 1; i < checkpoints.length; i++) {
        if (checkpoints[i]?.status === 'pending') return true;
    }
    return false;
}

/** Oldest pending checkpoint in session order (array index ascending). */
function firstPendingCheckpoint(checkpoints: readonly Checkpoint[]): Checkpoint | undefined {
    for (const c of checkpoints) {
        if (c.status === 'pending') return c;
    }
    return undefined;
}

/** Newest pending checkpoint in session order (array index descending). */
function lastPendingCheckpoint(checkpoints: readonly Checkpoint[]): Checkpoint | undefined {
    for (let i = checkpoints.length - 1; i >= 0; i--) {
        const c = checkpoints[i];
        if (c?.status === 'pending') return c;
    }
    return undefined;
}

export function createCheckpointSelector(
    parent: HTMLElement,
    dropdownManager: DropdownManager,
    options: CheckpointSelectorOptions,
): CheckpointSelectorHandle {
    const wrapper = parent.createEl('span', {
        cls: 'session-selector session-checkpoint-selector session-checkpoint-selector--empty',
    });

    const bar = wrapper.createEl('div', { cls: 'session-checkpoint-bar' });
    const openBtn = bar.createEl('button', {
        type: 'button',
        cls: 'session-dropdown-btn session-checkpoint-bar__open',
        attr: { 'aria-label': t('view.checkpointsAriaLabel') },
    });
    const openIcon = openBtn.createEl('span', { cls: 'session-dropdown-btn-icon' });
    setIcon(openIcon, 'list-checks');
    const labelEl = openBtn.createEl('span', {
        cls: 'session-dropdown-btn-text',
    });
    const openArrow = openBtn.createEl('span', { cls: 'session-dropdown-btn-arrow' });
    setIcon(openArrow, 'chevron-up');
    setTooltip(openBtn, t('view.checkpointsAriaLabel'));

    const bulk = bar.createEl('div', { cls: 'session-checkpoint-bar__bulk' });
    const acceptAllBtn = bulk.createEl('button', {
        type: 'button',
        cls: 'session-checkpoint-bar__bulk-btn session-checkpoint-bar__bulk-btn--accept',
        attr: { 'aria-label': t('view.checkpointAcceptAll') },
    });
    setIcon(acceptAllBtn, 'check-check');
    const discardAllBtn = bulk.createEl('button', {
        type: 'button',
        cls: 'session-checkpoint-bar__bulk-btn session-checkpoint-bar__bulk-btn--discard',
        attr: { 'aria-label': t('view.checkpointDiscardAll') },
    });
    setIcon(discardAllBtn, 'trash-2');
    setTooltip(acceptAllBtn, t('view.checkpointAcceptAllHint'));
    setTooltip(discardAllBtn, t('view.checkpointDiscardAllHint'));

    // First token must be `session-dropdown` so DropdownManager's
    // `--open` class matches `.session-dropdown--open` (same as session list).
    const dropdownEl = wrapper.createEl('div', {
        cls: 'session-dropdown session-checkpoint-dropdown',
    });

    let runtime: SessionRuntime | undefined;
    let detachChange: (() => void) | undefined;

    const updateButtonText = () => {
        const cps = runtime?.checkpointStore.checkpoints ?? [];
        const pendingCount = runtime?.checkpointStore.pendingCount
            ?? cps.filter(c => c.status === 'pending').length;
        if (pendingCount === 0) {
            wrapper.addClass('session-checkpoint-selector--empty');
            labelEl.setText('');
            acceptAllBtn.disabled = true;
            discardAllBtn.disabled = true;
            if (dropdownManager.isActive(wrapper)) {
                dropdownManager.closeActive();
            }
            return;
        }
        wrapper.removeClass('session-checkpoint-selector--empty');
        labelEl.setText(t('view.checkpointBarLabel', { count: pendingCount }));
        wrapper.toggleClass('session-checkpoint-selector--has-pending', pendingCount > 0);
        const bulkDisabled = pendingCount === 0 || !runtime;
        acceptAllBtn.disabled = bulkDisabled;
        discardAllBtn.disabled = bulkDisabled;
    };

    /**
     * Match an Obsidian wikilink (`[[path]]` or `[[path|alias]]`) and
     * yield the human-readable text for the title. Renders `alias`
     * when present, otherwise `path`. Keeps the rest of the user
     * message intact.
     */
    const WIKILINK_RE = /\[\[([^|\]\n]+)(?:\|([^\]\n]+))?\]\]/g;

    const formatCheckpointTitle = (cp: Checkpoint): string => {
        // Prefer the user-message text as the title so users recognise
        // the round at a glance. Visual truncation is left to CSS
        // (`text-overflow: ellipsis`); we only collapse whitespace and
        // strip wikilink markup. Fall back to the creation timestamp
        // when the message can't be resolved (e.g. it was deleted by
        // a future regenerate flow).
        if (runtime) {
            const msg = runtime.chat.messages.find(m => m.id === cp.anchorMessageId);
            if (msg && typeof msg.content === 'string' && msg.content.length > 0) {
                return msg.content
                    .replace(WIKILINK_RE, (_m, path: string, alias?: string) => alias ?? path)
                    .replace(/\s+/g, ' ')
                    .trim();
            }
        }
        const d = new Date(cp.createdAt);
        return d.toLocaleTimeString();
    };

    const renderFileEntry = (host: HTMLElement, entry: CheckpointFileEntry): void => {
        const row = host.createEl('div', { cls: 'checkpoint-file' });
        const iconEl = row.createEl('span', { cls: 'checkpoint-file__icon' });
        setIcon(iconEl, entry.kind === 'delete' ? 'trash-2'
            : entry.kind === 'rename' ? 'arrow-right'
            : entry.kind === 'create' ? 'file-plus'
            : 'file-edit');
        const pathEl = row.createEl('span', { cls: 'checkpoint-file__path' });
        if (entry.kind === 'rename' && entry.previousPath) {
            pathEl.setText(`${entry.previousPath} → ${entry.path}`);
        } else {
            pathEl.setText(entry.path);
        }
        setTooltip(pathEl, entry.path);
        const kindEl = row.createEl('span', { cls: 'checkpoint-file__kind', text: entry.kind });
        if (!entry.snapshotId && entry.kind === 'modify') {
            // The pre-edit content couldn't be captured; flag so users
            // know discard won't fully roll back this file.
            kindEl.addClass('checkpoint-file__kind--no-snapshot');
            setTooltip(kindEl, t('view.checkpointNoSnapshot'));
        }
    };

    /**
     * Build one icon-only action button under the title row. Tooltip
     * (Obsidian native) carries the action's display label; the icon
     * itself is a Lucide glyph picked to mirror the action's intent.
     */
    const buildActionIcon = (
        host: HTMLElement,
        icon: string,
        tooltipKey: string,
        modifierCls: string,
        enabled: boolean,
        onActivate: () => void,
    ): HTMLButtonElement => {
        const btn = host.createEl('button', {
            cls: `checkpoint-section__action-btn checkpoint-section__action-btn--${modifierCls}`,
            attr: { type: 'button', 'aria-label': t(tooltipKey) },
        });
        setIcon(btn, icon);
        setTooltip(btn, t(tooltipKey));
        btn.disabled = !enabled;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            onActivate();
        });
        return btn;
    };

    const renderCheckpoint = (host: HTMLElement, cp: Checkpoint): void => {
        const section = host.createEl('div', {
            cls: `session-dropdown-section checkpoint-section checkpoint-section--${cp.status}`,
        });

        // Header row: status badge + title + icon actions, all on one line.
        const header = section.createEl('div', { cls: 'checkpoint-section__header' });
        const statusBadge = header.createEl('span', {
            cls: `checkpoint-section__status checkpoint-section__status--${cp.status}`,
        });
        setIcon(statusBadge, STATUS_ICON[cp.status]);
        setTooltip(statusBadge, t(STATUS_LABEL_KEY[cp.status]));

        const title = header.createEl('span', { cls: 'checkpoint-section__title' });
        title.setText(formatCheckpointTitle(cp));

        const actions = header.createEl('span', { cls: 'checkpoint-section__actions' });

        // Goto is always available — even on terminal checkpoints —
        // because users still want to be able to scroll back to the
        // round that produced an already-accepted/discarded result.
        buildActionIcon(
            actions, 'navigation', 'view.checkpointGoto', 'goto', true,
            () => {
                dropdownManager.closeActive();
                options.onGotoMessage(cp.anchorMessageId);
            },
        );
        buildActionIcon(
            actions, 'check', 'view.checkpointAccept', 'accept',
            cp.status === 'pending',
            () => {
                if (!runtime) return;
                dropdownManager.closeActive();
                void (async () => {
                    const list = runtime.checkpointStore.checkpoints;
                    const needsConfirm = acceptAffectsEarlierPending(list, cp.id);
                    if (needsConfirm) {
                        const confirmed = await new CheckpointActionConfirmModal(
                            options.app,
                            t('view.checkpointAcceptConfirmTitle'),
                            t('view.checkpointAcceptConfirmMessage'),
                            t('view.checkpointAccept'),
                            'accept',
                        ).waitForResult();
                        if (!confirmed) return;
                    }
                    void runtime.checkpointStore.accept(cp.id).catch((err: unknown) => {
                        console.error('[checkpoint-selector] accept failed', err);
                        new Notice(t('view.checkpointActionFailed'));
                    });
                })();
            },
        );
        buildActionIcon(
            actions, 'x', 'view.checkpointDiscard', 'discard',
            cp.status === 'pending',
            () => {
                if (!runtime) return;
                dropdownManager.closeActive();
                void (async () => {
                    const list = runtime.checkpointStore.checkpoints;
                    const needsConfirm = discardAffectsLaterPending(list, cp.id);
                    if (needsConfirm) {
                        const confirmed = await new CheckpointActionConfirmModal(
                            options.app,
                            t('view.checkpointDiscardConfirmTitle'),
                            t('view.checkpointDiscardConfirmMessage'),
                            t('view.checkpointDiscard'),
                            'discard',
                        ).waitForResult();
                        if (!confirmed) return;
                    }
                    void runtime.checkpointStore.discard(cp.id).catch((err: unknown) => {
                        console.error('[checkpoint-selector] discard failed', err);
                        new Notice(t('view.checkpointActionFailed'));
                    });
                })();
            },
        );

        // File list.
        const fileList = section.createEl('div', { cls: 'checkpoint-section__files' });
        if (cp.files.size === 0) {
            fileList.createEl('div', {
                cls: 'checkpoint-section__empty',
                text: t('view.checkpointEmptyFiles'),
            });
        } else {
            for (const entry of cp.files.values()) {
                renderFileEntry(fileList, entry);
            }
        }
    };

    const rebuildDropdown = () => {
        dropdownEl.empty();
        const cps = runtime?.checkpointStore.checkpoints ?? [];
        if (cps.length === 0) {
            dropdownEl.createEl('div', {
                cls: 'session-dropdown__empty',
                text: t('view.checkpointEmpty'),
            });
            return;
        }
        // Newest first reads more naturally — users normally care about
        // the most recent round they just produced.
        for (let i = cps.length - 1; i >= 0; i--) {
            const cp = cps[i];
            if (!cp) continue;
            renderCheckpoint(dropdownEl, cp);
        }
    };

    acceptAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (acceptAllBtn.disabled || !runtime) return;
        const store = runtime.checkpointStore;
        const list = store.checkpoints;
        const target = lastPendingCheckpoint(list);
        if (!target) return;
        dropdownManager.closeActive();
        void (async () => {
            const needsConfirm = acceptAffectsEarlierPending(list, target.id);
            if (needsConfirm) {
                const confirmed = await new CheckpointActionConfirmModal(
                    options.app,
                    t('view.checkpointAcceptConfirmTitle'),
                    t('view.checkpointAcceptConfirmMessage'),
                    t('view.checkpointAccept'),
                    'accept',
                ).waitForResult();
                if (!confirmed) return;
            }
            void store.accept(target.id).catch((err: unknown) => {
                console.error('[checkpoint-selector] accept all failed', err);
                new Notice(t('view.checkpointActionFailed'));
            });
        })();
    });

    discardAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (discardAllBtn.disabled || !runtime) return;
        const store = runtime.checkpointStore;
        const list = store.checkpoints;
        const target = firstPendingCheckpoint(list);
        if (!target) return;
        dropdownManager.closeActive();
        void (async () => {
            const needsConfirm = discardAffectsLaterPending(list, target.id);
            if (needsConfirm) {
                const confirmed = await new CheckpointActionConfirmModal(
                    options.app,
                    t('view.checkpointDiscardConfirmTitle'),
                    t('view.checkpointDiscardConfirmMessage'),
                    t('view.checkpointDiscard'),
                    'discard',
                ).waitForResult();
                if (!confirmed) return;
            }
            void store.discard(target.id).catch((err: unknown) => {
                console.error('[checkpoint-selector] discard all failed', err);
                new Notice(t('view.checkpointActionFailed'));
            });
        })();
    });

    dropdownManager.registerToggle({
        wrapper,
        button: openBtn,
        dropdown: dropdownEl,
        onOpen: rebuildDropdown,
    });

    const handleChange = () => {
        updateButtonText();
        if (dropdownManager.isActive(wrapper)) {
            rebuildDropdown();
        }
    };

    updateButtonText();

    return {
        setRuntime: (next) => {
            if (runtime === next) return;
            detachChange?.();
            detachChange = undefined;
            runtime = next;
            if (runtime) {
                detachChange = runtime.checkpointStore.on('change', handleChange);
            }
            handleChange();
        },
        dispose: () => {
            detachChange?.();
            detachChange = undefined;
            runtime = undefined;
        },
    };
}
