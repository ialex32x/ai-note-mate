import { Notice } from 'obsidian';
import { ChatMessage } from '../../services/chat-stream';
import NoteAssistantPlugin from 'main';
import { t } from '../../i18n';
import { SessionManager } from '../../session-manager';
import {
    BubbleRenderer,
    DraftInputController,
    FollowUpBar,
    InsightCard,
    TodoPanel,
    ErrorBubbleTracker,
    StreamingLoader,
    SessionLoadingOverlay,
    AssetPanelButton,
} from '../../components/session';
import type { SuggestionCardState } from '../../services/suggestions';
import type { InsightCardState } from '../../services/insights';
import { CMInput } from '../../components/cm-input';
import type { CheckpointSelectorHandle } from '../../components/session/toolbar';
import { ScrollController } from './scroll-controller';
import { BubbleListController } from './bubble-list-controller';
import { SessionStatusController } from './session-status-controller';
import { SessionNavigator } from './session-navigator';
import { SessionPromptOptimizer } from './session-prompt-optimizer';
import { MessageWindowController } from './message-window-controller';
import { buildDisplayUnits } from './display-units';
import { replayUnitsInFrames } from './history-replay-controller';
import { HISTORY_LOADING } from './history-loading-config';
import { isAbortError } from '../../utils/abortable-request';
import {
    SessionRuntime,
    type RuntimeEvent,
} from '../../services/session-runtime';

export interface SessionRuntimeBinderDeps {
    // ── 基础设施 ──
    plugin: NoteAssistantPlugin;
    sessionManager: SessionManager;
    messagesEl: HTMLElement;

    // ── UI 控制器（直接引用） ──
    scroller: ScrollController;
    bubbleList: BubbleListController;
    bubbleRenderer: BubbleRenderer;
    messageWindow: MessageWindowController;
    streamingLoader: StreamingLoader;
    followUpBar: FollowUpBar;
    insightCard: InsightCard;
    todoPanel: TodoPanel;
    historyLoadingOverlay: SessionLoadingOverlay;
    errorBubbles: ErrorBubbleTracker;
    draftController: DraftInputController;
    statusController: SessionStatusController;
    promptOptimizer: SessionPromptOptimizer;
    cmInput: CMInput;
    assetPanelBtn: AssetPanelButton;
    checkpointSelector: CheckpointSelectorHandle;
    sessionNavigator: SessionNavigator;
    scrollToBottomBtn: HTMLButtonElement;

    // ── 回调（SessionView 的薄封装方法） ──
    updateNewChatBtnState: () => void;
    setInputLocked: (locked: boolean) => void;
    showStreamingLoader: () => void;
    hideStreamingLoader: () => void;
    maybeScrollToBottom: () => void;
    forceScrollToBottom: () => void;
    maybeShowFollowUpSuggestions: () => void;
    /**
     * History window sentinel callback target = P6's loadOlderMessages.
     * Late-bound so Phase 1 can point at SessionView and Phase 3 can
     * redirect to the HistoryLoader.
     */
    loadOlderMessages: () => void;
}

/**
 * Owns the binding lifecycle between a {@link SessionView} and the
 * {@link SessionRuntime} sourced from the plugin's runtime pool:
 * attach/detach listeners, hydrate from disk, replay UI state, and
 * route the runtime's typed event channel onto the view's controllers.
 *
 * The view does NOT own the runtime's lifecycle (the pool does); this
 * binder only wires/unwires the view as a listener and projects runtime
 * state onto the DOM through injected controllers.
 */
export class SessionRuntimeBinder {
    private readonly deps: SessionRuntimeBinderDeps;

    /** The runtime currently bound to this view. */
    private _runtime?: SessionRuntime;
    /** Detach fn returned by `runtime.attach(...)`. Cleared after detach. */
    private detachRuntime?: () => void;
    /** Tear-down for active-runtime checkpoint change subscription. */
    private unsubCheckpointChange: (() => void) | null = null;
    /** View-local once-per-attach guard for the emergency-shrink Notice. */
    private _shownEmergencyShrinkNotice = false;
    /** Cancels an in-flight history replay when switching sessions. */
    private historyReplayAbort: AbortController | null = null;

