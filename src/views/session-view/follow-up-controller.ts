import { App } from 'obsidian';
import NoteAssistantPlugin from 'main';
import { ChatMessage, IChatAgent } from '../../services/chat-stream';
import { extractSuggestions, type SuggestedAction } from '../../services/suggestions';
import { resolveLinkOpenText } from '../../utils/workspace-utils';
import { FollowUpBar } from '../../components/session';
import { ScrollController } from './scroll-controller';
import { BubbleListController } from './bubble-list-controller';

export interface FollowUpControllerDeps {
    app: App;
    plugin: NoteAssistantPlugin;
    followUpBar: FollowUpBar;
    bubbleList: BubbleListController;
    scroller: ScrollController;
    getChat: () => IChatAgent | undefined;
    sendPrompt: (text: string) => Promise<void>;
    getStreaming: () => boolean;
}

/**
 * Owns the deterministic follow-up suggestion bar: extraction from the
 * tail assistant reply, click handling (client actions vs prompt-based
 * picks), and client-side action dispatch.
 */
export class FollowUpController {
    private readonly deps: FollowUpControllerDeps;

    constructor(deps: FollowUpControllerDeps) {
        this.deps = deps;
    }

    /**
     * Inspect the most recent assistant reply and, if it contains proposed
     * next actions (a plain-text follow-up list), render them as one-shot
     * quick-pick buttons at the tail of the message list.
     *
     * This is the heuristic (instant) path only. The LLM-backed fallback
     * runs in the runtime and arrives through the `suggestion-update` event →
     * {@link SessionRuntimeBinder.renderSuggestionFromRuntimeState}.
     */
    maybeShowFollowUpSuggestions(): void {
        if (!this.deps.followUpBar) return;
        const settings = this.deps.plugin.settings;
        if (!settings.followUpSuggestionsEnabled) {
            this.deps.followUpBar.hide();
            return;
        }

        const messages = this.deps.getChat()?.messages ?? [];
        // Scan from the tail for the last non-aborted assistant message.
        let target: ChatMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m) continue;
            if (m.role === 'assistant' && !m.streaming && m.content) {
                if (this.deps.bubbleList.isInterrupted(m)) break;
                target = m;
                break;
            }
            // Stop scanning if we already left the tail of the current turn.
            if (m.role === 'user') break;
        }
        if (!target) {
            this.deps.followUpBar.hide();
            return;
        }

        const actions = extractSuggestions(target.content, {});
        if (actions.length === 0) {
            this.deps.followUpBar.hide();
            return;
        }

        this.deps.followUpBar.show(target.id, actions);
        // When auto-follow is parked (last message was oversized and
        // the user is reading), do NOT yank the view to the tail just
        // because the follow-up bar appeared.  Respect the user's
        // current reading position.
        if (!this.deps.scroller.isAutoFollowParked()) {
            this.deps.scroller.maybeScrollToBottom();
        }
    }

    /**
     * Handle a click on a follow-up suggestion button.
     *
     * Behavior:
     * - If the suggestion carries a client-side `action` (e.g. `open-note`),
     *   try to execute it directly. On success we stop there — the action is
     *   self-explanatory and does not require a chat turn.
     * - If the client action cannot be carried out (unknown kind, note not
     *   found in the vault, ...), we transparently fall back to the default
     *   prompt-based flow so the user still gets a useful response.
     * - Default flow: send the picked prompt directly without touching the
     *   input editor. Follow-up picks are self-contained and must preserve
     *   any user draft already in progress.
     */
    handleFollowUpPick(action: SuggestedAction): void {
        // Client-side actions (e.g. open-note) don't start a chat turn, so
        // they're always safe — even mid-stream.
        if (action.action && this.tryRunClientAction(action.action)) {
            return;
        }
        // Prompt-based picks start a new turn. In the normal single-view flow
        // the bar can't be visible while streaming (it only renders on
        // `finish`), but a bar can linger from a previous turn when another
        // view (re)starts a stream on a SHARED runtime. Guard so chat.prompt's
        // concurrency check doesn't throw an unhandled rejection, and dismiss
        // the now-stale bar so the UI self-corrects. Mirrors the same guard on
        // the continue-after-error action.
        if (this.deps.getStreaming()) {
            this.deps.followUpBar?.hide();
            return;
        }
        void this.deps.sendPrompt(action.prompt);
    }

    /**
     * Attempt to execute a client-side suggestion action. Returns `true` when
     * the action was carried out (caller should stop), `false` when the
     * caller should fall back to the prompt-based flow.
     *
     * Kept small and synchronous on purpose — each branch is expected to be a
     * thin wrapper around an Obsidian API call. When more kinds are added,
     * split this into a dispatcher module under `services/suggestions/`.
     */
    private tryRunClientAction(action: NonNullable<SuggestedAction['action']>): boolean {
        switch (action.kind) {
            case 'open-note': {
                void this.deps.app.workspace.openLinkText(
                    resolveLinkOpenText(this.deps.app, action.path),
                    '',
                    false,
                );
                return true;
            }
            default:
                // Exhaustiveness: unknown kinds fall back to prompt flow.
                return false;
        }
    }
}
