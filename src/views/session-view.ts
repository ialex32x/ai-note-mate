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
import { getActiveEmbeddingConfig, getActiveProfile } from '../settings';
import { exportSessionToVault } from '../services/session-exporter';
import { ALL_TOOL_CAPABILITIES } from '../services/llm-provider';
import { inferModelContextWindow } from '../services/model-context-window';
import NoteAssistantPlugin from 'main';
import { t } from '../i18n';
import { SessionManager } from '../session-manager';
import { SessionSearchModal, SessionSearchResult } from '../modals/session-search-modal';
import {
    DropdownManager,
    BubbleRenderer,
    SessionStatusDisplay,
    type EmbeddingPanelInfo,
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
import { openFileInWorkspace } from '../utils/workspace-utils';
import {
    createProfileSelector, type ProfileSelectorHandle,
    createCapabilitiesSelector, type CapabilitiesSelectorHandle,
    createCheckpointSelector, type CheckpointSelectorHandle,
    createTipsButton, type TipsButtonHandle,
    createIssueTracerButton, type IssueTracerButtonHandle,
} from '../components/session/toolbar';
import type { TipSessionViewAdapter } from '../services/tips';
import { CMInput } from '../components/cm-input';
import {
    ScrollController,
    StreamingLoader,
    showInitializationError,
    appendErrorBubble,
    updateSessionTitle as renderSessionTitle,
    handleTitleClick,
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
    private contextRingEl!: HTMLElement;
    /**
     * AbortController for an in-flight prompt-refinement call. Held on
     * the view so a follow-up edit / send action can pre-empt a stale
     * refinement without leaking the LLM request.
     */
    private optimizeAbort: AbortController | null = null;
    private sessionStatusEl!: HTMLElement;
    private sessionStatusMainEl!: HTMLElement;
    private sessionStatusPanelEl!: HTMLElement;
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
    /** Flag to prevent concurrent session switches */
    private isSwitchingSession = false;
    private scrollToBottomBtn!: HTMLButtonElement;
    private newChatBtn!: HTMLButtonElement;
    private sessionNavigator!: SessionNavigator;
    private sessionTitleEl!: HTMLElement;

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
    /** Maps message id → the DOM element currently rendering that message */
    private messageBubbles: Map<string, HTMLElement> = new Map();
    /** Set of message IDs that were aborted by the user */
    private abortedMessageIds: Set<string> = new Set();

    /**
     * Singleton reference to the inline "continue" button on the *current*
     * tail error bubble, when one exists. Invariant: at most one such
     * button is alive at any time, and it lives only on the conversation
     * tail. Anything that pushes new content past that error tail
     * (a new chat bubble, a fresh error replacing it, a session switch)
     * must call {@link clearLastErrorContinueBtn} before mutating the DOM.
     */
    private lastErrorContinueBtn: HTMLElement | null = null;

    // ── Draft input debounce ────────────────────────────────────────────────
    private draftController!: DraftInputController;

    // ── Toolbar selectors ────────────────────────────────────────────────────────────
    private profileSelector!: ProfileSelectorHandle;
    private capabilitiesSelector!: CapabilitiesSelectorHandle;
    private checkpointSelector!: CheckpointSelectorHandle;
    private tipsButton: TipsButtonHandle | null = null;
    private issueTracerButton: IssueTracerButtonHandle | null = null;
    /** Settings-change listener that keeps the capabilities toolbar in sync. */
    private onSettingsChangedForCapabilities: (() => void) | null = null;
    /**
     * MCP-manager change listener that refreshes the session-status panel
     * while it is open, so connection/disconnection events update live
     * without requiring the user to reopen the panel.
     */
    private onMcpStateChangedForStatusPanel: (() => void) | null = null;

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
                this.scroller.restoreAutoFollow();
                this.hideStreamingLoader();
                this.setInputLocked(false);
                // Persistence + title generation + insight extraction
                // are all owned by the runtime; the view only needs to
                // refresh derived UI and re-render the (deterministic,
                // cheap) follow-up suggestion bar from the new tail
                // assistant reply.
                this.updateSessionTitle();
                this.maybeShowFollowUpSuggestions();
                this.updateNewChatBtnState();
                break;
            case 'abort':
                this.scroller.restoreAutoFollow();
                this.hideStreamingLoader();
                this.handleAbort(ev.msg);
                break;
            case 'usage-update':
                this.updateSessionStatusDisplay();
                break;
            case 'error':
                console.warn('ChatStream error:', ev.err);
                this.scroller.restoreAutoFollow();
                this.hideStreamingLoader();
                this.setInputLocked(false);
                this.appendErrorBubble(ev.err.message);
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
                this.updateSessionTitle();
                break;
            case 'confirm-tool-call': {
                // The runtime already recorded the resolver in its
                // pendingConfirmations map. We need the corresponding
                // bubble to re-render its Allow / Deny UI now that a
                // resolver exists; trigger that by re-rendering the
                // bubble if it's already on screen.
                const bubble = this.messageBubbles.get(ev.messageId);
                if (bubble) {
                    const msg = this.chat?.messages.find(m => m.id === ev.messageId);
                    if (msg) this.updateBubbleContent(bubble, msg);
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

        // Mobile keyboard handling with VirtualKeyboard API
        if (Platform.isMobile && 'virtualKeyboard' in navigator) {
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

        // Load cached sessions from disk
        await this.sessionManager.loadFromCache();

        try {
            // Pre-warm speechSynthesis voice engine
            if (!Platform.isMobile && 'speechSynthesis' in window) {
                speechSynthesis.getVoices();
            }

            // ── Toolbar (top) ────────────────────────────────────────────────────
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
            });
            this.sessionNavigator.mount(leftGroup);

            // Session status indicator (primary metric: token usage).
            // Structure:
            //   .session-toolbar__status            (wrapper, positioning only; no hover/interaction)
            //     .session-toolbar__status-main     (the actual button: click, hover, tooltip)
            //     .session-dropdown-menu ...         (details panel; independent hover/tooltip)
            // Panel is kept as a child of the wrapper so DropdownManager's
            // outside-click detection (wrapper.contains) treats clicks inside
            // the panel as "inside". The button and panel are visually/interactively
            // independent — hovering the panel neither highlights the button nor
            // shows the button's tooltip.
            this.sessionStatusEl = leftGroup.createEl('div', {
                cls: 'session-toolbar__status',
            });
            this.sessionStatusMainEl = this.sessionStatusEl.createEl('div', {
                cls: 'session-toolbar__status-main',
                attr: {
                    role: 'button',
                    tabindex: '0',
                },
            });
            setTooltip(this.sessionStatusMainEl, t('status.ariaLabel'));
            // Note: `session-dropdown-menu` MUST be the first class so that
            // DropdownManager derives the `--open` toggle class from it.
            this.sessionStatusPanelEl = this.sessionStatusEl.createEl('div', {
                cls: 'session-dropdown-menu session-dropdown-menu--toolbar session-status-panel',
            });
            this.dropdownManager.registerToggle({
                wrapper: this.sessionStatusEl,
                button: this.sessionStatusMainEl,
                dropdown: this.sessionStatusPanelEl,
                onOpen: () => {
                    if (this.chat) {
                        const profile = getActiveProfile(this.plugin.settings);
                        const max = profile.maxTokens > 0 ? profile.maxTokens : inferModelContextWindow(profile.model);
                        SessionStatusDisplay.renderPanel(
                            this.sessionStatusPanelEl,
                            this.chat,
                            max,
                            this.plugin.mcpManager,
                            this.computeEmbeddingPanelInfo(),
                            this.runtime?.artifactStore.stats() ?? null,
                        );
                    } else {
                        this.sessionStatusPanelEl.empty();
                    }
                },
            });
            this.updateSessionStatusDisplay();

            // Center group: session title
            const centerGroup = toolbar.createEl('div', { cls: 'session-toolbar__group session-toolbar__group--center' });
            this.sessionTitleEl = centerGroup.createEl('span', { cls: 'session-toolbar__title' });
            this.sessionTitleEl.addEventListener('click', () => this.handleTitleClick(centerGroup));

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

            // ── Message list ─────────────────────────────────────────────────────
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
            setIcon(addFileRefBtn, 'at-sign');
            setTooltip(addFileRefBtn, t('view.addFileRef'));
            addFileRefBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.cmInput.triggerFileRefSuggest();
            });

            // ── Profile selector (using DropdownManager) ───────────────────────────
            this.profileSelector = createProfileSelector(thinkingRow, this.plugin, this.dropdownManager);

            // ── Capabilities selector (using DropdownManager) ────────────────────────
            this.capabilitiesSelector = createCapabilitiesSelector(thinkingRow, this.dropdownManager, {
                initial: this.plugin.settings.allowedCapabilities,
                onChange: (allowed) => {
                    // Only persist when actually different to avoid feedback
                    // loops with the settings-change listener below.
                    const current = this.plugin.settings.allowedCapabilities ?? [];
                    if (
                        current.length === allowed.length
                        && current.every((c: string, i: number) => allowed[i] === c)
                    ) {
                        return;
                    }
                    this.plugin.settings.allowedCapabilities = allowed;
                    void this.plugin.saveSettings();
                },
            });
            // Keep the toolbar selector in sync with external settings changes
            // (e.g. toggled from the global settings tab while a session is open).
            this.onSettingsChangedForCapabilities = () => {
                this.capabilitiesSelector.setAllowed(this.plugin.settings.allowedCapabilities);
            };
            this.plugin.onSettingsChange(this.onSettingsChangedForCapabilities);

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
            // Order inside the group: context ring → refine prompt → send.
            const thinkingRowRight = thinkingRow.createEl('div', {
                cls: 'session-thinking-row__right',
            });

            // ── Context-window usage ring ──────────────────────────────────────
            // Percentage ring showing how much of the context window the most
            // recent API call consumed. Lives left of the refine-prompt button
            // so the eye-flow is "check usage → optimize prompt → send".
            this.contextRingEl = thinkingRowRight.createEl('span', {
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

            // Reflect live MCP connection state in the session-status panel
            // while it is open. The panel is also refreshed on demand from
            // `updateSessionStatusDisplay()`; this listener covers state
            // transitions that happen independently of token-usage updates.
            this.onMcpStateChangedForStatusPanel = () => {
                if (!this.chat) return;
                if (!this.dropdownManager.isActive(this.sessionStatusEl)) return;
                const profile = getActiveProfile(this.plugin.settings);
                const max = profile.maxTokens > 0 ? profile.maxTokens : inferModelContextWindow(profile.model);
                SessionStatusDisplay.renderPanel(
                    this.sessionStatusPanelEl,
                    this.chat,
                    max,
                    this.plugin.mcpManager,
                    this.computeEmbeddingPanelInfo(),
                    this.runtime?.artifactStore.stats() ?? null,
                );
            };
            this.plugin.mcpManager?.onChange(this.onMcpStateChangedForStatusPanel);

            // ── Restore session UI from cache ────────────────────────────────
            await this.bindActiveSessionRuntime();
        } catch (error) {
            showInitializationError(this.contentEl, error, () => { void this.onOpen(); });
        }
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
        if (this.onSettingsChangedForCapabilities) {
            this.plugin.offSettingsChange(this.onSettingsChangedForCapabilities);
            this.onSettingsChangedForCapabilities = null;
        }
        if (this.onMcpStateChangedForStatusPanel) {
            this.plugin.mcpManager?.offChange(this.onMcpStateChangedForStatusPanel);
            this.onMcpStateChangedForStatusPanel = null;
        }
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        this.dropdownManager.closeActive();
        this.messageBubbles.clear();
        // Drop the dangling continue-button reference too — the DOM is
        // about to be torn down by the parent ItemView.
        this.lastErrorContinueBtn = null;
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
        this.messageBubbles.clear();
        this.abortedMessageIds.clear();
        // The DOM node is already gone via messagesEl.empty(); just drop
        // the dangling reference so the next session starts clean.
        this.lastErrorContinueBtn = null;

        this.cmInput.clear();
        this.scrollToBottomBtn.hide();
        this.updateSessionStatusDisplay();
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
            this.updateSessionStatusDisplay();
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
                    this.appendBubble({ ...unit.msg, streaming: false }, { trackInWindow: false });
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
        this.updateSessionStatusDisplay();
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
     * Prepend older history bubbles above the current window, preserving
     * scroll position via a scrollHeight delta anchor.
     */
    private async loadOlderMessages(): Promise<void> {
        if (this.messageWindow.loadingOlder || !this.messageWindow.hasOlderUnrendered()) {
            return;
        }

        this.messageWindow.setLoadingOlder(true);
        const newStart = Math.max(0, this.messageWindow.start - HISTORY_LOADING.olderBatchUnits);
        const units = this.messageWindow.slice(newStart, this.messageWindow.start);
        const anchor = this.messageWindow.getPrependAnchor();
        const anchorOffset = anchor ? this.scroller.captureAnchorScroll(anchor) : null;

        this.scroller.beginHistoryPrepend();
        try {
            const reversed = [...units].reverse();
            await replayUnitsInFrames(reversed, {
                appendUnit: (unit) => {
                    this.prependBubble({ ...unit.msg, streaming: false }, anchor);
                },
                onProgress: () => { /* sentinel shows loading state */ },
                signal: this.historyReplayAbort?.signal,
            });
            this.messageWindow.applyOlderBatch(newStart);
            if (anchor && anchorOffset !== null) {
                this.scroller.restoreAnchorScroll(anchor, anchorOffset);
            }
        } catch (err) {
            if (!(err instanceof DOMException && err.name === 'AbortError')) {
                throw err;
            }
        } finally {
            this.messageWindow.setLoadingOlder(false);
            this.scroller.endHistoryPrepend();
        }
    }

    /**
     * Expand the rendered window until `messageId` is in the DOM, then
     * let the caller scroll to it.
     */
    private async ensureMessageVisible(messageId: string): Promise<void> {
        const idx = this.messageWindow.findUnitIndex(messageId);
        if (idx < 0 || idx >= this.messageWindow.start) {
            return;
        }

        const units = this.messageWindow.slice(idx, this.messageWindow.start);
        const anchor = this.messageWindow.getPrependAnchor();
        const anchorOffset = anchor ? this.scroller.captureAnchorScroll(anchor) : null;
        const showOverlay = units.length >= HISTORY_LOADING.showOverlayMinUnits;

        if (showOverlay) {
            this.historyLoadingOverlay.show(units.length);
        }

        this.scroller.beginHistoryPrepend();
        try {
            const reversed = [...units].reverse();
            await replayUnitsInFrames(reversed, {
                appendUnit: (unit) => {
                    this.prependBubble({ ...unit.msg, streaming: false }, anchor);
                },
                onProgress: (done, total) => {
                    if (showOverlay) {
                        this.historyLoadingOverlay.setProgress(done, total);
                    }
                },
                signal: this.historyReplayAbort?.signal,
            });
            this.messageWindow.expandRenderedStart(idx);
            if (anchor && anchorOffset !== null) {
                this.scroller.restoreAnchorScroll(anchor, anchorOffset);
            }
            this.messageWindow.updateSentinel();
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
        const bubble = this.messageBubbles.get(messageId);
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
            allowedCapabilities: (() => {
                const allowed = this.capabilitiesSelector.getAllowed();
                return allowed.length < ALL_TOOL_CAPABILITIES.length ? allowed : undefined;
            })(),
            provider: createProviderForActiveProfileOf(this.plugin),
            // Pull thinkingLevel from the active profile. Older profiles
            // saved before this field existed leave it `undefined`, which
            // the providers treat the same as "auto" (param omitted).
            thinkingLevel: getActiveProfile(this.plugin.settings).thinkingLevel,
            summarizer: createSummarizerConfig(this.plugin),
            embedding: createEmbeddingConfig(this.plugin),
            embeddingFilter: createToolFilterOptions(this.plugin),
            onUserMessage: (msg) => {
                this.appendBubble(msg);
                this.forceScrollToBottom();
            },
        });
    }

    // ── ChatStream callbacks ─────────────────────────────────────────────────

    private handleMessageUpdate(msg: ChatMessage) {
        const existing = this.messageBubbles.get(msg.id);

        if (existing) {
            if (msg.role === 'tool_call') {
                existing.classList.remove('session-bubble--tool-success', 'session-bubble--tool-warning', 'session-bubble--tool-error');
                if (msg.toolCallResult) {
                    existing.classList.add(`session-bubble--tool-${msg.toolCallResult.status}`);
                }
            }
            this.updateBubbleContent(existing, msg);
        } else {
            this.appendBubble(msg);
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
        const tagged = this.ensureSubAgentTag(msg, agentName);
        const existing = this.messageBubbles.get(tagged.id);
        if (existing) {
            this.updateBubbleContent(existing, tagged);
        } else {
            this.appendBubble(tagged);
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

    private appendBubble(
        msg: ChatMessage,
        opts: { trackInWindow?: boolean; scrollMode?: 'follow' | 'none' } = {},
    ): HTMLElement {
        const trackInWindow = opts.trackInWindow ?? true;
        const scrollMode = opts.scrollMode ?? 'follow';

        const build = () => this.createAndRenderBubble(msg);

        const bubble = scrollMode === 'follow'
            ? this.scroller.runWithAutoFollow(build)
            : build();

        if (trackInWindow) {
            this.messageWindow.registerAppendedUnit({ msg });
        }
        return bubble;
    }

    /**
     * Insert a bubble before an existing anchor node (older-history
     * prepend). Does not auto-scroll to the tail.
     */
    private prependBubble(msg: ChatMessage, beforeEl: HTMLElement | null): HTMLElement {
        const bubble = this.createAndRenderBubble(msg);
        if (beforeEl) {
            this.messagesEl.insertBefore(bubble, beforeEl);
            this.streamingLoader.pinToEnd();
        }
        return bubble;
    }

    /** Shared DOM construction for append and prepend paths. */
    private createAndRenderBubble(msg: ChatMessage): HTMLElement {
        // Any new bubble invalidates the previous follow-up suggestions bar
        // and insight card AT THE DOM LEVEL. Must dismiss BEFORE creating
        // the new bubble so neither tail element ends up sandwiched
        // between two bubbles. The runtime is the source of truth for
        // persisted insight state — its `insight-update`/`start` events
        // are what actually flip the canonical state; this hide is just
        // a defensive DOM cleanup for the rare case where a new bubble
        // arrives before the runtime's clear event has been observed
        // (e.g. during replay, where no runtime emit happens).
        this.followUpBar?.hide();
        this.insightCard?.hide();
        // A new chat bubble means the conversation has moved past the
        // last error tail (if any), so the inline "continue" affordance
        // is no longer applicable to that historical error.
        this.clearLastErrorContinueBtn();

        let statusCls = '';
        if (msg.role === 'tool_call' && msg.toolCallResult) {
            statusCls = ` session-bubble--tool-${msg.toolCallResult.status}`;
        }
        let subAgentCls = '';
        if (msg.subAgent) {
            subAgentCls = ` session-bubble--subagent session-bubble--subagent-${msg.subAgent.agentName}`;
        }

        const bubble = this.messagesEl.createEl('div', {
            cls: `session-bubble session-bubble--${msg.role}${statusCls}${subAgentCls}`,
        });

        this.bubbleRenderer.renderInto(bubble, msg, {
            abortedMessageIds: this.abortedMessageIds,
            pendingConfirmations: this.pendingConfirmations,
        });

        this.messageBubbles.set(msg.id, bubble);
        this.streamingLoader.pinToEnd();
        this.updateNewChatBtnState();
        return bubble;
    }

    private updateBubbleContent(bubble: HTMLElement, msg: ChatMessage) {
        // Preserve expanded states
        const thinkingBody = bubble.querySelector('.session-bubble__thinking-body');
        const wasThinkingExpanded = thinkingBody?.classList.contains('session-bubble__thinking-body--expanded') ?? false;
        const toolDetailBody = bubble.querySelector('.session-bubble__tool-detail-body');
        const wasToolDetailExpanded = toolDetailBody?.classList.contains('session-bubble__tool-detail-body--expanded') ?? false;

        // Same auto-follow snapshot rationale as appendBubble: a single
        // re-render can grow the bubble by hundreds of pixels (e.g. a
        // tool_call gaining its result detail body, or a thinking section
        // collapsing into a finalised assistant reply), so we must capture
        // the "was at bottom" intent before the synchronous DOM mutation.
        this.scroller.runWithAutoFollow(() => {
            // Use BubbleRenderer.renderInto to update existing bubble
            this.bubbleRenderer.renderInto(bubble, msg, {
                wasThinkingExpanded,
                wasToolDetailExpanded,
                abortedMessageIds: this.abortedMessageIds,
                pendingConfirmations: this.pendingConfirmations,
            });
        });
    }

    /**
     * Note: Tool detail toggle and thinking section toggle are handled
     * internally by BubbleRenderer — no duplicate binding needed here.
     */

    private handleAbort(msg: ChatMessage) {
        this.setInputLocked(false);

        if (msg.content) {
            this.abortedMessageIds.add(msg.id);
            const existing = this.messageBubbles.get(msg.id);
            if (existing) {
                this.updateBubbleContent(existing, msg);
            }
        }

        const messages = this.chat?.messages ?? [];
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'system') {
            this.appendBubble(lastMsg);
        }

        // Persistence is owned by the runtime (see runtime-factory's
        // onAbort) — the view only needs to refresh derived UI here.
        this.updateSessionTitle();
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
                if (this.abortedMessageIds.has(m.id)) break;
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
     * - Default flow: prefill the input editor with the full prompt and
     *   focus it, so the user can review/edit before sending. When the
     *   "auto-send on click" option is enabled, the prompt is sent
     *   immediately instead.
     */
    private handleFollowUpPick(action: SuggestedAction): void {
        if (action.action && this.tryRunClientAction(action.action)) {
            return;
        }
        const autoSend = this.plugin.settings.followUpSuggestionsAutoSend === true;
        if (autoSend) {
            // Replace any in-progress draft with the picked prompt and send.
            this.cmInput.setContent(action.prompt);
            void this.handleSend();
            return;
        }
        this.cmInput.setContent(action.prompt);
        this.cmInput.focus();
        this.draftController?.scheduleSave();
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
                // Resolve using the metadata cache so bare basenames, paths
                // with or without ".md", and subfolder paths all work. The
                // second arg (source path) is the file *from which* links are
                // being resolved; an empty string uses the vault root, which
                // matches the behaviour we want for LLM-provided paths.
                const dest = this.app.metadataCache.getFirstLinkpathDest(action.path, '');
                if (dest) {
                    // Reuse an existing leaf when the note is already open so we
                    // don't stack duplicate tabs on repeated picks.
                    openFileInWorkspace(this.app, dest);
                } else {
                    // Note doesn't exist — defer to Obsidian's standard
                    // wiki-link behaviour. With the default "Automatically
                    // create new linked notes" setting this creates an empty
                    // note at the requested path; otherwise Obsidian shows
                    // its usual "unresolved link" handling. Either way the
                    // outcome matches what users get from clicking [[link]],
                    // which is exactly the contract documented to the model.
                    void this.app.workspace.openLinkText(action.path, '', 'tab');
                }
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
        this.updateSessionTitle();
    }

    private updateSessionTitle() {
        renderSessionTitle(this.sessionTitleEl, this.sessionManager);
    }

    /**
     * Handle click on session title to enable renaming
     */
    private handleTitleClick(container: HTMLElement): void {
        handleTitleClick({
            container,
            sessionTitleEl: this.sessionTitleEl,
            sessionManager: this.sessionManager,
            isStreaming: () => this.isStreaming,
            refreshDisplay: () => this.updateSessionTitle(),
        });
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
            () => this.updateSessionTitle(),
        );
    }

    private updateSessionStatusDisplay() {
        if (!this.chat) {
            this.sessionStatusMainEl.empty();
            this.contextRingEl?.empty();
            // If the panel happens to be open, clear its contents too.
            if (this.dropdownManager.isActive(this.sessionStatusEl)) {
                this.sessionStatusPanelEl.empty();
            }
            return;
        }
        const profile = getActiveProfile(this.plugin.settings);
        const max = profile.maxTokens > 0 ? profile.maxTokens : inferModelContextWindow(profile.model);
        SessionStatusDisplay.render(this.sessionStatusMainEl, this.chat, max);

        // Context-window usage ring in the input toolbar.
        // May not exist yet if onOpen() hasn't finished building the UI.
        if (this.contextRingEl) {
            const lastCallTotal = this.chat.sessionTokenUsage.lastCallTotalTokens ?? 0;
            const ringTooltip = max > 0 && lastCallTotal > 0
                ? `${lastCallTotal} / ${max} (${Math.round((lastCallTotal / max) * 100)}%)`
                : '';
            SessionStatusDisplay.renderContextRing(this.contextRingEl, this.chat, max, ringTooltip);
        }

        // Keep the panel in sync when it is currently open.
        if (this.dropdownManager.isActive(this.sessionStatusEl)) {
            SessionStatusDisplay.renderPanel(
                this.sessionStatusPanelEl,
                this.chat,
                max,
                this.plugin.mcpManager,
                this.computeEmbeddingPanelInfo(),
                this.runtime?.artifactStore.stats() ?? null,
            );
        }
    }

    /**
     * Snapshot of the embedding feature's high-level state for the
     * session-status panel. We only consider it "configured" when both the
     * active config exists and its required credentials are non-empty:
     *
     *   - For Gemini, only `apiKey` is required (`baseUrl` is ignored).
     *   - For OpenAI-compatible providers, both `baseUrl` and `apiKey`.
     *
     * Note: `getActiveEmbeddingConfig()` already returns `null` when the
     * feature is disabled in settings, so we can't rely on it alone to tell
     * disabled apart from unconfigured — we read `embeddingEnabled` directly.
     */
    private computeEmbeddingPanelInfo(): EmbeddingPanelInfo {
        const settings = this.plugin.settings;
        const enabled = settings.embeddingEnabled;
        if (!enabled) {
            return { enabled: false, configured: false };
        }
        const config = getActiveEmbeddingConfig(settings);
        if (!config) {
            return { enabled: true, configured: false };
        }
        const apiKey = config.apiKey?.trim() ?? '';
        const baseUrl = config.baseUrl?.trim() ?? '';
        const needsBaseUrl = config.type !== 'gemini';
        const configured = apiKey.length > 0 && (!needsBaseUrl || baseUrl.length > 0);
        return { enabled: true, configured };
    }

    private appendErrorBubble(message: string) {
        // A new error bubble becomes the new conversation tail; the
        // previous tail's continue button (if any) must be removed
        // BEFORE we render the next bubble so the invariant "only the
        // tail error carries a continue button" holds even briefly.
        this.clearLastErrorContinueBtn();

        const { continueBtn } = appendErrorBubble(message, {
            messagesEl: this.messagesEl,
            pinStreamingLoaderToEnd: () => this.streamingLoader.pinToEnd(),
            maybeScrollToBottom: () => this.maybeScrollToBottom(),
            onContinue: () => {
                // Defensive: errors transition the runtime to idle, so
                // this should normally be safe; but if a fresh turn was
                // somehow kicked off in between (e.g. from another view
                // attached to the same runtime), bail rather than have
                // chat.prompt() throw "already streaming".
                if (this.isStreaming) return;
                // No need to manually clear the button here: sendPrompt
                // delivers the user message via onUserMessage →
                // appendBubble, which clears the singleton as part of
                // its normal "new tail" handling.
                void this.sendPrompt(t('view.continueAfterError'));
            },
        });

        this.lastErrorContinueBtn = continueBtn;
    }

    /**
     * Detach the inline "continue" button from the previous tail error
     * bubble, if any. Idempotent. The error bubble itself is preserved
     * (it stays in history); only the action button is removed since the
     * conversation has moved past the error.
     */
    private clearLastErrorContinueBtn(): void {
        if (this.lastErrorContinueBtn) {
            this.lastErrorContinueBtn.remove();
            this.lastErrorContinueBtn = null;
        }
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
        void exportSessionToVault(this.app, messages);
    }
}
