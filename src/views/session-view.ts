import {
    ItemView,
    WorkspaceLeaf,
    IconName,
    TFile,
    Notice,
    setIcon,
    setTooltip,
    Platform,
    Menu,
} from 'obsidian';
import { ChatMessage, IChatAgent } from '../services/chat-stream';
import { findTailTurn } from '../services/turn-utils';
import { optimizePrompt, PromptOptimizationError } from '../services/prompt-optimizer';
import { getActiveProfile } from '../settings';
import { exportSessionToVault } from '../services/session-exporter';

import NoteAssistantPlugin from 'main';
import { t } from '../i18n';
import { SessionManager } from '../session-manager';
import { SessionSearchModal, SessionSearchResult } from '../modals/session-search-modal';
import { CheckpointActionConfirmModal } from '../modals/checkpoint-action-confirm-modal';
import {
    DropdownManager,
    BubbleRenderer,
    DraftInputController,
    FollowUpBar,
    InsightCard,
    TodoPanel,
} from '../components/session';
import { extractSuggestions, type SuggestedAction } from '../services/suggestions';
import {
    buildInsightDeepenPrompt,
    type ConversationInsight,
    type InsightCardState,
} from '../services/insights';
import { resolveLinkOpenText } from '../utils/workspace-utils';

import {
    createProfileSelector, type ProfileSelectorHandle,
    createCheckpointSelector, type CheckpointSelectorHandle,
    createTipsButton, type TipsButtonHandle,
    createIssueTracerButton, type IssueTracerButtonHandle,
} from '../components/session/toolbar';
import type { TipSessionViewAdapter } from '../services/tips';
import type { TokenUsage } from '../services/llm-provider';
import { CMInput } from '../components/cm-input';
import {
    ScrollController,
    StreamingLoader,
    showInitializationError,
    ErrorBubbleTracker,
    BubbleListController,
    SessionStatusController,
    updateSessionTitle as renderSessionTitle,
    maybeGenerateSessionTitle,
    createSummarizerConfig,
    createInsightsConfig,
    createEmbeddingConfig,
    createToolFilterOptions,
    createProviderForActiveProfileOf,
    SessionNavigator,
} from './session-view/index';
import { buildDisplayUnits } from './session-view/display-units';
import { replayUnitsInFrames } from './session-view/history-replay-controller';
import { SessionLoadingOverlay } from './session-view/session-loading-overlay';
import { MessageWindowController } from './session-view/message-window-controller';
import { HISTORY_LOADING } from './session-view/history-loading-config';
import {
    SessionRuntime,
    extractInsightsForMessage,
    type RuntimeEvent,
} from '../services/session-runtime';

export class SessionView extends ItemView {
    static readonly VIEW_TYPE = 'ai-session-view';

    // ── UI elements ──────────────────────────────────────────────────────────
    private messagesEl!: HTMLElement;
    cmInput!: CMInput;
    private sendBtn!: HTMLButtonElement;
    private optimizeBtn!: HTMLButtonElement;
    /**
     * AbortController for an in-flight prompt-refinement call. Held on
     * the view so a follow-up edit / send action can pre-empt a stale
     * refinement without leaking the LLM request.
     */
    private optimizeAbort: AbortController | null = null;
    /** Singleton trailing "AI is working" loader (see StreamingLoader for rationale). */
    private streamingLoader!: StreamingLoader;
    /** Scroll container controller (user-scrolled-up tracking + scroll-to-bottom button). */
    private scroller!: ScrollController;
    /** Overlay + progress while a large history slice is replayed. */
    private historyLoadingOverlay!: SessionLoadingOverlay;
    /** Tracks which history units are rendered (tail-first windowing). */
    private messageWindow!: MessageWindowController;
    /** Cancels an in-flight history replay when switching sessions. */
    private historyReplayAbort: AbortController | null = null;
    /**
     * Serializes history-prepend operations so {@link loadOlderMessages} and
     * {@link ensureMessageVisible} never interleave their `replayUnitsInFrames`
     * batches against a stale anchor / window bounds (which would scramble
     * message order). See {@link runHistoryMutation}.
     */
    private historyMutationChain: Promise<void> = Promise.resolve();
    /** Flag to prevent concurrent session switches */
    private isSwitchingSession = false;
    private scrollToBottomBtn!: HTMLButtonElement;
    private newChatBtn!: HTMLButtonElement;
    private sessionNavigator!: SessionNavigator;
    // ── Session runtime ──────────────────────────────────────────────────────
    /**
     * The runtime currently bound to this view. Sourced from
     * `plugin.runtimePool`; the view does NOT own its lifecycle (the
     * pool does). When the view switches sessions or closes, it
     * detaches its listener and tells the pool to `release()`; the
     * pool decides whether the runtime keeps running in the background.
     */
    private runtime?: SessionRuntime;
    /** Detach fn returned by `runtime.attach(...)`. Cleared after detach. */
    private detachRuntime?: () => void;

    /**
     * View-local once-per-attach guard for the emergency-shrink Notice.
     * Kept on the view (not the runtime) so a background continuation
     * that already tripped the shrink while detached still surfaces the
     * Notice the first time the user opens / switches back to the view.
     * Reset on `bindToSession` so each session-switch starts fresh.
     */
    private _shownEmergencyShrinkNotice = false;

    private plugin!: NoteAssistantPlugin;

    // ── Session management ──────────────────────────────────────────────────
    /** Convenience accessor for the plugin-wide SessionManager. */
    private get sessionManager(): SessionManager {
        return this.plugin.sessionManager;
    }

    // ── In-flight streaming bubble ───────────────────────────────────────────
    /** Controller that owns the bubble DOM map, aborted-message tracking,
     *  and the low-level append/prepend/render/update/abort operations.
     *  Constructed in {@link buildMessageArea}. */
    private bubbleList!: BubbleListController;

    /**
     * Controller that owns the toolbar title display and the
     * session-status indicator (token usage, context ring, detail
     * panel). Constructed in {@link buildInputArea} once all related
     * DOM elements exist — before that, the view uses inline fallbacks.
     */
    private statusController!: SessionStatusController;

    /**
     * Tracks the inline "continue" button on the conversation-tail error
     * bubble. The tracker enforces "only the latest tail error carries
     * a continue button" — anything that pushes new content past that
     * tail (a new chat bubble, a fresh error replacing it, a session
     * switch) must call `errorBubbles.clearContinueBtn()` before
     * mutating the DOM. Constructed lazily in `buildMessageArea` once
     * `messagesEl` and `streamingLoader` exist.
     */
    private errorBubbles!: ErrorBubbleTracker;

    // ── Draft input debounce ────────────────────────────────────────────────
    private draftController!: DraftInputController;

    // ── Toolbar selectors ────────────────────────────────────────────────────────────
    private profileSelector!: ProfileSelectorHandle;
    private checkpointSelector!: CheckpointSelectorHandle;
    private tipsButton: TipsButtonHandle | null = null;
    private issueTracerButton: IssueTracerButtonHandle | null = null;
    /** Tear-down for active-runtime checkpoint change subscription. */
    private unsubCheckpointChange: (() => void) | null = null;
    // ── Refactored components ────────────────────────────────────────────────
    private dropdownManager = new DropdownManager();
    private bubbleRenderer!: BubbleRenderer;
    /** Quick-pick bar for follow-up suggestions extracted from the last assistant reply. */
    private followUpBar!: FollowUpBar;
    /**
     * Read-only preview card for candidate knowledge nuggets extracted
     * from the last turn. The card is a pure renderer driven by
     * {@link SessionRuntime}'s `insight-update` events and the runtime's
     * persisted `lastInsights` metadata — the view never decides what
     * state to show on its own.
     */
    private insightCard!: InsightCard;
    /**
     * Pinned-at-top TODO list for the active session, populated by
     * the `manage_todos` tool. Read-only on the user side; the LLM
     * is the single writer. Driven by {@link SessionRuntime}'s
     * `todo-update` event channel and rehydrated from disk via
     * {@link hydrateRuntimeFromDisk}.
     */
    private todoPanel!: TodoPanel;

    constructor(leaf: WorkspaceLeaf, plugin: NoteAssistantPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return SessionView.VIEW_TYPE; }
    getDisplayText() { return t('view.name'); }
    getIcon(): IconName { return 'sparkles'; }

    /**
     * Populates the pane menu when user clicks "More options" or right-clicks tab header.
     */
    onPaneMenu(menu: Menu, _source: string): void {
        menu.addItem((item) => {
            item
                .setTitle(t('view.exportSession'))
                .setIcon('download')
                .onClick(() => this.exportSession());
        });
    }

    /**
     * The IChatAgent backing the currently attached runtime, if any.
     * Returns undefined when the view has no runtime bound (e.g. during
     * the brief window inside `clearViewDOM()`).
     */
    private get chat(): IChatAgent | undefined {
        return this.runtime?.chat;
    }

    /**
     * Whether the current session's chat is producing output. Pure
     * accessor — the underlying state lives on the SessionRuntime so
     * that background continuations remain accurate.
     */
    private get isStreaming(): boolean {
        return this.runtime?.isBusy === true;
    }

    /**
     * Pending tool-call confirmations for the currently attached
     * runtime. Returns an empty map when no runtime is bound (used by
     * the bubble renderer; an empty map is a safe no-op there).
     */
    private get pendingConfirmations(): Map<string, (approved: boolean) => void> {
        return this.runtime?.pendingConfirmations ?? new Map();
    }

    /**
     * Resolve (or create) the runtime that should be bound to this
     * view's active session, and ensure this view is attached to it.
     *
     * Replaces the old `getChatStream()` accessor. Unlike that one,
     * this method does NOT lazily create state on first read inside
     * UI helpers; the only places that may create a runtime are the
     * switch / new / open flows. Other call sites should treat
     * `this.runtime` as readonly.
     */
    private ensureRuntimeAttached(): SessionRuntime {
        const targetId = this.sessionManager.activeSessionId;
        if (this.runtime && this.runtime.sessionId === targetId) return this.runtime;
        // Mismatch: this is a logic error — the caller forgot to run the
        // switch flow before calling something that requires a chat.
        // Recover by attaching to the correct runtime so the user isn't
        // left with a broken view, but log so we notice during dev.
        console.warn(
            '[SessionView] ensureRuntimeAttached invoked with mismatched runtime; reattaching.',
        );
        this.attachRuntime(this.plugin.runtimePool.getOrCreate(targetId));
        return this.runtime!;
    }