    constructor(deps: SessionRuntimeBinderDeps) {
        this.deps = deps;
    }

    // ── Public accessors ───────────────────────────────────────────────

    /** The runtime currently bound to this view, if any. */
    get runtime(): SessionRuntime | undefined {
        return this._runtime;
    }

    /** Abort signal for the in-flight history replay, if any (read by P6). */
    getReplaySignal(): AbortSignal | undefined {
        return this.historyReplayAbort?.signal;
    }

    /**
     * Reset binding state after the active session was deleted (its
     * runtime was already evicted by SessionNavigator). The caller is
     * expected to follow up with {@link clearViewDOM} +
     * {@link bindActiveSessionRuntime}.
     */
    resetBindingForDeletedSession(): void {
        this.detachRuntime = undefined;
        this._runtime = undefined;
    }

    // ── Runtime attach / ensure ────────────────────────────────────────

    /**
     * Resolve (or create) the runtime that should be bound to this
     * view's active session, and ensure this view is attached to it.
     */
    ensureRuntimeAttached(): SessionRuntime {
        const targetId = this.deps.sessionManager.activeSessionId;
        if (this._runtime && this._runtime.sessionId === targetId) return this._runtime;
        // Mismatch: this is a logic error — the caller forgot to run the
        // switch flow before calling something that requires a chat.
        // Recover by attaching to the correct runtime so the user isn't
        // left with a broken view, but log so we notice during dev.
        console.warn(
            '[SessionView] ensureRuntimeAttached invoked with mismatched runtime; reattaching.',
        );
        this.attachRuntime(this.deps.plugin.runtimePool.getOrCreate(targetId));
        return this._runtime!;
    }

    /**
     * Wire this view as a listener on the given runtime. Replaces any
     * previously attached runtime (caller is responsible for having
     * already detached/released it).
     */
    attachRuntime(runtime: SessionRuntime): void {
        this._runtime = runtime;
        this.detachRuntime = runtime.attach((ev) => this.onRuntimeEvent(ev));
        // Wire the asset gallery button to this runtime's collection.
        this.deps.assetPanelBtn?.bindCollection(
            (listener) => runtime.assetCollection.onChange(listener),
        );
        // Point the checkpoint dropdown at this runtime's store so its
        // count badge and dropdown contents reflect the new session.
        this.deps.checkpointSelector?.setRuntime(runtime);
        // Subscribe to checkpoint-store changes on the active runtime
        // so the session-navigator badge stays live even when the
        // dropdown isn't open.
        this.unsubCheckpointChange?.();
        this.unsubCheckpointChange = runtime.checkpointStore.on('change', () => {
            this.deps.sessionNavigator?.updatePendingBadge();
        });
        // The emergency-shrink Notice gate resets per attach: each
        // session deserves an independent "have we told the user yet?"
        // budget. If the runtime was already in the shrunk state when
        // we attached (background continuation tripped it while the
        // view was elsewhere), surface the Notice once on attach so
        // the warning isn't lost.
        this._shownEmergencyShrinkNotice = false;
        if (runtime.hasEmergencyShrunk) {
            this._shownEmergencyShrinkNotice = true;
            new Notice(t('view.contextEmergencyShrink'), 8000);
        }
    }

    // ── Runtime event channel ──────────────────────────────────────────

