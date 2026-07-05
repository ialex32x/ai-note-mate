import { setIcon, setTooltip, Notice } from 'obsidian';
import { t } from '../../../i18n';
import { DropdownManager } from '../dropdown-manager';
import {
    getEligibleTips,
    markTipKnown,
    type TipContext,
    type TipDefinition,
    type TipPreview,
    type TipSessionViewAdapter,
} from '../../../services/tips';
import type NoteAssistantPlugin from 'main';
import {
    invalidateActiveNoteImageCache,
    warmActiveNoteImageCache,
} from '../../../services/tips/builtin/_active-note';
import { TFile } from 'obsidian';

export interface TipsButtonHandle {
    /** Unsubscribe settings listener; safe to call multiple times. */
    dispose(): void;
}

/**
 * Mount the "usage tips" entry on the input toolbar. The button is
 * mounted unconditionally so its position in the row stays stable
 * across settings changes; visibility is controlled by toggling a CSS
 * `display: none` modifier driven from `getEligibleTips().length`.
 *
 * Side effect: subscribes to `plugin.onSettingsChange` to keep the
 * button hidden once the user runs out of eligible tips, and to
 * re-show it should a future change make a tip relevant again. The
 * returned handle exposes `dispose()` to unsubscribe.
 */
export function createTipsButton(
    parent: HTMLElement,
    plugin: NoteAssistantPlugin,
    sessionView: TipSessionViewAdapter,
    dropdownManager: DropdownManager,
): TipsButtonHandle {
    parent.addClass('session-thinking-row--has-tips');
    const wrapper = parent.createSpan({ cls: 'session-selector session-tips' });

    const button = wrapper.createEl('button', {
        cls: 'session-thinking-row__icon-btn session-tips__btn',
        attr: { type: 'button', 'aria-label': t('tips.tooltip') },
    });
    setIcon(button, 'lightbulb');
    setTooltip(button, t('tips.tooltip'));

    // Note: `session-dropdown-menu` MUST be the first class so that
    // DropdownManager derives the `--open` toggle class from it.
    const popover = wrapper.createDiv({
        cls: 'session-dropdown-menu session-tips-popover',
    });

    // Per-render mutable state. Reset every time the popover is opened
    // so navigation always starts at the first eligible tip.
    let tipsView: HTMLElement | null = null;
    let previewView: HTMLElement | null = null;
    let currentList: TipDefinition[] = [];
    let currentIndex = 0;

    const ctx: TipContext = { plugin, sessionView };

    const updateVisibility = (): void => {
        const hasEligible = getEligibleTips(ctx).length > 0;
        wrapper.toggleClass('session-tips--hidden', !hasEligible);
    };

    /**
     * Mark a tip known, run its execute, and close the popover.
     * Centralised so the preview-confirm path and the no-preview
     * direct-Try-it path share identical bookkeeping (mark-first
     * semantics, error Notice, visibility refresh). The caller is
     * responsible for any UI-level guards (streaming, button
     * disabling) — this helper assumes the action is safe to run.
     */
    const runTipFinalize = async (tip: TipDefinition): Promise<void> => {
        const tipId = tip.id;
        try {
            // Mark known FIRST so a failure inside execute doesn't
            // leave the tip eligible to be picked again — per the
            // design, "trying" the tip is itself a completion signal
            // regardless of whether the side effects fully succeed.
            await markTipKnown(plugin, tipId);
            await tip.execute(ctx);
        } catch (err) {
            console.warn(`[tips] execute failed for "${tipId}":`, err);
            new Notice(t('tips.executionFailed'));
        } finally {
            dropdownManager.closeActive();
            updateVisibility();
        }
    };

    /** Fire-and-forget wrapper for tips that skip the preview step. */
    const runTipImmediately = (tip: TipDefinition): void => {
        void runTipFinalize(tip);
    };

    const renderTipsView = (): void => {
        popover.empty();
        tipsView = popover.createDiv({ cls: 'session-tips-popover__view' });
        previewView = null;

        currentList = getEligibleTips(ctx);
        if (currentList.length === 0) {
            tipsView.createDiv({
                cls: 'session-tips-popover__empty',
                text: t('tips.empty'),
            });
            return;
        }

        if (currentIndex >= currentList.length) currentIndex = currentList.length - 1;
        if (currentIndex < 0) currentIndex = 0;

        const tip = currentList[currentIndex]!;

        // ── Header: prev / counter / next ──────────────────────────
        const header = tipsView.createDiv({ cls: 'session-tips-popover__nav' });

        const prevBtn = header.createEl('button', {
            cls: 'session-tips-popover__nav-btn',
            attr: { type: 'button', 'aria-label': t('tips.prev') },
        });
        const prevIcon = prevBtn.createSpan({ cls: 'session-tips-popover__nav-btn-icon' });
        setIcon(prevIcon, 'chevron-left');
        setTooltip(prevBtn, t('tips.prev'));
        prevBtn.disabled = currentList.length <= 1;
        prevBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (currentList.length <= 1) return;
            currentIndex = (currentIndex - 1 + currentList.length) % currentList.length;
            renderTipsView();
        });

        header.createSpan({
            cls: 'session-tips-popover__counter',
            text: `${currentIndex + 1}/${currentList.length}`,
        });

        const nextBtn = header.createEl('button', {
            cls: 'session-tips-popover__nav-btn',
            attr: { type: 'button', 'aria-label': t('tips.next') },
        });
        const nextIcon = nextBtn.createSpan({ cls: 'session-tips-popover__nav-btn-icon' });
        setIcon(nextIcon, 'chevron-right');
        setTooltip(nextBtn, t('tips.next'));
        nextBtn.disabled = currentList.length <= 1;
        nextBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (currentList.length <= 1) return;
            currentIndex = (currentIndex + 1) % currentList.length;
            renderTipsView();
        });

        // ── Body: title + description ───────────────────────────────
        const body = tipsView.createDiv({ cls: 'session-tips-popover__body' });
        body.createDiv({
            cls: 'session-tips-popover__title',
            text: t(tip.titleKey),
        });
        body.createDiv({
            cls: 'session-tips-popover__text',
            text: t(tip.bodyKey),
        });

        // ── Actions: Got it / Try it ────────────────────────────────
        const actions = tipsView.createDiv({ cls: 'session-tips-popover__actions' });

        const gotItBtn = actions.createEl('button', {
            cls: 'session-tips-popover__btn session-tips-popover__btn--secondary',
            attr: { type: 'button' },
            text: t('tips.gotIt'),
        });
        gotItBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Capture the id before the list re-filters underneath us.
            const dismissedId = tip.id;
            void (async () => {
                await markTipKnown(plugin, dismissedId);
                // After dismissal, re-fetch and either advance to the next
                // tip in-place, or close the popover if none remain.
                currentList = getEligibleTips(ctx);
                if (currentList.length === 0) {
                    dropdownManager.closeActive();
                    updateVisibility();
                    return;
                }
                // Hold position so the next tip slides into place under the
                // user's pointer rather than jumping back to index 0.
                if (currentIndex >= currentList.length) {
                    currentIndex = currentList.length - 1;
                }
                renderTipsView();
            })();
        });

        const tryBtn = actions.createEl('button', {
            cls: 'session-tips-popover__btn session-tips-popover__btn--primary',
            attr: { type: 'button' },
        });
        tryBtn.createSpan({
            cls: 'session-tips-popover__btn-label',
            text: t('tips.tryIt'),
        });
        const tryIcon = tryBtn.createSpan({ cls: 'session-tips-popover__btn-icon' });
        setIcon(tryIcon, 'arrow-right');
        tryBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Tips that opted out of the preview step (no `preview`
            // method) run execute directly. Reserved for harmless,
            // self-explanatory actions like opening a settings panel
            // where a confirmation screen would feel like busywork.
            // Streaming is intentionally NOT checked here — those tips
            // don't dispatch chat, so the guard would only block
            // legitimate UI navigation mid-stream.
            if (!tip.preview) {
                runTipImmediately(tip);
                return;
            }
            // Re-build the preview from scratch every time the user enters
            // the preview view so the displayed settings/prompt match the
            // current state (the user may have edited unrelated settings).
            let preview: TipPreview;
            try {
                preview = tip.preview(ctx);
            } catch (err) {
                console.warn(`[tips] preview threw for "${tip.id}":`, err);
                return;
            }
            renderPreviewView(tip, preview);
        });
    };

    const renderPreviewView = (tip: TipDefinition, preview: TipPreview): void => {
        popover.empty();
        previewView = popover.createDiv({ cls: 'session-tips-popover__view session-tips-popover__view--preview' });
        tipsView = null;

        // ── Header: title only ─────────────────────────────────────
        // The action row at the bottom already exposes a "Back" button,
        // so a second arrow up here would just duplicate the affordance
        // and force the user to scan two locations to know how to bail.
        // The CSS centres the lone title within the bordered nav row.
        const header = previewView.createDiv({ cls: 'session-tips-popover__nav' });

        header.createSpan({
            cls: 'session-tips-popover__counter',
            text: t('tips.preview.title'),
        });

        // ── Body: description + settings changes + prompt preview ──
        const body = previewView.createDiv({ cls: 'session-tips-popover__body' });
        body.createDiv({
            cls: 'session-tips-popover__preview-desc',
            text: preview.description,
        });

        if (preview.settingsChanges && preview.settingsChanges.length > 0) {
            const section = body.createDiv({ cls: 'session-tips-popover__preview-section' });
            section.createDiv({
                cls: 'session-tips-popover__preview-header',
                text: t('tips.preview.settingsHeader'),
            });
            const list = section.createDiv({
                cls: 'session-tips-popover__preview-changes',
            });
            for (const change of preview.settingsChanges) {
                const row = list.createDiv({ cls: 'session-tips-popover__preview-change' });
                row.createSpan({
                    cls: 'session-tips-popover__preview-change-label',
                    text: change.label,
                });
                const valueWrap = row.createSpan({
                    cls: 'session-tips-popover__preview-change-value',
                });
                if (change.before !== undefined && change.before.length > 0) {
                    valueWrap.createSpan({
                        cls: 'session-tips-popover__preview-change-before',
                        text: change.before,
                    });
                    const arrowEl = valueWrap.createSpan({
                        cls: 'session-tips-popover__preview-change-arrow',
                    });
                    setIcon(arrowEl, 'arrow-right');
                }
                valueWrap.createSpan({
                    cls: 'session-tips-popover__preview-change-after',
                    text: change.after,
                });
            }
        }

        if (preview.prompt && preview.prompt.length > 0) {
            const section = body.createDiv({ cls: 'session-tips-popover__preview-section' });
            section.createDiv({
                cls: 'session-tips-popover__preview-header',
                text: t('tips.preview.promptHeader'),
            });
            section.createEl('pre', {
                cls: 'session-tips-popover__preview-prompt',
                text: preview.prompt,
            });
        }

        // ── Actions: cancel / confirm ───────────────────────────────
        const actions = previewView.createDiv({ cls: 'session-tips-popover__actions' });

        const cancelBtn = actions.createEl('button', {
            cls: 'session-tips-popover__btn session-tips-popover__btn--secondary',
            attr: { type: 'button' },
            text: t('tips.preview.cancel'),
        });
        cancelBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            renderTipsView();
        });

        const confirmBtn = actions.createEl('button', {
            cls: 'session-tips-popover__btn session-tips-popover__btn--primary',
            attr: { type: 'button' },
            text: t('tips.preview.confirm'),
        });
        // Disable confirm while a turn is streaming — running `execute`
        // now would either silently drop the prompt or throw "already
        // streaming" from inside chat.prompt(). Mirror the same guard
        // ChatAgent uses elsewhere.
        const streaming = sessionView.isStreaming();
        if (streaming) {
            confirmBtn.disabled = true;
            setTooltip(confirmBtn, t('tips.preview.streamingBlocked'));
        }
        confirmBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (sessionView.isStreaming()) {
                new Notice(t('tips.preview.streamingBlocked'));
                return;
            }
            confirmBtn.disabled = true;
            void runTipFinalize(tip);
        });
    };

    dropdownManager.registerToggle({
        wrapper,
        button,
        dropdown: popover,
        onOpen: () => {
            // Re-fetch every open so list reflects fresh settings, and
            // reset to the first tip so navigation feels predictable.
            currentIndex = 0;
            renderTipsView();
        },
        onClose: () => {
            // Drop the body so a re-open re-renders fresh state.
            popover.empty();
            tipsView = null;
            previewView = null;
        },
    });

    const refreshActiveNoteCacheAndVisibility = (): void => {
        void warmActiveNoteImageCache(plugin.app).then(() => {
            updateVisibility();
            if (!dropdownManager.isActive(wrapper) || previewView) return;
            renderTipsView();
        });
    };

    const onSettingsChanged = () => {
        // Refresh button visibility on every settings change so the
        // button hides as soon as the user completes the last eligible
        // tip (via Try it) and re-shows if conditions change again
        // (e.g. the user clears their skill paths in settings).
        updateVisibility();
        // If the popover is currently open, rebuild its content so the
        // user sees the updated list without having to reopen.
        if (dropdownManager.isActive(wrapper)) {
            if (previewView) {
                // Stay on the preview — the user is mid-confirm, jerking
                // them back to the list would be jarring. The preview
                // doesn't read the eligibility list anyway.
                return;
            }
            renderTipsView();
        }
    };
    plugin.onSettingsChange(onSettingsChanged);

    const onActiveNoteContextChanged = (): void => {
        invalidateActiveNoteImageCache();
        refreshActiveNoteCacheAndVisibility();
    };
    const onVaultModify = (file: TFile): void => {
        if (file.path !== plugin.app.workspace.getActiveFile()?.path) return;
        invalidateActiveNoteImageCache();
        refreshActiveNoteCacheAndVisibility();
    };

    const activeLeafRef = plugin.app.workspace.on('active-leaf-change', onActiveNoteContextChanged);
    const fileOpenRef = plugin.app.workspace.on('file-open', onActiveNoteContextChanged);
    const vaultModifyRef = plugin.app.vault.on('modify', onVaultModify);

    void warmActiveNoteImageCache(plugin.app).then(() => updateVisibility());

    return {
        dispose: () => {
            plugin.offSettingsChange(onSettingsChanged);
            plugin.app.workspace.offref(activeLeafRef);
            plugin.app.workspace.offref(fileOpenRef);
            plugin.app.vault.offref(vaultModifyRef);
            invalidateActiveNoteImageCache();
        },
    };
}