    /**
     * Wire this view as a listener on the given runtime. Replaces any
     * previously attached runtime (caller is responsible for having
     * already detached/released it).
     */
    private attachRuntime(runtime: SessionRuntime): void {
        this.runtime = runtime;
        this.detachRuntime = runtime.attach((ev) => this.onRuntimeEvent(ev));
        // Point the checkpoint dropdown at this runtime's store so its
        // count badge and dropdown contents reflect the new session.
        this.checkpointSelector?.setRuntime(runtime);
        // Subscribe to checkpoint-store changes on the active runtime
        // so the session-navigator badge stays live even when the
        // dropdown isn't open.
        this.unsubCheckpointChange?.();
        this.unsubCheckpointChange = runtime.checkpointStore.on('change', () => {
            this.sessionNavigator?.updatePendingBadge();
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

    /**
     * Central event handler for the attached SessionRuntime. Mirrors
     * what `buildChatAgentCallbacks` used to do inline, but routed
     * through a single typed event channel so the runtime can keep
     * pushing events even when no view is attached (in which case
     * this function simply isn't called).
     */
    private onRuntimeEvent(ev: RuntimeEvent): void {
        switch (ev.type) {
            case 'start':
                this.setInputLocked(true);
                this.showStreamingLoader();
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
                if (!this.scroller.isAutoFollowParked()) {
                    this.scroller.restoreAutoFollow();
                }
                this.hideStreamingLoader();
                this.setInputLocked(false);
                // Persistence + title generation + insight extraction
                // are all owned by the runtime; the view only needs to
                // refresh derived UI and re-render the (deterministic,
                // cheap) follow-up suggestion bar from the new tail
                // assistant reply.
                this.statusController.updateTitle();
                this.maybeShowFollowUpSuggestions();
                this.updateNewChatBtnState();
                // Auto-trim at turn boundary: safe because autoFollow is
                // now true — the MutationObserver from the trim will
                // scroll to the bottom naturally.
                this.messageWindow.maybeTrimTail();
                break;
            case 'abort':
                this.scroller.restoreAutoFollow();
                this.hideStreamingLoader();
                this.bubbleList.handleAbort(ev.msg);
                this.messageWindow.maybeTrimTail();
                break;
            case 'usage-update':
                this.statusController.updateStatusDisplay();
                break;
            case 'error':
                console.warn('ChatStream error:', ev.err);
                this.scroller.restoreAutoFollow();
                this.hideStreamingLoader();
                this.setInputLocked(false);
                this.errorBubbles.append(ev.err.message);
                this.messageWindow.maybeTrimTail();
                break;
            case 'context-summarizing':
                // The summarizer LLM is about to be called — surface
                // a transient status update so the user understands
                // the pause before the assistant reply appears.
                this.streamingLoader.showStatus(t('view.contextSummarizing'));
                break;
            case 'context-compressed':
                // The summarizer LLM returned — restore the normal
                // streaming loader dots (hide the summarizing text).
                this.streamingLoader.hideStatus();
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
                this.statusController.updateTitle();
                break;
            case 'confirm-tool-call': {
                // The runtime already recorded the resolver in its
                // pendingConfirmations map. We need the corresponding
                // bubble to re-render its Allow / Deny UI now that a
                // resolver exists; trigger that by re-rendering the
                // bubble if it's already on screen.
                const bubble = this.bubbleList.messageBubbles.get(ev.messageId);
                if (bubble) {
                    const msg = this.chat?.messages.find(m => m.id === ev.messageId);
                    if (msg) this.bubbleList.updateContent(bubble, msg);
                }
                break;
            }
            case 'insight-update':
                this.renderInsightFromRuntimeState(ev.state);
                break;
            case 'todo-update':
                // The runtime mutated its TODO snapshot — refresh the
                // pinned panel. Empty snapshots are translated into
                // `applyState(null)` by the runtime ... wait, no: the
                // runtime always emits the snapshot it just committed,
                // even when empty. TodoPanel.applyState handles the
                // empty case by tearing itself down.
                this.todoPanel.applyState(ev.state);
                break;
        }
    }

    /**
     * Project a runtime insight state onto the DOM, with appropriate
     * scroll behaviour for auto vs manual extractions. Called from the
     * `insight-update` event handler and (on bind) from
     * {@link replayRuntimeUI}.
     */
    private renderInsightFromRuntimeState(state: InsightCardState | null): void {
        this.insightCard.applyState(state);
        if (state === null) return;

        // Manual gestures (clicking "Extract insights" on an action bar
        // that may be far up in the history) deserve assertive scroll:
        // every phase including the empty / error placeholders should
        // be visible without further user effort. Auto extractions
        // respect user scroll intent and only nudge when the user is
        // already at the tail.
        if (state.cause === 'manual') {
            this.forceScrollToBottom();
        } else if (state.phase === 'results') {
            this.maybeScrollToBottom();
        }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async onOpen() {
        const root = this.contentEl;
        root.empty();
        root.addClass('session-view');

        this.installMobileKeyboardPadding(root);

        // Load cached sessions from disk
        await this.sessionManager.loadFromCache();

        try {
            // Pre-warm speechSynthesis voice engine
            if (!Platform.isMobile && 'speechSynthesis' in window) {
                speechSynthesis.getVoices();
            }

            const sessionTitleEl = this.buildToolbar(root);
            this.buildMessageArea(root);
            this.buildInputArea(root, sessionTitleEl);

            // ── Restore session UI from cache ────────────────────────────────
            await this.bindActiveSessionRuntime();
        } catch (error) {
            showInitializationError(this.contentEl, error, () => { void this.onOpen(); });
        }
    }

    /**
     * Apply the W3C VirtualKeyboard API workaround on mobile so a
     * focused input doesn't get covered by the on-screen keyboard.
     * No-op on desktop or where the API isn't available.
     */
    private installMobileKeyboardPadding(root: HTMLElement): void {
        if (!Platform.isMobile || !('virtualKeyboard' in navigator)) return;
        // W3C VirtualKeyboard API — not yet in lib.dom.d.ts. Narrow locally
        // instead of `as any` so the only untyped surface is the cast itself.
        interface VirtualKeyboard extends EventTarget {
            overlaysContent: boolean;
            boundingRect: DOMRectReadOnly;
        }
        const vk = (navigator as Navigator & { virtualKeyboard: VirtualKeyboard }).virtualKeyboard;
        vk.overlaysContent = true;
        const updatePadding = () => {
            const height = vk.boundingRect.height;
            root.style.paddingBottom = `${height}px`;
        };
        vk.addEventListener('geometrychange', updatePadding);
        this.register(() => {
            vk.removeEventListener('geometrychange', updatePadding);
        });
    }

    /**
     * Build the top toolbar: session switcher (left), session title
     * (center), and the new-chat / more-actions group (right).
     *
     * Sets `this.sessionNavigator`, `this.newChatBtn`.
     *
     * @returns The session title element so it can be passed to the
     *          status controller when it is constructed later in
     *          {@link buildInputArea}.
     */
    private buildToolbar(root: HTMLElement): HTMLElement {
        const toolbar = root.createEl('div', { cls: 'session-toolbar' });

        // Left group: session switcher button + token usage
        const leftGroup = toolbar.createEl('div', { cls: 'session-toolbar__group session-toolbar__group--left' });

        // Session switcher button with dropdown and more actions
        this.sessionNavigator = new SessionNavigator({
            app: this.app,
            sessionManager: this.sessionManager,
            dropdownManager: this.dropdownManager,
            isStreaming: () => this.isStreaming,
            getSessionStatus: (id) => {
                const rt = this.plugin.runtimePool.get(id);
                if (!rt) return 'unloaded';
                if (rt.pendingConfirmations.size > 0) return 'awaitingConfirm';
                if (rt.isBusy) return 'busy';
                return 'idle';
            },
            getSessionPendingCheckpoints: (id) => {
                // Pending-checkpoint state is runtime-only (the
                // CheckpointStore lives on the SessionRuntime). Sessions
                // without a warm runtime in the pool are guaranteed
                // to have zero pending — they were either never
                // loaded this session, or were released back to the
                // pool only after every checkpoint was resolved
                // (release() refuses to evict runtimes whose store
                // still has pending checkpoints).
                const rt = this.plugin.runtimePool.get(id);
                return rt?.checkpointStore.pendingCount ?? 0;
            },
            evictRuntime: (id) => this.plugin.runtimePool.evict(id),
            clearActiveDraftTimer: () => this.draftController.clearTimer(),
            onSwitchSession: (id) => { void this.handleSwitchSession(id); },
            onActiveSessionDeleted: async () => {
                // The active session's runtime was already evicted
                // by SessionNavigator (via plugin.runtimePool.evict);
                // we just need to detach our listener (no-op since
                // the runtime is gone) and rebind to whichever
                // session SessionManager auto-selected.
                this.detachRuntime = undefined;
                this.runtime = undefined;
                this.clearViewDOM();
                await this.bindActiveSessionRuntime();
            },
            onAcceptAllPendingCheckpoints: async () => {
                const sessions = this.sessionManager.getAllSessions();
                let acceptedCount = 0;

                for (const s of sessions) {
                    const rt = this.plugin.runtimePool.get(s.id);
                    if (rt && rt.checkpointStore.hasPending) {
                        const countBefore = rt.checkpointStore.pendingCount;
                        await rt.checkpointStore.acceptAllPending();
                        acceptedCount += countBefore;
                    }
                }

                if (acceptedCount > 0) {
                    new Notice(t('view.allPendingCheckpointsAccepted', { count: acceptedCount }));
                    this.sessionNavigator.updatePendingBadge();
                } else {
                    new Notice(t('view.noPendingCheckpointsToAccept'));
                }
            },
        });
        this.sessionNavigator.mount(leftGroup);

        // Center group: session title
        const centerGroup = toolbar.createEl('div', { cls: 'session-toolbar__group session-toolbar__group--center' });
        const sessionTitleEl = centerGroup.createEl('span', { cls: 'session-toolbar__title' });
        // Delegate to the status controller (constructed later in
        // buildInputArea). The closure captures `this`; by the time the
        // user clicks, the controller will exist.
        sessionTitleEl.addEventListener('click', () => this.statusController.handleTitleClick(centerGroup));

        // Initial title render — the controller doesn't exist yet, so
        // we call the helper directly. After buildInputArea completes,
        // all subsequent title updates go through the controller.
        renderSessionTitle(sessionTitleEl, this.sessionManager);

        // Right group: new chat button with dropdown
        const rightGroup = toolbar.createEl('div', { cls: 'session-toolbar__group session-toolbar__group--right' });

        // Toolbar buttons - New Chat button with dropdown
        const newChatBtnGroup = rightGroup.createEl('span', {
            cls: 'session-toolbar__btn-group',
        });

        const newChatBtn = newChatBtnGroup.createEl('button', {
            cls: 'session-toolbar__btn session-toolbar__btn--primary',
            attr: { 'aria-label': t('view.newChat') },
        });
        setIcon(newChatBtn, 'file-plus');
        newChatBtn.addEventListener('click', () => void this.handleNewChat());
        this.newChatBtn = newChatBtn;

        // More actions dropdown button
        const moreActionsBtn = newChatBtnGroup.createEl('button', {
            cls: 'session-toolbar__btn session-toolbar__btn--dropdown',
            attr: { 'aria-label': t('view.moreActions') },
        });
        setIcon(moreActionsBtn, 'chevron-down');

        const moreActionsDropdown = newChatBtnGroup.createEl('div', {
            cls: 'session-dropdown-menu session-dropdown-menu--toolbar-right',
        });

        const searchItem = moreActionsDropdown.createEl('div', { cls: 'session-dropdown-item' });
        const searchIcon = searchItem.createEl('span', { cls: 'session-dropdown-item__icon' });
        setIcon(searchIcon, 'search');
        searchItem.createEl('span', { text: t('search.title') });
        searchItem.addEventListener('click', () => {
            this.dropdownManager.closeActive();
            void this.openSessionSearch();
        });

        const saveAsNoteItem = moreActionsDropdown.createEl('div', { cls: 'session-dropdown-item' });
        const saveIcon = saveAsNoteItem.createEl('span', { cls: 'session-dropdown-item__icon' });
        setIcon(saveIcon, 'download');
        saveAsNoteItem.createEl('span', { text: t('view.exportSession') });
        saveAsNoteItem.addEventListener('click', () => {
            this.dropdownManager.closeActive();
            this.exportSession();
        });

        this.dropdownManager.registerToggle({
            wrapper: newChatBtnGroup,
            button: moreActionsBtn,
            dropdown: moreActionsDropdown,
            onOpen: () => {
                // DropdownManager automatically closes other active dropdowns
            },
        });

        this.updateNewChatBtnState();

        return sessionTitleEl;
    }

    /**
     * Build the message-list area: messages container, history loading
     * overlay, message-window controller, streaming loader, bubble
     * renderer, follow-up bar, insight card, and the scroll-to-bottom
     * button (with its scroll controller).
     *
     * Sets `this.messagesEl`, `this.historyLoadingOverlay`,
     * `this.messageWindow`, `this.streamingLoader`, `this.bubbleRenderer`,
     * `this.followUpBar`, `this.insightCard`, `this.scrollToBottomBtn`,
     * `this.scroller`.
     */
    private buildMessageArea(root: HTMLElement): void {
        const messagesWrapper = root.createEl('div', { cls: 'session-messages-wrapper' });
        this.messagesEl = messagesWrapper.createEl('div', { cls: 'session-messages' });

        this.historyLoadingOverlay = new SessionLoadingOverlay(messagesWrapper);
        this.historyLoadingOverlay.mount();
        this.messageWindow = new MessageWindowController(this.messagesEl);

        // Create the singleton trailing loader as the last child of
        // messagesEl. It stays in the DOM for the view's lifetime; we
        // toggle its visibility via `session-streaming-loader--hidden`
        // and move it back to the tail after any bubble append.
        this.streamingLoader = new StreamingLoader(this.messagesEl);
        this.streamingLoader.mount();

        // Initialize BubbleRenderer with messagesEl
        this.bubbleRenderer = new BubbleRenderer(
            this.app,
            () => this.maybeScrollToBottom(),
            (msg) => { void this.handleExtractInsights(msg); },
            // Mount floating (fixed-positioned) dropdowns inside this view's
            // container so they don't leak onto document.body and are
            // cleaned up naturally when the view is detached.
            this.containerEl,
            (msg) => { void this.handleBranchFromMessage(msg); },
            (msg) => { void this.handleEditMessage(msg); },
            (msg) => { void this.handleJumpToPrevUser(msg); },
            (msg) => { void this.handleJumpToNextUser(msg); },
            (msg) => this.canJumpToPrevUser(msg),
            (msg) => this.canJumpToNextUser(msg),
        );
        this.addChild(this.bubbleRenderer);

        // Initialize follow-up suggestion bar (mounted on messagesEl on demand)
        this.followUpBar = new FollowUpBar(this.messagesEl, (action) => {
            this.handleFollowUpPick(action);
        });

        // Conversation-insight preview card. The card is purely a
        // renderer; SessionRuntime owns the extraction state machine
        // and persistence. Deepen is a UI gesture (send/fill input)
        // and stays in the view.
        this.insightCard = new InsightCard(
            this.messagesEl,
            this.app,
            (insight) => this.handleInsightDeepen(insight),
        );

        // Scroll-to-bottom button
        this.scrollToBottomBtn = messagesWrapper.createEl('button', {
            cls: 'session-scroll-to-bottom-btn',
            attr: { 'aria-label': 'Scroll to latest' },
        });
        this.scroller = new ScrollController(
            this.messagesEl,
            this.scrollToBottomBtn,
            () => this.isStreaming,
        );
        this.scroller.attach();
        this.scroller.setNearTopCallback(() => {
            if (this.messageWindow.shouldAutoLoadOlder(this.messagesEl.scrollTop)) {
                void this.loadOlderMessages();
            }
        });

        // Tail-error continue-button tracker. Wired here because it
        // needs both `messagesEl` (mount target) and `streamingLoader`
        // (re-pin after each append). The continue handler resends a
        // user prompt to resume the interrupted turn — guarded against
        // a racing concurrent stream from another view attached to the
        // same runtime.
        this.errorBubbles = new ErrorBubbleTracker({
            messagesEl: this.messagesEl,
            pinStreamingLoaderToEnd: () => this.streamingLoader.pinToEnd(),
            maybeScrollToBottom: () => this.maybeScrollToBottom(),
            onContinue: () => {
                if (this.isStreaming) return;
                // No need to manually clear the button here: sendPrompt
                // delivers the user message via onUserMessage →
                // appendBubble, which clears the singleton as part of
                // its normal "new tail" handling.
                void this.sendPrompt(t('view.continueAfterError'));
            },
        });

        // Bubble-list controller: owns the messageBubbles map,
        // abortedMessageIds set, and the append/prepend/render/update/
        // abort operations. Depends on everything created above.
        this.bubbleList = new BubbleListController({
            messagesEl: this.messagesEl,
            bubbleRenderer: this.bubbleRenderer,
            errorBubbles: this.errorBubbles,
            streamingLoader: this.streamingLoader,
            scroller: this.scroller,
            messageWindow: this.messageWindow,
            followUpBar: this.followUpBar,
            insightCard: this.insightCard,
            isStreaming: () => this.isStreaming,
            pendingConfirmations: () => this.pendingConfirmations,
            updateNewChatBtnState: () => this.updateNewChatBtnState(),
            setInputLocked: (locked) => this.setInputLocked(locked),
            chat: () => this.chat,
            updateSessionTitle: () => this.statusController.updateTitle(),
        });

        // When the window controller trims the oldest rendered bubbles, drop
        // their (now detached) entries from the bubble map so jump navigation
        // doesn't resolve a stale node.
        this.messageWindow.setOnUnitsTrimmed((ids) => this.bubbleList.dropFromMap(ids));
    }

    /**
     * Build the docked input area: TODO panel, checkpoint row,
     * CodeMirror compose card, and the thinking row (file-ref, profile,
     * issue tracer, tips, session-status panel, context ring, refine
     * prompt, send). Also constructs the {@link SessionStatusController}
     * which owns title rendering and the status indicator.
     *
     * Sets `this.todoPanel`, `this.checkpointSelector`, `this.cmInput`,
     * `this.draftController`, `this.profileSelector`,
     * `this.issueTracerButton`, `this.tipsButton`, `this.optimizeBtn`,
     * `this.sendBtn`, `this.statusController`.
     */
    private buildInputArea(root: HTMLElement, sessionTitleEl: HTMLElement): void {
        // ── TODO panel (docked just above the input container) ──────────────
        //
        // Lives below the message list and above the compose
        // card so it is always within thumb / cursor reach. The
        // panel collapses to a single-line header by default and
        // expands UPWARD (list rendered above the header) when
        // clicked — same ergonomic as a mobile bottom sheet, so
        // the user never has to scroll to the top of the chat to
        // see what the LLM is working on next.
        const todoPanelHost = root.createEl('div', { cls: 'session-todo-panel-host' });
        this.todoPanel = new TodoPanel(todoPanelHost);

        // ── Input container ───────────────────────────────────────────────────────
        const inputContainer = root.createEl('div', { cls: 'session-input-container' });

        // Checkpoint list control — full-width row docked to the top of the
        // compose card (dropdown opens as a sheet from the top edge).
        const checkpointRow = inputContainer.createEl('div', { cls: 'session-checkpoint-row' });
        this.checkpointSelector = createCheckpointSelector(checkpointRow, this.dropdownManager, {
            app: this.app,
            onGotoMessage: (messageId) => { void this.scrollToMessage(messageId); },
        });

        // Input area with CodeMirror 6 editor
        const inputRow = inputContainer.createEl('div', { cls: 'session-input-row' });
        const cmContainer = inputRow.createEl('div', { cls: 'session-cm-input' });
        this.cmInput = new CMInput(cmContainer, {
            app: this.app,
            placeholder: t('view.inputPlaceholder'),
            onEnter: () => {
                if (this.plugin.settings.enterToSend) {
                    void this.handleSend();
                    return true;
                }
                return false;
            },
            onFileRefClick: (path: string) => {
                // Open file on click
                const file = this.app.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    void this.app.workspace.getLeaf().openFile(file);
                }
            },
            onChange: () => {
                this.draftController.scheduleSave();
                // Live-sync the "Refine prompt" affordance: it only
                // makes sense to offer the action when there's
                // actual draft text to refine. Cheap to recompute
                // on every keystroke; the button just toggles its
                // `disabled` attribute.
                this.updateOptimizeBtnAvailability();
                // Note: the follow-up suggestion bar and insight preview card
                // are intentionally kept visible while the user is editing.
                // They will be dismissed in `appendBubble` the moment a new
                // user message is actually sent, so the user can still
                // reference / pick suggestions while drafting.
            },
        });
        this.draftController = new DraftInputController(
            this.sessionManager,
            () => this.cmInput.getContent(),
            (v) => this.cmInput.setContent(v),
        );

        // ── Thinking level selector ───────────────────────────────────────────
        const thinkingRow = inputContainer.createEl('div', { cls: 'session-thinking-row' });

        // ── Add file reference button (mirrors typing `[[`) ────────────────────
        const addFileRefBtn = thinkingRow.createEl('button', {
            cls: 'session-thinking-row__icon-btn',
            attr: { 'aria-label': t('view.addFileRef') },
        });
        setIcon(addFileRefBtn, 'brackets');
        setTooltip(addFileRefBtn, t('view.addFileRef'));
        addFileRefBtn.addEventListener('click', (e) => {
            e.preventDefault();
            this.cmInput.triggerFileRefSuggest();
        });

        // ── Profile selector (using DropdownManager) ───────────────────────────
        this.profileSelector = createProfileSelector(thinkingRow, this.plugin, this.dropdownManager);

        // ── Issue tracer button (mounted before Tips so Tips stays last) ──
        // The wrapper hides itself via CSS when zero issues are recorded,
        // so it costs no real estate during healthy sessions.
        this.issueTracerButton = createIssueTracerButton(thinkingRow, this.app);

        // ── Tips button (last in the row so existing controls keep their position) ──
        this.tipsButton = createTipsButton(
            thinkingRow,
            this.plugin,
            this.buildTipSessionViewAdapter(),
            this.dropdownManager,
        );

        // ── Right-aligned button group ────────────────────────────────────
        // Holds buttons that should sit on the right edge of the toolbar.
        // Pushed right via `margin-left: auto` on the group itself, so the
        // left-aligned controls above keep their natural packing order.
        // Order inside the group: session status → context ring → refine prompt → send.
        const thinkingRowRight = thinkingRow.createEl('div', {
            cls: 'session-thinking-row__right',
        });

        // ── Session status indicator ───────────────────────────────────────
        // Primary metric: compact token usage badge that also opens a
        // detailed panel on click. Placed first in the right toolbar so
        // the eye-flow is "status → context ring → refine → send".
        const sessionStatusEl = thinkingRowRight.createEl('div', {
            cls: 'session-toolbar__status',
        });
        const sessionStatusMainEl = sessionStatusEl.createEl('div', {
            cls: 'session-toolbar__status-main',
            attr: {
                role: 'button',
                tabindex: '0',
            },
        });
        setTooltip(sessionStatusMainEl, t('status.ariaLabel'));
        // Note: `session-dropdown-menu` MUST be the first class so that
        // DropdownManager derives the `--open` toggle class from it.
        const sessionStatusPanelEl = sessionStatusEl.createEl('div', {
            cls: 'session-dropdown-menu session-dropdown-menu--toolbar-up-right session-status-panel',
        });
        this.dropdownManager.registerToggle({
            wrapper: sessionStatusEl,
            button: sessionStatusMainEl,
            dropdown: sessionStatusPanelEl,
            onOpen: () => {
                // Refresh the compact toolbar indicator and context ring.
                // Panel rendering is deferred to onAfterOpen so that
                // DropdownManager.isActive() returns true (the guard
                // inside updateStatusDisplay relies on it).
                if (this.statusController) {
                    this.statusController.updateStatusDisplay();
                }
            },
            onAfterOpen: () => {
                // Re-render the panel now that isActive() is true.
                if (this.statusController) {
                    this.statusController.updateStatusDisplay();
                }
            },
        });

        // ── Context-window usage ring ──────────────────────────────────────
        // Percentage ring showing how much of the context window the most
        // recent API call consumed. Lives to the right of session status
        // so the eye-flow is "check status/usage → optimize prompt → send".
        const contextRingEl = thinkingRowRight.createEl('span', {
            cls: 'session-context-ring-host',
        });

        // ── Refine-prompt button ──────────────────────────────────────────
        // Calls the summarizer-tier LLM to rewrite the current draft for
        // clarity / AI-friendliness. Lives one slot to the left of the
        // send button so the natural eye-flow is "tweak → send".
        // Only enabled when (a) the draft is non-empty and (b) the
        // session is not currently streaming.
        this.optimizeBtn = thinkingRowRight.createEl('button', {
            cls: 'session-thinking-row__icon-btn session-optimize-btn',
            attr: { 'aria-label': t('view.optimizePrompt') },
        });
        setIcon(this.optimizeBtn, 'wand-sparkles');
        setTooltip(this.optimizeBtn, t('view.optimizePrompt'));
        this.optimizeBtn.disabled = true;
        this.optimizeBtn.addEventListener('click', () => void this.handleOptimizePrompt());

        this.sendBtn = thinkingRowRight.createEl('button', {
            cls: 'session-thinking-row__icon-btn session-send-btn',
            attr: { 'aria-label': t('view.sendMessage') },
        });
        setIcon(this.sendBtn, 'send');
        setTooltip(this.sendBtn, t('view.send'));
        this.sendBtn.addEventListener('click', () => void this.handleSend());

        // ── Construct status controller ─────────────────────────────────
        // Owns title rendering and the session-status indicator (token
        // usage, context ring, detail panel). Constructed here because
        // it needs DOM elements from both buildToolbar (sessionTitleEl)
        // and buildInputArea (status elements).
        this.statusController = new SessionStatusController({
            sessionTitleEl,
            sessionStatusEl,
            sessionStatusMainEl,
            sessionStatusPanelEl,
            contextRingEl,
            sessionManager: this.sessionManager,
            mcpManager: this.plugin.mcpManager,
            settings: this.plugin.settings,
            dropdownManager: this.dropdownManager,
            chat: () => this.chat,
            artifactStats: () => this.runtime?.artifactStore.stats() ?? null,
            isStreaming: () => this.isStreaming,
        });
        this.statusController.updateStatusDisplay();
    }

    async onClose() {
        // Clear draft save timer and save any pending draft
        this.draftController.clearTimer();

        // Cancel any in-flight prompt-refinement request — the
        // resulting draft would have nowhere to land once the view
        // is torn down, and the LLM bill is best avoided.
        this.abortInFlightOptimize();

        // Detach (NOT abort) the runtime so a background turn can keep
        // running in the pool. The pool decides retention based on
        // busy/idle state.
        this.detachFromCurrentRuntime();

        this.profileSelector.dispose();
        this.checkpointSelector?.dispose();
        this.tipsButton?.dispose();
        this.tipsButton = null;
        this.issueTracerButton?.dispose();
        this.issueTracerButton = null;
        this.statusController?.dispose();
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        this.dropdownManager.closeActive();
        // Clear bubble map + aborted-id set + drop continue-button ref
        this.bubbleList?.clear();
        // Drop the singleton streaming loader reference; its DOM node is
        // inside contentEl which will be torn down by the parent ItemView.
        this.streamingLoader?.dispose();
        // Disconnect the scroll controller's MutationObserver /
        // ResizeObserver / visualViewport listener so they do not keep
        // the (detached) messagesEl alive after the view closes.
        this.scroller?.detach();
        this.scroller?.setNearTopCallback(null);
        this.historyLoadingOverlay?.dispose();
    }

    /**
     * Whether a session switch / new-session operation is currently allowed.
     *
     * Streaming no longer blocks switches — switching while the AI is
     * mid-turn is the core feature this view now supports (the runtime
     * keeps running in the background; the pool decides retention).
     * We only need to serialize concurrent switches against each other.
     */
    canSwitchSession(): boolean {
        return !this.isSwitchingSession;
    }

    /**
     * Convenience guard for external callers: returns `true` if a session
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
     * view to a fresh, empty chat. Public so callers (e.g. editor menu
     * actions) can chain "create new session → drop a snippet into the
     * input" without re-implementing the save/switch dance.
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
            await this.draftController.flush();
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
            this.detachFromCurrentRuntime();
            this.sessionManager.createSession();
            await this.sessionManager.saveMetadata();
            this.clearViewDOM();
            await this.bindActiveSessionRuntime();
            new Notice(t('view.newSessionCreated'));
            return true;
        } finally {
            this.isSwitchingSession = false;
        }
    }

    /**
     * Roll back the conversation to before the given user message,
     * discarding any affected checkpoints, and restore the message
     * content to the input box for re-editing.
     *
     * Unlike branching, this operates in-place — the current session
     * is truncated rather than forked.
     */
    private async handleEditMessage(msg: ChatMessage): Promise<void> {
        if (msg.role !== 'user') return;
        if (!this.guardSwitchSession()) return;
        if (!this.runtime) return;

        const chat = this.runtime.chat;
        const messages = chat.messages;
        const anchorIdx = messages.findIndex(m => m.id === msg.id);
        if (anchorIdx < 0) return;

        // ── Check for affected checkpoints ──────────────────────────
        // Build a set of message IDs that will be truncated (from the
        // target message onwards). Any pending checkpoint whose anchor
        // falls into this set must be discarded.
        const truncatedIds = new Set<string>();
        for (let i = anchorIdx; i < messages.length; i++) {
            const m = messages[i];
            if (m) truncatedIds.add(m.id);
        }

        const store = this.runtime.checkpointStore;
        const checkpoints = store.checkpoints;
        const affectedPending = checkpoints.filter(
            cp => cp.status === 'pending' && truncatedIds.has(cp.anchorMessageId),
        );

        // ── Confirm before editing ──────────────────────────────────
        const streamingNow = this.isStreaming;
        let confirmMessage = t('view.editMessageConfirmMessage');
        if (streamingNow) {
            confirmMessage = `${confirmMessage}\n\n${t('view.editMessageConfirmAbortStreaming')}`;
        }
        const confirmed = await new CheckpointActionConfirmModal(
            this.app,
            t('view.editMessageConfirmTitle'),
            confirmMessage,
            t('view.editMessage'),
            'discard',
        ).waitForResult();
        if (!confirmed) return;

        // Stop an in-flight reply before truncating chat state.
        if (this.isStreaming) {
            this.abortInFlightOptimize();
            this.chat?.abort();
            if (!await this.waitForChatIdle()) {
                new Notice(t('view.editAbortTimeout'));
                return;
            }
        }

        // Discard affected checkpoints if any, earliest first so the
        // cascade rule (discard(id) → also discards all later pending)
        // handles the rest naturally.
        if (affectedPending.length > 0) {
            const [earliest] = affectedPending;
            if (earliest) await store.discard(earliest.id);
        }

        // ── Truncate messages before the anchor ─────────────────────
        const prefix = messages.slice(0, anchorIdx).map(m => ({
            ...m,
            streaming: false,
        }));

        const currentTokenUsage: TokenUsage = {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        };

        // Restore the chat agent to the truncated state
        chat.restoreState(prefix, currentTokenUsage);

        // Persist the truncated state via SessionManager
        await this.sessionManager.saveSession(
            this.runtime.sessionId,
            prefix,
            currentTokenUsage,
        );

        // ── Rebuild the view DOM ────────────────────────────────────
        this.clearViewDOM();
        // The runtime is still the same instance; we just truncated its
        // chat messages. Replay the UI from the new (truncated) state.
        await this.replayRuntimeUI(this.runtime, { fromCache: true });

        // ── Restore the message content to the input ────────────────
        this.cmInput.setContent(msg.content);
        this.cmInput.focus();
        this.draftController?.scheduleSave();

        new Notice(t('view.messageEdited'));
    }

    /**
     * Scroll to the user message that precedes the given message
     * (i.e. the user message that started the current turn).
     *
     * Uses message IDs from the data model, then looks up the
     * corresponding bubble. If the target bubble hasn't been rendered
     * yet (outside the lazy window), expands the window and scrolls to
     * the target as a single integrated operation to avoid competing
     * scroll-anchor-restore and scroll-to-target animations.
     */
    private handleJumpToPrevUser(msg: ChatMessage): void {
        this.jumpToUserMessage(this.bubbleList.findPrevUserMessageId(msg));
    }

    /** Scroll to the next (following) user message (ID-based). */
    private handleJumpToNextUser(msg: ChatMessage): void {
        this.jumpToUserMessage(this.bubbleList.findNextUserMessageId(msg));
    }

    /**
     * Single entry point for jump-to-user navigation. Always routes through
     * {@link ensureMessageVisible} so the rendered and not-yet-rendered cases
     * share one code path:
     *
     * - First latch auto-follow OFF. A jump is an explicit "leave the tail"
     *   gesture; without this, during streaming the MutationObserver would
     *   immediately re-pin the view to the bottom and undo the jump.
     * - Then `ensureMessageVisible(targetId, targetId)` expands the lazy
     *   window if needed and scrolls to the target with a synchronous
     *   `scrollTop` (+ flash highlight), avoiding the smooth-scroll animation
     *   that competing mutations can interrupt.
     */
    private jumpToUserMessage(targetId: string | null): void {
        if (!targetId) return;
        this.scroller.suppressAutoFollow();
        void this.ensureMessageVisible(targetId, targetId);
    }

    /** Returns true if the message has a previous user message in the data model. */
    private canJumpToPrevUser(msg: ChatMessage): boolean {
        return this.bubbleList.canJumpPrev(msg);
    }

    /** Returns true if the message has a next user message in the data model. */
    private canJumpToNextUser(msg: ChatMessage): boolean {
        return this.bubbleList.canJumpNext(msg);
    }

    private async handleNewChat() {
        await this.startNewSession();
    }

    private async handleSwitchSession(targetId: string) {
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return;
        }
        if (targetId === this.sessionManager.activeSessionId) return;

        this.isSwitchingSession = true;
        try {
            await this.draftController.flush();
            this.detachFromCurrentRuntime();
            // Just update list.json's activeSessionId. The old runtime's
            // own persistence layer is responsible for its session file.
            await this.sessionManager.switchTo(targetId);
            await this.sessionManager.ensureMessagesLoaded(targetId);
            this.clearViewDOM();
            await this.bindActiveSessionRuntime();
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
     * Busy guard: if a turn is streaming we refuse, because branching while
     * the assistant is still writing would surface a confusing "new session
     * but token counter still climbing" state in the UI — the source
     * session's runtime keeps counting even after we switch away.
     */
    private async handleBranchFromMessage(msg: ChatMessage): Promise<void> {
        if (msg.role !== 'user') return;
        if (this.isStreaming) {
            new Notice(t('view.branchWhileStreamingBlocked'));
            return;
        }
        if (!this.guardSwitchSession()) return;

        const sourceId = this.sessionManager.activeSessionId;

        this.isSwitchingSession = true;
        try {
            await this.draftController.flush();

            const result = await this.sessionManager.branchSession(sourceId, msg.id);
            if (!result) return;

            // Mirror the handleSwitchSession flow so the view's runtime, DOM,
            // and input state are rebuilt exactly as they would be after a
            // manual session switch.
            this.detachFromCurrentRuntime();
            await this.sessionManager.switchTo(result.newSessionId);
            await this.sessionManager.ensureMessagesLoaded(result.newSessionId);
            this.clearViewDOM();
            await this.bindActiveSessionRuntime();

            // Seed the input with the branched message so the user can
            // refine it before resending. draftController picks this up
            // through its scheduled save, matching the follow-up flow.
            this.cmInput.setContent(result.draftInput);
            this.cmInput.focus();
            this.draftController?.scheduleSave();

            new Notice(t('view.sessionBranched'));
        } finally {
            this.isSwitchingSession = false;
        }
    }

    /**
     * Detach the view's listener from the currently bound runtime and
     * hand it back to the pool. The pool decides whether to keep the
     * runtime warm (busy continuations are always retained; idle ones
     * are LRU-capped at `maxIdle`).
     *
     * Idempotent: safe to call when no runtime is bound.
     */
    private detachFromCurrentRuntime(): void {
        if (!this.runtime) return;
        const id = this.runtime.sessionId;
        try { this.detachRuntime?.(); } finally {
            this.detachRuntime = undefined;
        }
        // Unbind the checkpoint selector before releasing the runtime so
        // its change listener is removed cleanly.
        this.checkpointSelector?.setRuntime(undefined);
        // Unsubscribe from checkpoint-store changes; the badge will
        // refresh on the next dropdown open.
        this.unsubCheckpointChange?.();
        this.unsubCheckpointChange = null;
        this.runtime = undefined;
        this.plugin.runtimePool.release(id);
    }

    /**
     * Clear all view-private DOM and UI state, leaving the view ready
     * to bind a new runtime. Replaces the old `clearViewForSessionSwitch`
     * but, crucially, does NOT abort any chat or destroy any runtime —
     * those are owned by the pool now.
     */
    private clearViewDOM(): void {
        // speechSynthesis is a global singleton; cancel any in-flight
        // utterances regardless of which session triggered them.
        if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
        this.bubbleRenderer?.cancelSpeech();
        // Drop any pending refinement before the input is wiped — its
        // target draft is about to disappear with the session switch,
        // so the result would just be discarded by the draft-change
        // guard while still costing LLM tokens.
        this.abortInFlightOptimize();
        this.historyReplayAbort?.abort();
        this.historyReplayAbort = null;
        this.messageWindow?.reset();
        this.historyLoadingOverlay?.hide();
        this.scroller.resetScrollIntent();
        this.hideStreamingLoader();
        this.setInputLocked(false);

        // Clear draft save timer and reset draft state
        this.draftController.reset();

        this.followUpBar?.hide();
        // DOM-level dismissal only. Persisted insights (owned by the
        // SessionRuntime and stored in session metadata) survive the
        // switch so they reappear when the user returns to this session.
        this.insightCard?.hide();
        // Same contract for the TODO panel: hide the DOM but leave
        // the runtime's snapshot intact. `replayRuntimeUI` re-renders
        // the new runtime's snapshot below.
        this.todoPanel?.hide();
        // Detach the singleton streaming loader before emptying, then
        // reattach so it remains the sole instance and still lives at
        // the tail of messagesEl.
        this.streamingLoader.detach();
        this.messagesEl.empty();
        this.streamingLoader.reattachAfterEmpty();
        // Clear bubble map + aborted-id set + drop continue-button ref
        this.bubbleList?.clear();

        this.cmInput.clear();
        this.scrollToBottomBtn.hide();
        this.statusController.updateStatusDisplay();
        this.updateNewChatBtnState();
    }

    /**
     * Resolve the runtime for the session manager's currently active
     * id (from pool cache, or create one fresh), attach this view as a
     * listener, and replay the runtime's current state to the DOM.
     */
    private async bindActiveSessionRuntime(): Promise<void> {
        const id = this.sessionManager.activeSessionId;
        const cached = this.plugin.runtimePool.get(id);
        if (cached) {
            this.attachRuntime(cached);
            await this.replayRuntimeUI(cached, { fromCache: true });
        } else {
            // Fresh runtime — needs history loaded from disk first.
            await this.sessionManager.ensureMessagesLoaded(id);
            const runtime = this.plugin.runtimePool.create(id);
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
    private hydrateRuntimeFromDisk(runtime: SessionRuntime): void {
        const session = this.sessionManager.getSessionSync(runtime.sessionId);
        if (!session || session.messages.length === 0) return;

        const chat = runtime.chat;
        chat.restoreState(session.messages, session.tokenUsage);

        const summaries = this.sessionManager.getSessionSummaries(runtime.sessionId);
        if (summaries.length > 0) {
            chat.restoreSummaries(summaries);
            runtime.hasContextCompressed = true;
        }

        // Sub-agent inline messages (v2+ sessions only).
        const subAgentMessages = this.sessionManager.getSubAgentMessages();
        if (subAgentMessages && Object.keys(subAgentMessages).length > 0
                && typeof chat.restoreSubAgentMessages === 'function') {
            chat.restoreSubAgentMessages(subAgentMessages);
        }

        // Per-agent token usage breakdown (v3+ sessions only). Must be
        // called AFTER restoreState — see AgentOrchestrator.restoreAgentTokenBreakdown.
        const agentTokenBreakdown = this.sessionManager.getAgentTokenBreakdown();
        if (agentTokenBreakdown && typeof chat.restoreAgentTokenBreakdown === 'function') {
            chat.restoreAgentTokenBreakdown(agentTokenBreakdown);
        }

        // Persisted insight card state (post-feature sessions only).
        // Mirrors the draft-input restore — the user's last view of the
        // card should reappear when they return to (or reload into)
        // this session, without re-spending tokens to recompute it.
        const lastInsights = this.sessionManager.getSessionLastInsights(runtime.sessionId);
        if (lastInsights) {
            runtime.restoreInsightState(lastInsights);
        }

        // Persisted TODO state (v4 sessions only). Always restore the
        // runtime's snapshot from disk before the replay pass — the
        // panel is then projected from `runtime.getTodoState()` in
        // `replayRuntimeUI`, matching how insight state is handled.
        const todos = this.sessionManager.getSessionTodos(runtime.sessionId);
        if (todos) {
            runtime.restoreTodos(todos);
        }
    }

    /**
     * Render the runtime's current chat state into the (just-cleared)
     * view DOM. Used both for fresh runtimes (after disk hydration) and
     * cached runtimes (after a switch back from another session).
     *
     * For a cached runtime that is currently busy, this also re-shows
     * the typing indicator and locks the input so the UI immediately
     * reflects the in-flight turn. Any pending tool confirmations are
     * implicitly rendered via the bubble renderer reading
     * `runtime.pendingConfirmations` through `this.pendingConfirmations`.
     */
    private async replayRuntimeUI(
        runtime: SessionRuntime,
        opts: { fromCache: boolean },
    ): Promise<void> {
        const chat = runtime.chat;
        const messages = chat.messages;

        if (messages.length === 0) {
            this.messageWindow.reset();
            this.todoPanel.applyState(this.runtime?.getTodoState() ?? null);
            this.draftController.restore();
            this.statusController.updateStatusDisplay();
            this.updateNewChatBtnState();
            return;
        }

        const allUnits = buildDisplayUnits(messages, {
            getSubAgentMessages: typeof chat.getSubAgentMessages === 'function'
                ? (id) => chat.getSubAgentMessages!(id)
                : undefined,
        });

        const { initialStart, initialEnd } = this.messageWindow.init(allUnits);
        const unitsToRender = allUnits.slice(initialStart, initialEnd);
        const showOverlay = unitsToRender.length >= HISTORY_LOADING.showOverlayMinUnits;

        const ac = new AbortController();
        this.historyReplayAbort = ac;

        if (showOverlay) {
            this.historyLoadingOverlay.show(unitsToRender.length);
            this.setInputLocked(true);
        }

        try {
            await replayUnitsInFrames(unitsToRender, {
                appendUnit: (unit) => {
                    this.bubbleList.append({ ...unit.msg, streaming: false }, { trackInWindow: false });
                },
                onProgress: (done, total) => {
                    this.historyLoadingOverlay.setProgress(done, total);
                },
                signal: ac.signal,
            });

            if (ac.signal.aborted) return;

            this.messageWindow.mountSentinel(() => { void this.loadOlderMessages(); });
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                return;
            }
            throw err;
        } finally {
            this.historyLoadingOverlay.hide();
            this.historyReplayAbort = null;
            if (!runtime.isBusy) {
                this.setInputLocked(false);
            }
        }

        this.draftController.restore();
        this.forceScrollToBottom();
        this.statusController.updateStatusDisplay();
        this.updateNewChatBtnState();

        this.maybeShowFollowUpSuggestions();
        this.renderInsightFromRuntimeState(this.runtime?.getInsightState() ?? null);
        this.todoPanel.applyState(this.runtime?.getTodoState() ?? null);

        if (opts.fromCache && runtime.isBusy) {
            this.setInputLocked(true);
            this.showStreamingLoader();
        }
    }

    /**
     * Serialize a history-prepend operation. Each call waits for the previous
     * one to finish before running `work`, so {@link loadOlderMessages} and
     * {@link ensureMessageVisible} can't interleave their `replayUnitsInFrames`
     * batches against stale window bounds. The chain swallows errors internally
     * to stay alive; callers still observe their own rejection via the returned
     * promise.
     */
    private runHistoryMutation(work: () => Promise<void>): Promise<void> {
        const run = this.historyMutationChain.then(work, work);
        this.historyMutationChain = run.catch(() => { /* keep the chain alive */ });
        return run;
    }

    /**
     * Prepend older history bubbles above the current window, preserving
     * scroll position via a scrollHeight delta anchor.
     */
    private async loadOlderMessages(): Promise<void> {
        if (this.messageWindow.loadingOlder || !this.messageWindow.hasOlderUnrendered()) {
            return;
        }

        this.messageWindow.setLoadingOlder(true);
        try {
            await this.runHistoryMutation(async () => {
                // Re-check after acquiring the lock: an interleaved
                // ensureMessageVisible may have already rendered these units
                // while this load was queued behind it.
                if (!this.messageWindow.hasOlderUnrendered()) return;

                const newStart = Math.max(0, this.messageWindow.start - HISTORY_LOADING.olderBatchUnits);
                const units = this.messageWindow.slice(newStart, this.messageWindow.start);
                const anchor = this.messageWindow.getPrependAnchor();
                const anchorOffset = anchor ? this.scroller.captureAnchorScroll(anchor) : null;

                this.scroller.beginHistoryPrepend();
                try {
                    // Chronological order: each prepend inserts before the same anchor,
                    // so later units stack after earlier ones (0, 1, …, anchor). Reversing
                    // would yield descending order and scramble the conversation.
                    await replayUnitsInFrames(units, {
                        appendUnit: (unit) => {
                            this.bubbleList.prepend({ ...unit.msg, streaming: false }, anchor);
                        },
                        onProgress: () => { /* sentinel shows loading state */ },
                        signal: this.historyReplayAbort?.signal,
                    });
                    this.messageWindow.applyOlderBatch(newStart);
                    // Trim oldest rendered bubbles if the window grew past the limit
                    // BEFORE restoring the scroll anchor. trimTail removes DOM nodes
                    // from the top, which changes every remaining node's offsetTop.
                    // If we restore the scroll first and then trim, the anchor-based
                    // scroll position becomes stale — the viewport jumps because the
                    // anchor's offsetTop shrinks after trimming.
                    this.messageWindow.maybeTrimTail();
                    if (anchor && anchor.isConnected && anchorOffset !== null) {
                        this.scroller.restoreAnchorScroll(anchor, anchorOffset);
                    }
                } catch (err) {
                    if (!(err instanceof DOMException && err.name === 'AbortError')) {
                        throw err;
                    }
                } finally {
                    this.scroller.endHistoryPrepend();
                }
            });
        } finally {
            this.messageWindow.setLoadingOlder(false);
        }
    }

    /**
     * Expand the rendered window until `messageId` is in the DOM.
     *
     * @param messageId - The message whose display unit range must be loaded.
     * @param scrollToId - Optional: when provided, scroll to this specific
     *   bubble after loading instead of restoring the scroll anchor. Used
     *   for jump-to-message operations where the user explicitly navigates
     *   to a target; the anchor-restore path is for passive "load older"
     *   scrolling where the viewport should stay put.
     */
    private async ensureMessageVisible(messageId: string, scrollToId?: string): Promise<void> {
        await this.runHistoryMutation(async () => {
            const idx = this.messageWindow.findUnitIndex(messageId);
            if (idx < 0 || idx >= this.messageWindow.start) {
                // Already visible. If we still need to scroll, do it after a
                // double RAF so any in-flight layout from a concurrent load
                // (unlikely here, but defensive) has settled.
                if (scrollToId) {
                    this.scrollToBubbleSync(scrollToId);
                }
                return;
            }

            const units = this.messageWindow.slice(idx, this.messageWindow.start);
            // The prepend anchor is ALWAYS needed for correct DOM insertion
            // position (older messages go before the first rendered bubble).
            // When jumping we skip the scroll-anchor capture/restore because
            // we're going to scroll to the target after loading — preserving
            // the old viewport would create a visual "bounce".
            const isJump = !!scrollToId;
            const anchor = this.messageWindow.getPrependAnchor();
            const anchorOffset = isJump ? null : (anchor ? this.scroller.captureAnchorScroll(anchor) : null);
            const showOverlay = units.length >= HISTORY_LOADING.showOverlayMinUnits;

            if (showOverlay) {
                this.historyLoadingOverlay.show(units.length);
            }

            this.scroller.beginHistoryPrepend();
            try {
                await replayUnitsInFrames(units, {
                    appendUnit: (unit) => {
                        this.bubbleList.prepend({ ...unit.msg, streaming: false }, anchor);
                    },
                    onProgress: (done, total) => {
                        if (showOverlay) {
                            this.historyLoadingOverlay.setProgress(done, total);
                        }
                    },
                    signal: this.historyReplayAbort?.signal,
                });
                this.messageWindow.expandRenderedStart(idx);
                // Trim BEFORE any scroll, otherwise the anchor's / target's
                // offsetTop changes after the scroll position was set and the
                // viewport lands at a stale offset.
                this.messageWindow.maybeTrimTail();
                this.messageWindow.updateSentinel();
                if (isJump && scrollToId) {
                    // Jump mode: scroll to the target instead of restoring
                    // the anchor. Use a double RAF to let the browser flush
                    // layout after the bulk prepend + trim mutations before
                    // we read offsetTop and set scrollTop.
                    this.scheduleScrollToBubble(scrollToId);
                } else if (anchor && anchor.isConnected && anchorOffset !== null) {
                    this.scroller.restoreAnchorScroll(anchor, anchorOffset);
                }
            } catch (err) {
                if (!(err instanceof DOMException && err.name === 'AbortError')) {
                    throw err;
                }
            } finally {
                if (showOverlay) {
                    this.historyLoadingOverlay.hide();
                }
                this.scroller.endHistoryPrepend();
            }
        });
    }

    /**
     * Schedule a scroll to a specific bubble after the next two animation
     * frames. Double RAF ensures the browser has finished layout for any
     * recently-inserted DOM nodes (e.g. from {@link replayUnitsInFrames})
     * before we read `offsetTop`.
     */
    private scheduleScrollToBubble(messageId: string): void {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                this.scrollToBubbleSync(messageId);
            });
        });
    }

    /**
     * Immediately scroll a bubble into view using synchronous `scrollTop`
     * and flash the highlight class.
     *
     * Uses `scrollTop` (not `scrollIntoView`) to avoid the async smooth-
     * scroll animation which can be interrupted by competing DOM mutations
     * or conflicting scroll operations (e.g. after a bulk history prepend).
     */
    private scrollToBubbleSync(messageId: string): void {
        const bubble = this.bubbleList.messageBubbles.get(messageId);
        if (!bubble) return;
        // 80 px padding from the top so the bubble isn't flush against the
        // viewport edge and has some surrounding context visible.
        this.messagesEl.scrollTop = bubble.offsetTop - 80;
        bubble.addClass('session-bubble--highlight');
        window.setTimeout(() => bubble.removeClass('session-bubble--highlight'), 2000);
    }


    /**
     * Rebuild session dropdown content (called by DropdownManager onOpen)
     */
    private rebuildSessionDropdown(): void {
        this.sessionNavigator.rebuildDropdown();
    }

    private async openSessionSearch() {
        const modal = new SessionSearchModal(this.app, this.sessionManager);
        const result = await modal.waitForResult();

        if (result) {
            await this.handleSearchResultNavigation(result);
        }
    }

    private async handleSearchResultNavigation(result: SessionSearchResult) {
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return;
        }

        this.isSwitchingSession = true;
        try {
            await this.draftController.flush();
            this.detachFromCurrentRuntime();
            await this.sessionManager.switchTo(result.sessionId);
            await this.sessionManager.ensureMessagesLoaded(result.sessionId);
            this.clearViewDOM();
            await this.bindActiveSessionRuntime();

            // Scroll to the specific message
            await this.ensureMessageVisible(result.messageId);
            window.requestAnimationFrame(() => {
                void this.scrollToMessage(result.messageId);
            });
        } finally {
            this.isSwitchingSession = false;
        }
    }

