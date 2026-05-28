import { setIcon, setTooltip } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { createCopyButton } from '../../utils/copy-button';
import type { BubbleContext } from './bubble-context';
import { SpeechController } from './speech-controller';

/**
 * Render a minimal action bar for a user message bubble.
 *
 * Provides Copy and (optionally) Branch-from-here actions — the two
 * operations that were previously exposed only via right-click context menu.
 * The bar uses the same hover-driven reveal pattern as the assistant
 * action bar: hidden until the bubble is hovered.
 *
 * @param bubble    The user bubble element to append the action bar into.
 * @param msg       The user message whose content is used for copy/branch.
 * @param onBranch  Optional callback invoked when "Branch from here" is
 *                  clicked. When omitted the button is not rendered.
 */
export function renderUserActionBar(
    bubble: HTMLElement,
    msg: ChatMessage,
    onBranch?: (msg: ChatMessage) => void,
): void {
    const actions = bubble.createEl('div', { cls: 'session-bubble__actions' });

    // Copy button — reuses createCopyButton for consistent flash-feedback
    const copyBtn = createCopyButton(
        t('common.copy'),
        () => msg.content,
        'session-icon-btn session-bubble__action-btn',
    );
    actions.appendChild(copyBtn);

    // Branch button — only shown when the host has wired a branch handler
    if (onBranch) {
        const branchBtn = actions.createEl('button', {
            cls: 'session-icon-btn session-bubble__action-btn',
            attr: {
                'aria-label': t('view.branchFromHere'),
                type: 'button',
            },
        });
        setIcon(branchBtn, 'git-branch');
        setTooltip(branchBtn, t('view.branchFromHere'));
        branchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            onBranch(msg);
        });
    }
}

/**
 * Options passed alongside the shared {@link BubbleContext} when rendering
 * an assistant action bar.
 *
 * These fields are intentionally *not* part of `BubbleContext`: they are
 * specific to the action bar and have no reason to be visible to the rest
 * of the bubble sub-modules. Keeping them local avoids widening the shared
 * context surface area unnecessarily.
 */
export interface ActionBarOptions {
    /** Message IDs that were aborted mid-stream; controls the stopped label / insights gating. */
    abortedMessageIds: Set<string>;
    /**
     * Owner of the Web Speech state. The action bar asks it to mount the
     * speak + voice-picker control inline; the renderer still holds the
     * reference so it can cancel playback on unload.
     */
    speechController: SpeechController;
    /**
     * Host-provided callback to trigger a one-shot insight extraction for
     * this particular assistant message. When omitted, the insights action
     * is not rendered at all.
     */
    onExtractInsights?: (msg: ChatMessage) => void;
    /**
     * When true, the runtime is actively producing output (streaming or
     * waiting on tool calls). The insights button is suppressed during
     * this window so the user doesn't trigger an extraction while the
     * conversation is still in-flight.
     */
    isBusy?: boolean;
}

/**
 * Render the footer action bar for an assistant bubble (copy / speak /
 * extract-insights / aborted indicator).
 *
 * Kept as a plain function: there is no cross-call state worth owning —
 * the one stateful concern (TTS) already lives inside {@link SpeechController},
 * and the copy button's short-lived "✓" feedback is self-contained on the
 * element via `setTimeout`.
 */
export function renderActionBar(
    _ctx: BubbleContext,
    bubble: HTMLElement,
    msg: ChatMessage,
    opts: ActionBarOptions
): void {
    const { abortedMessageIds, speechController, onExtractInsights } = opts;
    const actions = bubble.createEl('div', { cls: 'session-bubble__actions' });

    // Copy button — uses unified createCopyButton for consistent flash-feedback
    const copyBtn = createCopyButton(t('common.copy'), () => msg.content, 'session-icon-btn session-bubble__action-btn');
    actions.appendChild(copyBtn);

    // Speak button group
    if (SpeechController.isSupported()) {
        speechController.renderSpeakButtonGroup(actions, msg.content);
    }

    // Extract-insights button — only meaningful for non-aborted replies
    // when a host callback is wired and the runtime is not busy.
    // Mirrors Copy/Speak as a plain icon button (rather than a menu) to
    // stay consistent with the rest of the action bar and remain
    // tap-friendly on mobile.
    if (onExtractInsights && !abortedMessageIds.has(msg.id) && !opts.isBusy) {
        const insightBtn = actions.createEl('button', {
            cls: 'session-icon-btn session-bubble__action-btn',
            attr: {
                'aria-label': t('view.extractInsights'),
                type: 'button',
            },
        });
        setIcon(insightBtn, 'lightbulb');
        setTooltip(insightBtn, t('view.extractInsights'));
        insightBtn.addEventListener('click', () => {
            onExtractInsights(msg);
        });
    }

    // Aborted indicator
    if (abortedMessageIds.has(msg.id)) {
        actions.createEl('span', {
            cls: 'session-bubble__abort-label',
            text: t('view.responseStopped'),
        });
    }
}