    /**
     * Central event handler for the attached SessionRuntime. Mirrors
     * what `buildChatAgentCallbacks` used to do inline, but routed
     * through a single typed event channel so the runtime can keep
     * pushing events even when no view is attached (in which case
     * this function simply isn't called).
     */
    onRuntimeEvent(ev: RuntimeEvent): void {
        switch (ev.type) {
            case 'start':
                this.deps.setInputLocked(true);
                this.deps.showStreamingLoader();
                break;
            case 'message-update':
                this.handleMessageUpdate(ev.msg);
                break;
            case 'sub-agent-message-update':
                this.handleSubAgentMessageUpdate(ev.msg, ev.agentName);
                break;
            case 'tool-call-end':
                // No-op for the view: the trailing loader stays visible
                // for the entire busy turn, so we don't need to retoggle
                // anything between tool calls. Kept as an explicit case
                // so an exhaustiveness check would catch a missing branch.
                break;
            case 'finish':
                // When auto-follow is "parked" — because the user was
                // reading a long streaming message that outgrew the viewport,
                // OR because they explicitly jumped to an earlier message —
                // keep it off so async trailing content (insight card,
                // follow-up bar rendered after the turn) does not yank the
                // view to the bottom. The user stays parked until they send a
                // new message. Abort / error paths restore immediately
                // because the turn was interrupted.
                if (!this.deps.scroller.isAutoFollowParked()) {
                    this.deps.scroller.restoreAutoFollow();
                }
                this.deps.hideStreamingLoader();
                this.deps.setInputLocked(false);
                // Persistence + title generation + insight extraction
                // are all owned by the runtime; the view only needs to
                // refresh derived UI and re-render the (deterministic,
                // cheap) follow-up suggestion bar from the new tail
                // assistant reply.
                this.deps.statusController.updateTitle();
                this.deps.maybeShowFollowUpSuggestions();
                this.deps.updateNewChatBtnState();
                // Auto-trim at turn boundary: only trim when NOT parked.
                // When the user is reading an oversized message (parked),
                // removing old bubbles from the top causes the browser to
                // adjust scrollTop, which shifts the user's reading position.
                // The trim will still happen on the next user message send
                // (forceScrollToBottom) or abort/error (restoreAutoFollow).
                if (!this.deps.scroller.isAutoFollowParked()) {
                    this.deps.messageWindow.maybeTrimTail();
                }
                break;
            case 'abort':
                this.deps.scroller.restoreAutoFollow();
                this.deps.hideStreamingLoader();
                this.deps.bubbleList.handleAbort(ev.msg);
                this.deps.messageWindow.maybeTrimTail();
                break;
            case 'usage-update':
                this.deps.statusController.updateStatusDisplay();
                break;
            case 'error':
                console.warn('ChatStream error:', ev.err);
                this.deps.scroller.restoreAutoFollow();
                this.deps.hideStreamingLoader();
                this.deps.setInputLocked(false);
                this.deps.errorBubbles.append(ev.err.message);
                this.deps.messageWindow.maybeTrimTail();
                break;
            case 'context-summarizing':
                // The summarizer LLM is about to be called — surface
                // a transient status update so the user understands
                // the pause before the assistant reply appears.
                this.deps.streamingLoader.showStatus(t('view.contextSummarizing'));
                break;
            case 'context-compressed':
                // The summarizer LLM returned — restore the normal
                // streaming loader dots (hide the summarizing text).
                this.deps.streamingLoader.hideStatus();
                break;
            case 'emergency-shrink-applied':
                // Only surface the toast the first time it happens in a
                // session — the same warning would otherwise repeat on
                // every subsequent over-budget turn and become noise.
                // The runtime's `hasEmergencyShrunk` flag is flipped
                // BEFORE this event is emitted, so we use the local
                // `_shownEmergencyShrinkNotice` guard instead to detect
                // "first arrival at this view instance" — that way a
                // background-continuation session that previously
                // tripped the shrink will still notify the user the
                // first time they actually look at it.
                if (!this._shownEmergencyShrinkNotice) {
                    this._shownEmergencyShrinkNotice = true;
                    new Notice(t('view.contextEmergencyShrink'), 8000);
                }
                break;
            case 'title-updated':
                // Runtime finished a post-turn title-generation pass;
                // refresh the toolbar title display.
                this.deps.statusController.updateTitle();
                break;
            case 'confirm-tool-call': {
                // The runtime already recorded the resolver in its
                // pendingConfirmations map. We need the corresponding
                // bubble to re-render its Allow / Deny UI now that a
                // resolver exists; trigger that by re-rendering the
                // bubble if it's already on screen.
                const bubble = this.deps.bubbleList.messageBubbles.get(ev.messageId);
                if (bubble) {
                    const msg = this._runtime?.chat?.messages.find(m => m.id === ev.messageId);
                    if (msg) this.deps.bubbleList.updateContent(bubble, msg);
                }
                break;
            }
            case 'insight-update':
                this.renderInsightFromRuntimeState(ev.state);
                break;
            case 'suggestion-update':
                this.renderSuggestionFromRuntimeState(ev.state);
                break;
            case 'todo-update':
                // The runtime mutated its TODO snapshot — refresh the
                // pinned panel. TodoPanel.applyState handles the empty
                // case by tearing itself down.
                this.deps.todoPanel.applyState(ev.state);
                break;
        }
    }