    private async scrollToMessage(messageId: string) {
        await this.ensureMessageVisible(messageId);
        const bubble = this.bubbleList.messageBubbles.get(messageId);
        if (bubble) {
            // Scroll the message into view with some padding
            bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // Add a brief highlight effect
            bubble.addClass('session-bubble--highlight');
            window.setTimeout(() => {
                bubble.removeClass('session-bubble--highlight');
            }, 2000);
        }
    }

    // ── Send logic ───────────────────────────────────────────────────────────

    /**
     * Wait until the active runtime's chat turn finishes (idle), or
     * until `timeoutMs` elapses. Used after {@link IChatAgent.abort}
     * so follow-up mutations (edit / truncate) don't race the epilogue.
     */
    private waitForChatIdle(timeoutMs = 10_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        return new Promise(resolve => {
            const tick = () => {
                if (!this.isStreaming) {
                    resolve(true);
                    return;
                }
                if (Date.now() >= deadline) {
                    resolve(false);
                    return;
                }
                window.setTimeout(tick, 50);
            };
            tick();
        });
    }

    private async handleSend() {
        const text = this.cmInput.getContent().trim();

        if (this.isStreaming) {
            // Pressing the stop button should also kill any refinement
            // running on the side — the user clearly wants the chat
            // engine to wind down, and a stale refinement coming back
            // afterwards would write into an already-cleared draft.
            this.abortInFlightOptimize();
            this.chat?.abort();
            return;
        }

        if (!text) return;

        // A user clicking send has made up their mind about the draft
        // they want to ship — anything coming back from an in-flight
        // refinement would be applied to an empty input (post-clear)
        // or, worse, the next turn's draft. Cancel before we clear.
        this.abortInFlightOptimize();

        this.cmInput.clear();

        // Clear draft input since message is being sent
        this.draftController.clearDraft();

        await this.sendPrompt(text);
    }

