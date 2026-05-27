import { setIcon, setTooltip } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';
import { t } from '../../i18n';
import { copyToClipboard } from '../../utils/clipboard';
import type { BubbleContext } from './bubble-context';
import { SpeechController } from './speech-controller';

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

    // Copy button
    const copyBtn = actions.createEl('button', {
        cls: 'session-icon-btn session-bubble__action-btn',
        attr: { 'aria-label': t('common.copy') },
    });
    setIcon(copyBtn, 'copy');
    copyBtn.addEventListener('click', () => void onCopy(copyBtn, msg.content));

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

/**
 * Write the bubble's content to the clipboard and flash a check-mark on
 * the copy button as confirmation. The original `copy` icon is restored
 * after a short delay so a subsequent copy still reads as a fresh action.
 *
 * No success Notice is shown — the icon flip is the feedback. Failures
 * are logged by `copyToClipboard` and swallowed so we don't tear down the
 * bubble if clipboard access is denied.
 */
async function onCopy(copyBtn: HTMLButtonElement, content: string): Promise<void> {
    const ok = await copyToClipboard(content, { showNotice: false });
    if (!ok) return;
    setIcon(copyBtn, 'check');
    window.setTimeout(() => {
        setIcon(copyBtn, 'copy');
    }, 1500);
}
