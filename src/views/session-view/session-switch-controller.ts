import { Notice } from 'obsidian';
import NoteAssistantPlugin from 'main';
import { t } from '../../i18n';
import { ChatMessage } from '../../services/chat-stream';
import { SessionManager } from '../../session-manager';
import { SessionSearchResult } from '../../modals/session-search-modal';
import { DraftInputController } from '../../components/session';
import { CMInput } from '../../components/cm-input';
import { SessionRuntimeBinder } from './session-runtime-binder';

export interface SessionSwitchControllerDeps {
    plugin: NoteAssistantPlugin;
    sessionManager: SessionManager;
    runtimeBinder: SessionRuntimeBinder;
    draftController: DraftInputController;
    cmInput: CMInput;
    /** Scroll to a message by id (from P6 HistoryLoader; late-bound). */
    scrollToMessage: (id: string) => Promise<void>;
}

/**
 * Owns the session new/switch/branch/search-navigation flows and the
 * concurrency guard that serializes them. The active-switch flag lives
 * here (it is only written by these flows); other modules read it
 * through {@link guardSwitchSession}.
 */
export class SessionSwitchController {
    private readonly deps: SessionSwitchControllerDeps;

    /** Flag to prevent concurrent session switches. */
    private isSwitchingSession = false;

    constructor(deps: SessionSwitchControllerDeps) {
        this.deps = deps;
    }

    /**
     * Convenience guard for callers: returns `true` if a session
     * switch is currently possible, otherwise emits a Notice and returns
     * `false`.
     */
    guardSwitchSession(): boolean {
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return false;
        }
        return true;
    }

    /**
     * Create a new session, persisting the current one and switching the
     * view to a fresh, empty chat.
     *
     * Returns `false` if the operation could not run because another
     * switch is in progress; in that case a Notice has already been shown
     * to the user. Returns `true` after a successful switch.
     *
     * NOTE: if the OLD session was streaming, its runtime is retained in
     * the pool so the background turn finishes and persists into its
     * own session file. See SessionRuntimePool for retention rules.
     */
    async startNewSession(): Promise<boolean> {
        if (!this.guardSwitchSession()) return false;

        this.isSwitchingSession = true;
        try {
            await this.deps.draftController.flush();
            // Detach from the old runtime (pool decides retention) BEFORE
            // creating the new session, so the runtime's own onFinish can
            // still write into its session file even if the user never
            // comes back to it.
            //
            // Critically: do NOT pipe an empty snapshot of "current chat"
            // into SessionManager here. The previous active session's
            // messages / token usage / sub-agent data are owned by its
            // SessionRuntime (which persists per turn), and SessionManager's
            // own `messagesCache` already mirrors the last persisted state.
            // Calling something like `saveCurrentSession([], 0, [])` would
            // unconditionally overwrite that cache with empty messages and
            // zero tokens; the next `saveToCache()` then flushes the wiped
            // state to disk, silently destroying the session's history.
            this.deps.runtimeBinder.detachFromCurrentRuntime();
            this.deps.sessionManager.createSession();
            await this.deps.sessionManager.saveMetadata();
            this.deps.runtimeBinder.clearViewDOM();
            await this.deps.runtimeBinder.bindActiveSessionRuntime();
            return true;
        } finally {
            this.isSwitchingSession = false;
        }
    }

    async handleNewChat(): Promise<void> {
        await this.startNewSession();
    }

    async handleSwitchSession(targetId: string): Promise<void> {
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return;
        }
        if (targetId === this.deps.sessionManager.activeSessionId) return;

        this.isSwitchingSession = true;
        try {
            await this.deps.draftController.flush();
            this.deps.runtimeBinder.detachFromCurrentRuntime();
            // Just update list.json's activeSessionId. The old runtime's
            // own persistence layer is responsible for its session file.
            await this.deps.sessionManager.switchTo(targetId);
            await this.deps.sessionManager.ensureMessagesLoaded(targetId);
            this.deps.runtimeBinder.clearViewDOM();
            await this.deps.runtimeBinder.bindActiveSessionRuntime();
        } finally {
            this.isSwitchingSession = false;
        }
    }

    /**
     * Branch the current session from a specific user message: fork into a
     * new session that contains every message BEFORE the anchor, populate
     * the input with the anchor's text so the user can edit and resend, and
     * leave all other session state (token usage, summaries, sub-agent
     * messages, title) at the defaults of a freshly-created session.
     *
     * If a turn is currently streaming in the source session, the branch
     * still proceeds — the source runtime stays in the pool (busy → retained)
     * to finish its background turn, while the new branched session gets a
     * fresh runtime, mirroring the {@link startNewSession} contract.
     */
    async handleBranchFromMessage(msg: ChatMessage): Promise<void> {
        if (msg.role !== 'user') return;
        if (!this.guardSwitchSession()) return;

        const sourceId = this.deps.sessionManager.activeSessionId;

        this.isSwitchingSession = true;
        try {
            await this.deps.draftController.flush();

            // Sync live messages from the active runtime into the
            // messagesCache before branching. During streaming, the
            // current-turn user message only exists in chat._messages
            // (not yet in messagesCache), so branchSession would fail
            // to find the anchor and silently return null.
            await this.deps.runtimeBinder.runtime?.persist();

            const result = await this.deps.sessionManager.branchSession(sourceId, msg.id);
            if (!result) return;

            // Mirror the handleSwitchSession flow so the view's runtime, DOM,
            // and input state are rebuilt exactly as they would be after a
            // manual session switch.
            this.deps.runtimeBinder.detachFromCurrentRuntime();
            await this.deps.sessionManager.switchTo(result.newSessionId);
            await this.deps.sessionManager.ensureMessagesLoaded(result.newSessionId);
            this.deps.runtimeBinder.clearViewDOM();
            await this.deps.runtimeBinder.bindActiveSessionRuntime();

            // Seed the input with the branched message so the user can
            // refine it before resending. draftController picks this up
            // through its scheduled save, matching the follow-up flow.
            this.deps.cmInput.setContent(result.draftInput);
            this.deps.cmInput.focus();
            this.deps.draftController?.scheduleSave();

            new Notice(t('view.sessionBranched'));
        } finally {
            this.isSwitchingSession = false;
        }
    }

    async handleSearchResultNavigation(result: SessionSearchResult): Promise<void> {
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return;
        }

        this.isSwitchingSession = true;
        try {
            await this.deps.draftController.flush();
            this.deps.runtimeBinder.detachFromCurrentRuntime();
            await this.deps.sessionManager.switchTo(result.sessionId);
            await this.deps.sessionManager.ensureMessagesLoaded(result.sessionId);
            this.deps.runtimeBinder.clearViewDOM();
            await this.deps.runtimeBinder.bindActiveSessionRuntime();

            // Scroll to the specific message via the unified id-based jump
            // (expands the lazy window if needed, then guarded landing-aware
            // scroll + highlight).
            await this.deps.scrollToMessage(result.messageId);
        } finally {
            this.isSwitchingSession = false;
        }
    }
}