    /**
     * Send a user prompt to the active runtime's chat agent. Thin wrapper
     * around `chat.prompt(text, ...)` that injects the per-turn options
     * shared by every entry point that submits a user message — the
     * primary input box (`handleSend`), follow-up suggestion clicks, and
     * the inline "continue" button on the tail error bubble.
     *
     * Does NOT touch `cmInput` or the draft controller — those are
     * responsibilities of input-bound entry points like `handleSend`.
     * Also does NOT guard against `isStreaming`; callers that have
     * abort-on-streaming semantics (e.g. the send button) must handle
     * that themselves before calling.
     *
     * The user bubble is rendered from inside chat.prompt()'s
     * synchronous onUserMessage callback so it can be keyed by the
     * agent's real message id (not a separately-minted optimistic
     * id). This is what keeps the message branch-able afterwards —
     * SessionManager.branchSession looks up the anchor by id in the
     * agent's own message cache. See chat-stream.ts: IChatAgent.prompt.
     */
    /**
     * Build the narrow adapter that the tips popover uses to interact
     * with this view. Kept as a per-call factory rather than a memoized
     * field so the closures always capture the current `this` — the
     * view itself outlives any single tips-button instance.
     */
    private buildTipSessionViewAdapter(): TipSessionViewAdapter {
        return {
            isPromptInputEmpty: () => this.cmInput.getContent().trim().length === 0,
            isStreaming: () => this.isStreaming,
            sendPromptForTip: async (text: string) => {
                // Guard streaming again at dispatch time. The popover
                // already disables the confirm button while streaming,
                // but a tip could theoretically execute after a brief
                // window in which a turn started; refuse rather than
                // crashing inside chat.prompt(). Surface a Notice so
                // the user understands why nothing happened.
                if (this.isStreaming) {
                    new Notice(t('view.sessionBusy'));
                    return;
                }
                await this.sendPrompt(text);
            },
            fillPromptDraft: (text: string) => this.fillPromptDraft(text),
            triggerFileRefSuggest: () => this.cmInput.triggerFileRefSuggest(),
        };
    }

