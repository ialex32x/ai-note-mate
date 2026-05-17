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
import { getActiveEmbeddingConfig, getActiveProfile } from '../settings';
import { exportSessionToVault } from '../services/session-exporter';
import { ALL_TOOL_CAPABILITIES } from '../services/llm-provider';
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
} from '../components/session/toolbar';
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
    createEmbeddingConfig,
    createProviderForActiveProfileOf,
    SessionNavigator,
} from './session-view/index';
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
    private sessionStatusEl!: HTMLElement;
    private sessionStatusMainEl!: HTMLElement;
    private sessionStatusPanelEl!: HTMLElement;
    /** Singleton trailing "AI is working" loader (see StreamingLoader for rationale). */
    private streamingLoader!: StreamingLoader;
    /** Scroll container controller (user-scrolled-up tracking + scroll-to-bottom button). */
    private scroller!: ScrollController;
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

    // ── Draft input debounce ────────────────────────────────────────────────
    private draftController!: DraftInputController;

    // ── Toolbar selectors ────────────────────────────────────────────────────────────
    private profileSelector!: ProfileSelectorHandle;
    private capabilitiesSelector!: CapabilitiesSelectorHandle;
    private checkpointSelector!: CheckpointSelectorHandle;
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
                this.handleSubAgentMessageUpdate(ev.msg);
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
            case 'context-compressed':
                // The runtime already flipped its own flag; the view has
                // nothing extra to render here, but keep the case
                // explicit so an exhaustiveness check would catch a
                // missing branch.
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
                        const max = getActiveProfile(this.plugin.settings).maxTokens;
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

            // ── Input container ───────────────────────────────────────────────────────
            const inputContainer = root.createEl('div', { cls: 'session-input-container' });

            // Checkpoint list control — full-width row docked to the top of the
            // compose card (dropdown opens as a sheet from the top edge).
            const checkpointRow = inputContainer.createEl('div', { cls: 'session-checkpoint-row' });
            this.checkpointSelector = createCheckpointSelector(checkpointRow, this.dropdownManager, {
                app: this.app,
                onGotoMessage: (messageId) => { this.scrollToMessage(messageId); },
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
            this.sendBtn = inputRow.createEl('button', {
                cls: 'session-send-btn',
                attr: { 'aria-label': t('view.sendMessage') },
            });
            setIcon(this.sendBtn, 'send');
            this.sendBtn.addEventListener('click', () => void this.handleSend());

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

            // Reflect live MCP connection state in the session-status panel
            // while it is open. The panel is also refreshed on demand from
            // `updateSessionStatusDisplay()`; this listener covers state
            // transitions that happen independently of token-usage updates.
            this.onMcpStateChangedForStatusPanel = () => {
                if (!this.chat) return;
                if (!this.dropdownManager.isActive(this.sessionStatusEl)) return;
                const max = getActiveProfile(this.plugin.settings).maxTokens;
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

        // Detach (NOT abort) the runtime so a background turn can keep
        // running in the pool. The pool decides retention based on
        // busy/idle state.
        this.detachFromCurrentRuntime();

        this.profileSelector.dispose();
        this.checkpointSelector?.dispose();
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
        // Drop the singleton streaming loader reference; its DOM node is
        // inside contentEl which will be torn down by the parent ItemView.
        this.streamingLoader?.dispose();
        // Disconnect the scroll controller's MutationObserver /
        // ResizeObserver / visualViewport listener so they do not keep
        // the (detached) messagesEl alive after the view closes.
        this.scroller?.detach();
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
        // Detach the singleton streaming loader before emptying, then
        // reattach so it remains the sole instance and still lives at
        // the tail of messagesEl.
        this.streamingLoader.detach();
        this.messagesEl.empty();
        this.streamingLoader.reattachAfterEmpty();
        this.messageBubbles.clear();
        this.abortedMessageIds.clear();

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
            // Empty session (typical "new chat" case).
            this.draftController.restore();
            this.updateSessionStatusDisplay();
            this.updateNewChatBtnState();
            return;
        }

        for (const msg of messages) {
            this.appendBubble({ ...msg, streaming: false });

            // After a delegate_task bubble, append any inline sub-agent
            // bubbles belonging to this invocation so history reads naturally.
            if (
                msg.role === 'tool_call' &&
                msg.toolCallMeta?.toolName === 'delegate_task' &&
                typeof chat.getSubAgentMessages === 'function'
            ) {
                const children = chat.getSubAgentMessages(msg.id);
                for (const child of children) {
                    this.appendBubble({ ...child, streaming: false });
                }
            }
        }

        this.draftController.restore();
        this.forceScrollToBottom();
        this.updateSessionStatusDisplay();
        this.updateNewChatBtnState();

        // Recompute the (deterministic, free) follow-up suggestion bar
        // from the tail assistant reply, and project the runtime's
        // current insight state onto the DOM. Both must happen AFTER
        // the bubble loop so they end up at the tail of messagesEl
        // (each `appendBubble` defensively hides them).
        this.maybeShowFollowUpSuggestions();
        this.renderInsightFromRuntimeState(this.runtime?.getInsightState() ?? null);

        // If we just bound a busy runtime (background turn still in
        // flight), bring the streaming loader + locked input back so
        // the UI reflects the real state. Subsequent message-update
        // events will continue updating the bubbles in place.
        if (opts.fromCache && runtime.isBusy) {
            this.setInputLocked(true);
            this.showStreamingLoader();
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
            window.requestAnimationFrame(() => {
                this.scrollToMessage(result.messageId);
            });
        } finally {
            this.isSwitchingSession = false;
        }
    }

    private scrollToMessage(messageId: string) {
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
            this.chat?.abort();
            return;
        }

        if (!text) return;

        this.cmInput.clear();

        // Clear draft input since message is being sent
        this.draftController.clearDraft();

        // The user bubble is rendered from inside chat.prompt()'s
        // synchronous onUserMessage callback so it can be keyed by the
        // agent's real message id (not a separately-minted optimistic
        // id). This is what keeps the message branch-able afterwards —
        // SessionManager.branchSession looks up the anchor by id in the
        // agent's own message cache. See chat-stream.ts: IChatAgent.prompt.
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
    private handleSubAgentMessageUpdate(msg: ChatMessage): void {
        const existing = this.messageBubbles.get(msg.id);
        if (existing) {
            this.updateBubbleContent(existing, msg);
        } else {
            this.appendBubble(msg);
        }
    }

    // ── DOM helpers ──────────────────────────────────────────────────────────

    private maybeScrollToBottom() {
        this.scroller.maybeScrollToBottom();
    }

    private forceScrollToBottom() {
        this.scroller.forceScrollToBottom();
    }

    private appendBubble(msg: ChatMessage): HTMLElement {
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

        let statusCls = '';
        if (msg.role === 'tool_call' && msg.toolCallResult) {
            statusCls = ` session-bubble--tool-${msg.toolCallResult.status}`;
        }
        let subAgentCls = '';
        if (msg.subAgent) {
            subAgentCls = ` session-bubble--subagent session-bubble--subagent-${msg.subAgent.agentName}`;
        }

        // Wrap the entire append-and-render path in an auto-follow snapshot
        // so a single tall mutation (e.g. a tool-call bubble that ships with
        // its detail / confirmation UI in one shot, or a sub-agent bubble
        // with badge + collapsible wrapper) doesn't push `isNearBottom()`
        // past the 100px threshold and silently break auto-scroll. See
        // ScrollController.runWithAutoFollow for rationale.
        return this.scroller.runWithAutoFollow(() => {
            // Create bubble element directly on messagesEl
            const bubble = this.messagesEl.createEl('div', {
                cls: `session-bubble session-bubble--${msg.role}${statusCls}${subAgentCls}`,
            });

            // Render content into the bubble
            this.bubbleRenderer.renderInto(bubble, msg, {
                abortedMessageIds: this.abortedMessageIds,
                pendingConfirmations: this.pendingConfirmations,
            });

            this.messageBubbles.set(msg.id, bubble);
            // Keep the singleton streaming loader pinned to the tail of messagesEl
            // so it never ends up visually stranded between bubbles.
            this.streamingLoader.pinToEnd();
            this.updateNewChatBtnState();
            return bubble;
        });
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

        const summarizer = createSummarizerConfig(this.plugin);
        if (!summarizer) {
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
     * Public entry for callers outside the session view (e.g. the editor
     * "Explain" right-click action) that want to submit a fully-formed
     * prompt to the current session.
     *
     * Behavior:
     * - If the chat is currently streaming we cannot dispatch another turn,
     *   so we drop the prompt into the input editor instead and focus it.
     *   The user can review and send manually once the current turn ends.
     * - If the input already contains a non-empty draft we never silently
     *   replace it — same rule as `handleInsightDeepen` — only fill + focus,
     *   never auto-send. This prevents accidental loss of in-progress text.
     * - Otherwise: replace input contents with the prompt and submit.
     *
     * The session view is expected to already be open/active by the caller
     * (so we can focus the input deterministically); we only manipulate
     * input + send pipeline here.
     */
    submitOrFillPrompt(prompt: string): void {
        if (!prompt) return;

        const draft = this.cmInput.getContent().trim();
        const busy = this.isStreaming;

        if (busy || draft.length > 0) {
            // Either AI is mid-turn or user has unsent text — surface the
            // prompt as a draft and let the user decide when to send.
            this.cmInput.setContent(prompt);
            this.cmInput.focus();
            this.draftController?.scheduleSave();
            return;
        }

        this.cmInput.setContent(prompt);
        void this.handleSend();
    }

    private setInputLocked(locked: boolean) {
        this.sendBtn.setAttr('title', locked ? t('view.stop') : t('view.send'));
        this.sendBtn.setAttr('aria-label', locked ? t('view.stopGenerating') : t('view.sendMessage'));
        setIcon(this.sendBtn, locked ? 'square' : 'send');
        // Keep the insight card's "Deepen" buttons in lockstep with the
        // chat send button: while a turn is in flight, no new turn may
        // be triggered (including from the insight card).
        this.insightCard?.setBusy(locked);
        // Note: Input remains editable during streaming - user can type but cannot send
        // The send button becomes a stop button when locked
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
            // If the panel happens to be open, clear its contents too.
            if (this.dropdownManager.isActive(this.sessionStatusEl)) {
                this.sessionStatusPanelEl.empty();
            }
            return;
        }
        const max = getActiveProfile(this.plugin.settings).maxTokens;
        SessionStatusDisplay.render(this.sessionStatusMainEl, this.chat, max);
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
        appendErrorBubble(message, {
            messagesEl: this.messagesEl,
            pinStreamingLoaderToEnd: () => this.streamingLoader.pinToEnd(),
            maybeScrollToBottom: () => this.maybeScrollToBottom(),
        });
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