    private handleMessageUpdate(msg: ChatMessage): void {
        if (msg.retireBubble) {
            this.deps.bubbleList.remove(msg.id);
            return;
        }

        const existing = this.deps.bubbleList.messageBubbles.get(msg.id);

        if (existing) {
            if (msg.role === 'tool_call') {
                existing.classList.remove('session-bubble--tool-success', 'session-bubble--tool-warning', 'session-bubble--tool-error');
                if (msg.toolCallResult) {
                    existing.classList.add(`session-bubble--tool-${msg.toolCallResult.status}`);
                }
            }
            this.deps.bubbleList.updateContent(existing, msg);
        } else {
            this.deps.bubbleList.append(msg);
        }
    }

    /**
     * Handle a message update produced by a sub-agent during delegate_task
     * execution. Sub-agent messages are rendered inline as sibling bubbles
     * in the main conversation, with a colored side bar + badge identifying
     * the originating sub-agent.
     */
    private handleSubAgentMessageUpdate(msg: ChatMessage, agentName: string): void {
        if (msg.retireBubble) {
            this.deps.bubbleList.remove(msg.id);
            return;
        }

        const tagged = this.ensureSubAgentTag(msg, agentName);
        const existing = this.deps.bubbleList.messageBubbles.get(tagged.id);
        if (existing) {
            this.deps.bubbleList.updateContent(existing, tagged);
        } else {
            this.deps.bubbleList.append(tagged);
        }
    }

    /** Ensure inline sub-agent bubbles carry origin metadata for badge rendering. */
    private ensureSubAgentTag(msg: ChatMessage, agentName: string): ChatMessage {
        if (msg.subAgent?.agentName) return msg;
        return {
            ...msg,
            subAgent: {
                agentName,
                parentToolCallId: msg.subAgent?.parentToolCallId ?? '',
            },
        };
    }

    // ── Runtime state → DOM projection ─────────────────────────────────

    /**
     * Project a runtime insight state onto the DOM, with appropriate
     * scroll behaviour for auto vs manual extractions. Called from the
     * `insight-update` event handler and (on bind) from
     * {@link replayRuntimeUI}.
     */
    renderInsightFromRuntimeState(state: InsightCardState | null): void {
        this.deps.insightCard.applyState(state);
        if (state === null) return;

        // Manual gestures (clicking "Extract insights" on an action bar
        // that may be far up in the history) deserve assertive scroll:
        // every phase including the empty / error placeholders should
        // be visible without further user effort — UNLESS the user is
        // parked reading an oversized message or jumped to an earlier
        // position.  In that case do not yank the view away from
        // the user's current reading position.
        if (state.cause === 'manual') {
            if (!this.deps.scroller.isAutoFollowParked()) {
                this.deps.forceScrollToBottom();
            }
        } else if (state.phase === 'results') {
            this.deps.maybeScrollToBottom();
        }
    }