    private async sendPrompt(text: string): Promise<void> {
        await this.ensureRuntimeAttached().chat.prompt(text, {
            allowedCapabilities: this.plugin.settings.allowedCapabilities,
            provider: createProviderForActiveProfileOf(this.plugin),
            // Pull thinkingLevel from the active profile. Older profiles
            // saved before this field existed leave it `undefined`, which
            // the providers treat the same as "auto" (param omitted).
            thinkingLevel: getActiveProfile(this.plugin.settings).thinkingLevel,
            summarizer: createSummarizerConfig(this.plugin),
            embedding: createEmbeddingConfig(this.plugin),
            embeddingFilter: createToolFilterOptions(this.plugin),
            onUserMessage: (msg) => {
                this.bubbleList.append(msg);
                this.forceScrollToBottom();
            },
        });
    }

    // ── ChatStream callbacks ─────────────────────────────────────────────────

    private handleMessageUpdate(msg: ChatMessage) {
        if (msg.retireBubble) {
            this.bubbleList.remove(msg.id);
            return;
        }

        const existing = this.bubbleList.messageBubbles.get(msg.id);

        if (existing) {
            if (msg.role === 'tool_call') {
                existing.classList.remove('session-bubble--tool-success', 'session-bubble--tool-warning', 'session-bubble--tool-error');
                if (msg.toolCallResult) {
                    existing.classList.add(`session-bubble--tool-${msg.toolCallResult.status}`);
                }
            }
            this.bubbleList.updateContent(existing, msg);
        } else {
            this.bubbleList.append(msg);
        }
    }