    /**
     * Render the follow-up bar from a runtime-owned suggestion state
     * (LLM fallback path). Called from the `suggestion-update` event
     * handler and (on bind) from {@link replayRuntimeUI}.
     *
     * Only renders when the deterministic path hasn't already populated
     * the bar — we respect deterministic results as higher priority
     * since they come from the main model's own intent.
     */
    renderSuggestionFromRuntimeState(state: SuggestionCardState | null): void {
        if (!this.deps.followUpBar) return;
        if (state === null || state.phase !== 'results' || state.suggestions.length === 0) {
            // Don't hide here — the deterministic path may have already
            // populated the bar, and clearing/error states from the runtime
            // shouldn't clobber deterministic results.
            return;
        }

        // If the bar is already showing (deterministic extraction found
        // results), don't override with LLM-produced suggestions.
        if (this.deps.followUpBar.isVisible) return;

        // Verify the assistant message hasn't been superseded.
        const messages = this._runtime?.chat?.messages ?? [];
        let isLatest = false;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m) continue;
            if (m.role === 'assistant' && !m.streaming) {
                isLatest = m.id === state.messageId;
                break;
            }
            if (m.role === 'user') break;
        }
        if (!isLatest) return;

        this.deps.followUpBar.show(state.messageId, state.suggestions);
        // Respect parked auto-follow: don't yank the view when the
        // user is reading an earlier part of a long message.
        if (!this.deps.scroller.isAutoFollowParked()) {
            this.deps.maybeScrollToBottom();
        }
    }

    // ── Detach / clear ─────────────────────────────────────────────────

    /**
     * Detach the view's listener from the currently bound runtime and
     * hand it back to the pool. The pool decides whether to keep the
     * runtime warm (busy continuations are always retained; idle ones
     * are LRU-capped at `maxIdle`).
     *
     * Idempotent: safe to call when no runtime is bound.
     */
    detachFromCurrentRuntime(): void {
        if (!this._runtime) return;
        const id = this._runtime.sessionId;
        try { this.detachRuntime?.(); } finally {
            this.detachRuntime = undefined;
        }
        // Unbind the checkpoint selector before releasing the runtime so
        // its change listener is removed cleanly.
        this.deps.checkpointSelector?.setRuntime(undefined);
        // Unsubscribe from checkpoint-store changes; the badge will
        // refresh on the next dropdown open.
        this.unsubCheckpointChange?.();
        this.unsubCheckpointChange = null;
        // Unbind the asset panel from the old runtime's collection.
        this.deps.assetPanelBtn?.dispose();
        this._runtime = undefined;
        this.deps.plugin.runtimePool.release(id);
    }

    /**
     * Clear all view-private DOM and UI state, leaving the view ready
     * to bind a new runtime. Does NOT abort any chat or destroy any
     * runtime — those are owned by the pool now.
     */
    clearViewDOM(): void {
        // speechSynthesis is a global singleton; cancel any in-flight
        // utterances regardless of which session triggered them.
        if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
        this.deps.bubbleRenderer?.cancelSpeech();
        // Drop any pending refinement before the input is wiped — its
        // target draft is about to disappear with the session switch,
        // so the result would just be discarded by the draft-change
        // guard while still costing LLM tokens.
        this.deps.promptOptimizer.abort();
        this.historyReplayAbort?.abort();
        this.historyReplayAbort = null;
        this.deps.messageWindow?.reset();
        this.deps.historyLoadingOverlay?.hide();
        this.deps.scroller.resetScrollIntent();
        this.deps.hideStreamingLoader();
        this.deps.setInputLocked(false);

        // Clear draft save timer and reset draft state
        this.deps.draftController.reset();

        this.deps.followUpBar?.hide();
        // DOM-level dismissal only. Persisted insights (owned by the
        // SessionRuntime and stored in session metadata) survive the
        // switch so they reappear when the user returns to this session.
        this.deps.insightCard?.hide();
        // Same contract for the TODO panel: hide the DOM but leave
        // the runtime's snapshot intact. `replayRuntimeUI` re-renders
        // the new runtime's snapshot below.
        this.deps.todoPanel?.hide();
        // Detach the singleton streaming loader before emptying, then
        // reattach so it remains the sole instance and still lives at
        // the tail of messagesEl.
        this.deps.streamingLoader.detach();
        this.deps.messagesEl.empty();
        this.deps.streamingLoader.reattachAfterEmpty();
        // Clear bubble map + aborted-id set + drop continue-button ref
        this.deps.bubbleList?.clear();
        // The bubbles are gone from the DOM, but their streaming controllers
        // (throttle timers + pending render state) live in the renderer's map
        // until explicitly disposed. Release them here so a session switch
        // doesn't leak one controller per streamed message until view unload;
        // they are recreated on demand when the next session replays.
        this.deps.bubbleRenderer?.disposeAllControllers();

        this.deps.cmInput.clear();
        this.deps.scrollToBottomBtn.hide();
        this.deps.statusController.updateStatusDisplay();
        this.deps.updateNewChatBtnState();
    }

    // ── Bind / hydrate / replay ────────────────────────────────────────

    /**
     * Resolve the runtime for the session manager's currently active
     * id (from pool cache, or create one fresh), attach this view as a
     * listener, and replay the runtime's current state to the DOM.
     */
    async bindActiveSessionRuntime(): Promise<void> {
        const id = this.deps.sessionManager.activeSessionId;
        const cached = this.deps.plugin.runtimePool.get(id);
        if (cached) {
            this.attachRuntime(cached);
            await this.replayRuntimeUI(cached, { fromCache: true });
        } else {
            // Fresh runtime — needs history loaded from disk first.
            await this.deps.sessionManager.ensureMessagesLoaded(id);
            const runtime = this.deps.plugin.runtimePool.create(id);
            this.attachRuntime(runtime);
            this.hydrateRuntimeFromDisk(runtime);
            await this.replayRuntimeUI(runtime, { fromCache: false });
        }
    }

    /**
     * Pull the session's persisted state (messages, summaries, sub-agent
     * messages, per-agent token breakdown) from SessionManager and inject
     * it into the runtime's IChatAgent. Only called for FRESH runtimes;
     * cached ones already have everything in memory.
     */
    hydrateRuntimeFromDisk(runtime: SessionRuntime): void {
        const session = this.deps.sessionManager.getSessionSync(runtime.sessionId);
        if (!session || session.messages.length === 0) return;

        const chat = runtime.chat;
        chat.restoreState(session.messages, session.tokenUsage);

        const summaries = this.deps.sessionManager.getSessionSummaries(runtime.sessionId);
        if (summaries.length > 0) {
            chat.restoreSummaries(summaries);
            runtime.hasContextCompressed = true;
        }

        // Sub-agent inline messages (v2+ sessions only).
        const subAgentMessages = this.deps.sessionManager.getSubAgentMessages();
        if (subAgentMessages && Object.keys(subAgentMessages).length > 0
                && typeof chat.restoreSubAgentMessages === 'function') {
            chat.restoreSubAgentMessages(subAgentMessages);
        }

        // QuickAsk side-turns (v6+ sessions only).
        const quickAskTurns = this.deps.sessionManager.getQuickAskTurns();
        if (quickAskTurns && quickAskTurns.length > 0
                && typeof chat.restoreQuickAskTurns === 'function') {
            chat.restoreQuickAskTurns(quickAskTurns);
        }

        // Per-agent token usage breakdown (v3+ sessions only). Must be
        // called AFTER restoreState — see AgentOrchestrator.restoreAgentTokenBreakdown.
        const agentTokenBreakdown = this.deps.sessionManager.getAgentTokenBreakdown();
        if (agentTokenBreakdown && typeof chat.restoreAgentTokenBreakdown === 'function') {
            chat.restoreAgentTokenBreakdown(agentTokenBreakdown);
        }

        // Persisted insight card state (post-feature sessions only).
        // Mirrors the draft-input restore — the user's last view of the
        // card should reappear when they return to (or reload into)
        // this session, without re-spending tokens to recompute it.
        const lastInsights = this.deps.sessionManager.getSessionLastInsights(runtime.sessionId);
        if (lastInsights) {
            runtime.restoreInsightState(lastInsights);
        }

        // Persisted suggestion bar state (LLM fallback results).
        const lastSuggestions = this.deps.sessionManager.getSessionLastSuggestions(runtime.sessionId);
        if (lastSuggestions) {
            runtime.restoreSuggestionState(lastSuggestions);
        }

        // Persisted TODO state (v4 sessions only). Always restore the
        // runtime's snapshot from disk before the replay pass — the
        // panel is then projected from `runtime.getTodoState()` in
        // `replayRuntimeUI`, matching how insight state is handled.
        const todos = this.deps.sessionManager.getSessionTodos(runtime.sessionId);
        if (todos) {
            runtime.restoreTodos(todos);
        }

        // Restore the generated-asset collection from the persisted
        // top-level session field (peer to messages / agentTokenBreakdown).
        // The asset button in the toolbar reads from
        // `runtime.assetCollection.assets` on render.
        const toolCallAssets = this.deps.sessionManager.getSessionToolCallAssets(runtime.sessionId);
        if (toolCallAssets && toolCallAssets.length > 0) {
            runtime.restoreAssets(toolCallAssets);
        }
    }

    /**
     * Render the runtime's current chat state into the (just-cleared)
     * view DOM. Used both for fresh runtimes (after disk hydration) and
     * cached runtimes (after a switch back from another session).
     *
     * For a cached runtime that is currently busy, this also re-shows
     * the typing indicator and locks the input so the UI immediately
     * reflects the in-flight turn.
     *
     * @param runtime - The runtime to replay; defaults to the currently
     *   bound runtime when omitted (used by the in-place edit flow).
     */
    async replayRuntimeUI(
        runtime: SessionRuntime | undefined,
        opts: { fromCache: boolean },
    ): Promise<void> {
        const rt = runtime ?? this._runtime;
        if (!rt) return;
        const chat = rt.chat;
        const messages = chat.messages;

        if (messages.length === 0) {
            this.deps.messageWindow.reset();
            this.deps.todoPanel.applyState(this._runtime?.getTodoState() ?? null);
            this.deps.draftController.restore();
            this.deps.statusController.updateStatusDisplay();
            this.deps.updateNewChatBtnState();
            return;
        }

        const allUnits = buildDisplayUnits(messages, {
            getSubAgentMessages: typeof chat.getSubAgentMessages === 'function'
                ? (id) => chat.getSubAgentMessages!(id)
                : undefined,
        });

        const { initialStart, initialEnd } = this.deps.messageWindow.init(allUnits);
        const unitsToRender = allUnits.slice(initialStart, initialEnd);
        const showOverlay = unitsToRender.length >= HISTORY_LOADING.showOverlayMinUnits;

        const ac = new AbortController();
        this.historyReplayAbort = ac;

        if (showOverlay) {
            this.deps.historyLoadingOverlay.show(unitsToRender.length);
            this.deps.setInputLocked(true);
        }

        try {
            await replayUnitsInFrames(unitsToRender, {
                appendUnit: (unit) => {
                    this.deps.bubbleList.append({ ...unit.msg, streaming: false }, { trackInWindow: false });
                },
                onProgress: (done, total) => {
                    this.deps.historyLoadingOverlay.setProgress(done, total);
                },
                signal: ac.signal,
            });

            if (ac.signal.aborted) return;

            this.deps.messageWindow.mountSentinel(() => this.deps.loadOlderMessages());
        } catch (err) {
            if (isAbortError(err)) {
                return;
            }
            throw err;
        } finally {
            this.deps.historyLoadingOverlay.hide();
            this.historyReplayAbort = null;
            if (!rt.isBusy) {
                this.deps.setInputLocked(false);
            }
        }

        this.deps.draftController.restore();
        this.deps.forceScrollToBottom();
        this.deps.statusController.updateStatusDisplay();
        this.deps.updateNewChatBtnState();

        this.deps.maybeShowFollowUpSuggestions();
        this.renderInsightFromRuntimeState(this._runtime?.getInsightState() ?? null);
        this.renderSuggestionFromRuntimeState(this._runtime?.getSuggestionState() ?? null);
        this.deps.todoPanel.applyState(this._runtime?.getTodoState() ?? null);

        if (opts.fromCache && rt.isBusy) {
            this.deps.setInputLocked(true);
            this.deps.showStreamingLoader();
        }
    }
}