    /**
     * Handle a message update produced by a sub-agent during delegate_task execution.
     * Sub-agent messages are rendered inline as sibling bubbles in the main conversation,
     * with a colored side bar + badge identifying the originating sub-agent.
     *
     * The sub-agent's final assistant reply IS rendered (it is the actual answer
     * the user sees, since the delegate_task bubble no longer shows its result).
     */
    private handleSubAgentMessageUpdate(msg: ChatMessage, agentName: string): void {
        if (msg.retireBubble) {
            this.bubbleList.remove(msg.id);
            return;
        }

        const tagged = this.ensureSubAgentTag(msg, agentName);
        const existing = this.bubbleList.messageBubbles.get(tagged.id);
        if (existing) {
            this.bubbleList.updateContent(existing, tagged);
        } else {
            this.bubbleList.append(tagged);
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

    // ── DOM helpers ──────────────────────────────────────────────────────────

    private maybeScrollToBottom() {
        this.scroller.maybeScrollToBottom();
    }

    private forceScrollToBottom() {
        this.scroller.forceScrollToBottom();
    }

    // ── Follow-up suggestion bar ─────────────────────────────────────────

    /**
     * Inspect the most recent assistant reply and, if it ends with a set of
     * proposed next actions (either a structured <!--suggestions--> block or
     * a plain-text follow-up list), render them as one-shot quick-pick buttons
     * at the tail of the message list.
     */
    private maybeShowFollowUpSuggestions(): void {
        if (!this.followUpBar) return;
        const settings = this.plugin.settings;
        if (!settings.followUpSuggestionsEnabled) {
            this.followUpBar.hide();
            return;
        }

        const messages = this.chat?.messages ?? [];
        // Scan from the tail for the last non-aborted assistant message.
        let target: ChatMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m) continue;
            if (m.role === 'assistant' && !m.streaming && m.content) {
                if (this.bubbleList.isInterrupted(m)) break;
                target = m;
                break;
            }
            // Stop scanning if we already left the tail of the current turn.
            if (m.role === 'user') break;
        }
        if (!target) {
            this.followUpBar.hide();
            return;
        }

        const actions = extractSuggestions(target.content, {
            allowStructured: settings.followUpSuggestionsStructured === true,
        });
        if (actions.length === 0) {
            this.followUpBar.hide();
            return;
        }

        this.followUpBar.show(target.id, actions);
        this.maybeScrollToBottom();
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
    private handleFollowUpPick(action: SuggestedAction): void {
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
        if (this.isStreaming) {
            this.followUpBar?.hide();
            return;
        }
        void this.sendPrompt(action.prompt);
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
                void this.app.workspace.openLinkText(
                    resolveLinkOpenText(this.app, action.path),
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

    // ── Conversation insights ────────────────────────────────────────────

    /**
     * Click handler for the per-bubble "Extract insights" action in the
     * bubble action bar (the manual counterpart to the runtime's
     * automatic post-finish extraction).
     *
     * Visible feedback for "no summarizer configured" lives here rather
     * than in {@link extractInsightsForMessage} so the helper stays
     * safe to call from background paths that should fail silently.
     */
    private async handleExtractInsights(assistantMsg: ChatMessage): Promise<void> {
        if (this.isStreaming) {
            new Notice(t('view.sessionBusy'));
            return;
        }
        if (!this.runtime) return;

        const insightsModel = createInsightsConfig(this.plugin);
        if (!insightsModel) {
            new Notice(t('view.insightExtractionUnavailable'));
            return;
        }

        await extractInsightsForMessage(this.plugin, this.runtime, assistantMsg);
    }

    /**
     * Click handler for the per-item "Deepen" button on the insight card.
     *
     * Sends (or, when a draft already exists, prefills) a follow-up
     * prompt asking the model to expand on the chosen insight. The new
     * assistant reply will naturally trigger another extraction pass
     * via the runtime's onFinish hook.
     */
    private handleInsightDeepen(insight: ConversationInsight): void {
        if (this.isStreaming) return;

        const prompt = buildInsightDeepenPrompt({
            title: insight.title,
            summary: insight.summary,
            tags: insight.tags,
            linkedNotes: insight.linkedNotes,
        });

        // Don't trash the user's in-progress message — surface the
        // generated prompt as a draft so they can decide what to do.
        if (this.cmInput.getContent().trim().length > 0) {
            this.cmInput.setContent(prompt);
            this.cmInput.focus();
            this.draftController?.scheduleSave();
            return;
        }

        this.cmInput.setContent(prompt);
        void this.handleSend();
    }

    /**
     * Public entry for callers outside the session view (editor right-click
     * actions like "Explain" / "Auto-tag") that want to park a fully-formed
     * prompt in the input editor for the user to review and send manually.
     *
     * Behavior is deliberately "fill or refuse", never "fill or auto-send":
     * - If the input is empty: load `prompt` into the input as a draft,
     *   focus it, and persist it via the draft controller. The user
     *   reviews and presses Send when ready.
     * - If the input already contains a non-empty draft: surface a Notice
     *   explaining why the action was refused and leave the input
     *   untouched. We never silently replace user-authored text.
     *
     * Why not auto-send on empty input?
     *   These entry points dispatch boilerplate prompts (e.g. "Please
     *   auto-tag [[X]]") that the user often wants to tweak before
     *   sending. Auto-sending forces the user into a "stop and edit"
     *   workflow whenever they want to refine the prompt; parking it as a
     *   draft is the strictly more controllable default.
     *
     * The session view is expected to already be open/active by the
     * caller so we can focus the input deterministically.
     *
     * Returns `true` when the prompt was loaded into the input,
     * `false` when refused.
     */
    fillPromptDraft(prompt: string): boolean {
        if (!prompt) return false;

        const draft = this.cmInput.getContent().trim();
        if (draft.length > 0) {
            new Notice(t('view.inputHasDraftNotice'));
            return false;
        }

        this.cmInput.setContent(prompt);
        this.cmInput.focus();
        this.draftController?.scheduleSave();
        // Surface a success Notice as well. On mobile (or when the session
        // view sits behind another leaf on desktop) the input change is
        // not visually observable, so without this Notice the user has no
        // signal that the action did anything at all.
        new Notice(t('view.promptFilledNotice'));
        return true;
    }

    private setInputLocked(locked: boolean) {
        setTooltip(this.sendBtn, locked ? t('view.stop') : t('view.send'));
        this.sendBtn.setAttr('aria-label', locked ? t('view.stopGenerating') : t('view.sendMessage'));
        setIcon(this.sendBtn, locked ? 'square' : 'send');
        // Flip the visual state — accent (send) ↔ error (stop) — via a
        // modifier class so the toolbar-sized button stays distinguishable
        // from neighbouring icon buttons while preserving the original
        // "click again to abort" affordance.
        this.sendBtn.toggleClass('is-streaming', locked);
        // Refining the prompt while a turn is in flight makes no sense —
        // the result would land on a draft the user can't actually send
        // until the turn finishes. Lock the affordance in lockstep with
        // the send button to keep the two states coherent.
        this.updateOptimizeBtnAvailability();
        // Keep the insight card's "Deepen" buttons in lockstep with the
        // chat send button: while a turn is in flight, no new turn may
        // be triggered (including from the insight card).
        this.insightCard?.setBusy(locked);
        // Note: Input remains editable during streaming - user can type but cannot send
        // The send button becomes a stop button when locked
    }

    /**
     * Recompute whether the "Refine prompt" button should be clickable.
     *
     * Disabled when ANY of:
     *   - the draft is empty / whitespace-only (nothing to refine);
     *   - a turn is currently streaming (the resulting draft would have
     *     nowhere to go until the user can press send again);
     *   - a refinement call is already in flight (the spinner state
     *     locks the button until the previous call resolves).
     *
     * Cheap enough to call on every keystroke + every lock change.
     */
    private updateOptimizeBtnAvailability(): void {
        if (!this.optimizeBtn) return;
        const busy = this.optimizeAbort !== null;
        const empty = this.cmInput.getContent().trim().length === 0;
        const locked = this.isStreaming;
        this.optimizeBtn.disabled = busy || empty || locked;
    }

    /**
     * Cancel any in-flight prompt-refinement request and reset the
     * button's busy visuals immediately.
     *
     * Called from every code path that invalidates the refinement's
     * target draft — view close, session switch, and "send now" —
     * so the LLM tokens aren't spent on a result we'd just discard
     * via the draft-change guard.
     *
     * Synchronously clears `this.optimizeAbort` so a follow-up
     * `handleOptimizePrompt()` started in the same JS turn can install
     * a fresh controller without colliding with the just-aborted one;
     * the in-flight handler's `finally` block detects this via a
     * controller-identity check and skips its own cleanup.
     */
    private abortInFlightOptimize(): void {
        const controller = this.optimizeAbort;
        if (!controller) return;
        this.optimizeAbort = null;
        controller.abort();
        // Touch the button defensively — the handler is awaiting an
        // abort rejection in microtask-land and won't run its finally
        // until this turn yields, so we own the visuals (icon swap +
        // busy class) until then.
        if (this.optimizeBtn) {
            this.optimizeBtn.removeClass('is-busy');
            setIcon(this.optimizeBtn, 'wand-sparkles');
        }
        this.updateOptimizeBtnAvailability();
    }

    /**
     * Click handler for the toolbar's "Refine prompt" button.
     *
     * Pipeline:
     *   1. Validate the draft is non-empty and no other refinement is
     *      already running (defensive; the button's own disabled state
     *      should already prevent both).
     *   2. Resolve the summarizer model config. When no summarizer
     *      profile is configured, surface a Notice pointing at the
     *      relevant settings section and bail.
     *   3. Locate the most recent COMPLETED assistant turn (via
     *      {@link findTailTurn}) for disambiguation context. Missing
     *      context is fine — the optimizer omits the block entirely
     *      in that case.
     *   4. Issue the one-shot LLM call. The button enters a "busy"
     *      visual state (spinning-wand class + disabled attr) until
     *      the call resolves; a stored {@link AbortController} lets us
     *      pre-empt the call if the input changes underneath us.
     *   5. On success, replace the draft with the refined text, push
     *      it through the draft controller so it survives reloads,
     *      and refocus the editor for an immediate "send" follow-up.
     */
    private async handleOptimizePrompt(): Promise<void> {
        const draft = this.cmInput.getContent().trim();
        if (!draft) return;
        if (this.isStreaming) {
            new Notice(t('view.sessionBusy'));
            return;
        }
        if (this.optimizeAbort) return;

        const modelConfig = createSummarizerConfig(this.plugin);
        if (!modelConfig) {
            new Notice(t('view.optimizePromptUnavailable'));
            return;
        }

        // Tail context is optional — the optimizer treats both sides of
        // the previous turn as elidable, so we forward whatever
        // `findTailTurn` finds. Including the user side disambiguates
        // contrastive references ("again", "this time", "like before")
        // that the AI-side reply alone cannot resolve; see the
        // PREVIOUS_TURN section of prompt-optimizer.ts.
        const { user, assistant } = findTailTurn(this.chat?.messages ?? []);
        const userMessage = (user?.content ?? '').trim();
        const assistantReply = (assistant?.content ?? '').trim();

        const controller = new AbortController();
        this.optimizeAbort = controller;
        // Swap the wand icon for a dedicated spinner while the LLM
        // call is in flight. Rotating the wand directly looked wrong
        // because the icon isn't rotationally symmetric; `loader-2`
        // is the codebase-wide convention for in-flight feedback and
        // pairs cleanly with the `is-busy` keyframe animation.
        setIcon(this.optimizeBtn, 'loader-2');
        this.optimizeBtn.addClass('is-busy');
        this.updateOptimizeBtnAvailability();

        try {
            const refined = await optimizePrompt(
                modelConfig,
                { draft, userMessage, assistantReply },
                controller.signal,
            );
            // Only apply the result when the draft hasn't changed
            // underneath us during the call — otherwise the user has
            // already started a new thought and we'd clobber it.
            const currentDraft = this.cmInput.getContent().trim();
            if (currentDraft !== draft) return;

            this.cmInput.setContent(refined);
            this.cmInput.focus();
            this.draftController?.scheduleSave();
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') {
                // Silent — caller-initiated cancellation needs no notice.
                return;
            }
            if (err instanceof PromptOptimizationError) {
                new Notice(t('view.optimizePromptFailed'));
                return;
            }
            console.warn('[PromptOptimizer] refinement failed:', err);
            new Notice(t('view.optimizePromptFailed'));
        } finally {
            // Identity guard — `abortInFlightOptimize()` (view close /
            // session switch / send) may have already nulled the field
            // and reset visuals on our behalf; running again would
            // clobber a freshly-installed controller from a new
            // refinement that was started during the same turn.
            if (this.optimizeAbort === controller) {
                this.optimizeAbort = null;
                this.optimizeBtn.removeClass('is-busy');
                setIcon(this.optimizeBtn, 'wand-sparkles');
                this.updateOptimizeBtnAvailability();
            }
        }
    }

    private showStreamingLoader() {
        this.streamingLoader.show();
        this.maybeScrollToBottom();
    }

    private hideStreamingLoader() {
        this.streamingLoader.hide();
    }

    private hasUserMessages(): boolean {
        return this.chat ? this.chat.messages.some(m => m.role === 'user' || m.role === 'assistant') : false;
    }

    private updateNewChatBtnState() {
        if (this.newChatBtn) {
            this.newChatBtn.disabled = !this.hasUserMessages();
        }
        this.sessionNavigator?.updateButtonVisibility();
        // Title update is handled separately by callers when needed;
        // the status controller may not exist yet during buildToolbar.
        this.statusController?.updateTitle();
    }

    private async maybeGenerateSessionTitle() {
        // Kept as a thin wrapper for parity with the previous API.
        // The runtime owns automatic generation on turn completion
        // now (see runtime-factory's onFinish); this remains so a
        // future hook can force a regen without re-importing the
        // helper.
        await maybeGenerateSessionTitle(
            this.sessionManager,
            createSummarizerConfig(this.plugin),
            () => this.statusController.updateTitle(),
        );
    }

    // ── Export session ──────────────────────────────────────────────────────

    private exportSession() {
        if (!this.chat) {
            new Notice('No active chat to export');
            return;
        }
        const messages = this.chat.messages.filter(msg => msg.role === 'user' || msg.role === 'assistant');
        if (messages.length === 0) {
            new Notice('No messages to export');
            return;
        }
        void exportSessionToVault(this.plugin, messages);
    }
}
