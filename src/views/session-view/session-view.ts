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
import { ChatMessage, IChatAgent } from '../../services/chat-stream';
import { exportSessionToVault } from '../../services/session-exporter';

import NoteAssistantPlugin from 'main';
import { t } from '../../i18n';
import { SessionManager } from '../../session-manager';
import { SessionSearchModal } from '../../modals/session-search-modal';
import {
    DropdownManager,
    BubbleRenderer,
    DraftInputController,
    FollowUpBar,
    InsightCard,
    TodoPanel,
    QuickAskPanel,
    ErrorBubbleTracker,
    StreamingLoader,
    SessionLoadingOverlay,
    showInitializationError,
    AssetPanelButton,
    PreviewOverlay,
    type ImagePreviewContent,
    type MermaidPreviewContent,
} from '../../components/session';
import {
    buildInsightDeepenPrompt,
    type ConversationInsight,
} from '../../services/insights';
import {
    createProfileSelector, type ProfileSelectorHandle,
    createCheckpointSelector, type CheckpointSelectorHandle,
    createTipsButton, type TipsButtonHandle,
    createIssueTracerButton, type IssueTracerButtonHandle,
} from '../../components/session/toolbar';
import type { TipSessionViewAdapter } from '../../services/tips';
import { CMInput } from '../../components/cm-input';
import {
    ScrollController,
    BubbleListController,
    SessionStatusController,
    updateSessionTitle as renderSessionTitle,
    createInsightsConfig,
    SessionNavigator,
} from './index';
import { MessageWindowController } from './message-window-controller';
import { PromptPinController } from './prompt-pin-controller';
import {
    SessionPromptOptimizer,
} from './session-prompt-optimizer';
import { SessionRuntimeBinder } from './session-runtime-binder';
import { SessionSwitchController } from './session-switch-controller';
import { QuickAskHandler } from './quick-ask-handler';
import { SendHandler } from './send-handler';
import { HistoryLoader } from './history-loader';
import { FollowUpController } from './follow-up-controller';
import { MessageEditHandler } from './message-edit-handler';
import {
    SessionRuntime,
    extractInsightsForMessage,
} from '../../services/session-runtime';

export class SessionView extends ItemView {
    static readonly VIEW_TYPE = 'ai-session-view';

    // ── UI elements ──────────────────────────────────────────────────────────
    private messagesEl!: HTMLElement;
    cmInput!: CMInput;
    private sendBtn!: HTMLButtonElement;
    private optimizeBtn!: HTMLButtonElement;
    /** Extracted controller for the "Refine prompt" button lifecycle. */
    private promptOptimizer!: SessionPromptOptimizer;
    /** Singleton trailing "AI is working" loader (see StreamingLoader for rationale). */
    private streamingLoader!: StreamingLoader;
    /** Scroll container controller (user-scrolled-up tracking + scroll-to-bottom button). */
    private scroller!: ScrollController;
    /** Overlay + progress while a large history slice is replayed. */
    private historyLoadingOverlay!: SessionLoadingOverlay;
    /** Tracks which history units are rendered (tail-first windowing). */
    private messageWindow!: MessageWindowController;
    private scrollToBottomBtn!: HTMLButtonElement;
    private newChatBtn!: HTMLButtonElement;
    private sessionNavigator!: SessionNavigator;
    /** Generated-asset gallery button (left of session status in toolbar). */
    private assetPanelBtn!: AssetPanelButton;
    /** Full-viewport preview overlay for zoom/pan of images, mermaid, etc. */
    private previewOverlay!: PreviewOverlay;
    // ── Session runtime ──────────────────────────────────────────────────────
    /**
     * Owns the binding lifecycle between this view and the
     * {@link SessionRuntime} sourced from `plugin.runtimePool`: attach/
     * detach listeners, hydrate from disk, replay UI state, and route
     * the runtime event channel onto the view's controllers. Constructed
     * in {@link buildInputArea} once all UI controllers exist.
     */
    private runtimeBinder!: SessionRuntimeBinder;
    /** Session new/switch/branch/search-navigation flows (P1). */
    private switchController!: SessionSwitchController;
    /** User-message send pipeline (P4). */
    private sendHandler!: SendHandler;
    /** QuickAsk side-inquiry submission/deletion (P2). */
    private quickAskHandler!: QuickAskHandler;
    /** Lazy history-window expansion + jump navigation (P6). */
    private historyLoader!: HistoryLoader;
    /** Deterministic follow-up suggestion bar (P3). */
    private followUpController!: FollowUpController;
    /** In-place message-edit (rollback + re-edit) flow (P5). */
    private messageEditHandler!: MessageEditHandler;

    /**
     * Current user-pasted image attachment (only one allowed at a time).
     * `thumbnailDataUrl` is a small inline data URL for the chip preview;
     * the full-resolution file is at `cachePath`.
     */
    private currentAttachment: {
        cachePath: string;
        mimeType: string;
        fileName: string;
        thumbnailDataUrl: string;
    } | null = null;

    /** DOM container for the image attachment thumbnail row. */
    private attachmentRow!: HTMLElement;
    /** Thumbnail <img> element inside {@link attachmentRow}. */
    private attachmentThumb!: HTMLImageElement;
    /** Delete button inside {@link attachmentRow}. */
    private attachmentDeleteBtn!: HTMLElement;

    /**
     * The runtime currently bound to this view, proxied from the
     * {@link SessionRuntimeBinder}. The view does NOT own its lifecycle
     * (the pool does). Read-only on the view side — only the binder
     * mutates the binding.
     */
    private get runtime(): SessionRuntime | undefined {
        return this.runtimeBinder?.runtime;
    }

    /**
     * Whether the view has finished its initial async load + runtime bind
     * (the tail of {@link _loadAndPopulate}). External callers (editor
     * "Send to AI session" actions) use this to avoid operating on a
     * half-initialized view right after startup. Requires the session
     * cache to be loaded, the input editor to exist, and a runtime to be
     * bound to the active session.
     */
    isReady(): boolean {
        return this.sessionManager.isCacheLoaded
            && !!this.cmInput
            && !!this.runtime;
    }

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
     * Controller that manages the pinned user-prompt bar shown at the
     * top of the message area when the user scrolls past their original
     * question (Cursor-style prompt pinning). Constructed in
     * {@link buildMessageArea}.
     */
    private promptPin!: PromptPinController;

    /**
     * Controller that owns the toolbar title display and the
     * session-status indicator (context usage ring, detail
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
    /** QuickAsk side-inquiry floating panel. */
    private quickAskPanel!: QuickAskPanel;

    /**
     * Monotonic counter bumped on every {@link onOpen} so a stale
     * fire-and-forget {@link _loadAndPopulate} tail cannot bind a
     * session after a newer open cycle has already rebuilt the view.
     */
    private populateGeneration = 0;

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

    // ── Lifecycle ────────────────────────────────────────────────────────────

    async onOpen() {
        const root = this.contentEl;
        root.empty();
        root.addClass('session-view');

        this.installMobileKeyboardPadding(root);

        // Pre-warm speechSynthesis voice engine
        if (!Platform.isMobile && 'speechSynthesis' in window) {
            speechSynthesis.getVoices();
        }

        // Phase 1: build UI shell immediately — no I/O, no await.
        let sessionTitleEl: HTMLElement;
        try {
            sessionTitleEl = this.buildToolbar(root);
            this.buildMessageArea(root);
            this.buildInputArea(root, sessionTitleEl);

            // Overlay goes up synchronously while onOpen is still on the
            // stack, so the user never sees a flash of empty message area.
            this.historyLoadingOverlay.showSimple();
        } catch (error) {
            showInitializationError(root, error, () => { void this.onOpen(); });
            return;
        }

        // Phase 2: load session data asynchronously.  onOpen() returns
        // right away so setViewState / createSessionView are not blocked;
        // the overlay spinner stays visible until data arrives.
        const generation = ++this.populateGeneration;
        void this._loadAndPopulate(sessionTitleEl, generation);
    }

    /**
     * Wait for {@link SessionManager.loadFromCache}, then populate the
     * session title, message list, and runtime state.  Called as a fire-
     * and-forget tail from {@link onOpen} so the view appears instantly
     * even when there are many session files to scan.
     */
    private async _loadAndPopulate(sessionTitleEl: HTMLElement, generation: number): Promise<void> {
        try {
            await this.sessionManager.loadFromCache();
            if (generation !== this.populateGeneration) return;

            if (!this.sessionManager.isCacheLoaded || !this.sessionManager.activeSessionId) {
                throw new Error('Session cache failed to load');
            }

            renderSessionTitle(sessionTitleEl, this.sessionManager);

            // ── Restore session UI from cache ────────────────────────────────
            await this.runtimeBinder.bindActiveSessionRuntime();
            if (generation !== this.populateGeneration) return;

            this.historyLoadingOverlay.hide();
        } catch (error) {
            if (generation !== this.populateGeneration) return;
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
            onSwitchSession: (id) => { void this.switchController.handleSwitchSession(id); },
            onActiveSessionDeleted: async () => {
                // The active session's runtime was already evicted
                // by SessionNavigator (via plugin.runtimePool.evict);
                // we just need to detach our listener (no-op since
                // the runtime is gone) and rebind to whichever
                // session SessionManager auto-selected.
                this.runtimeBinder.resetBindingForDeletedSession();
                this.runtimeBinder.clearViewDOM();
                await this.runtimeBinder.bindActiveSessionRuntime();
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
        newChatBtn.addEventListener('click', () => void this.switchController.handleNewChat());
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
        // ── Preview overlay (covers entire session view, above all content) ──
        this.previewOverlay = new PreviewOverlay(root);
        this.previewOverlay.mount();

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
            (msg) => { void this.switchController.handleBranchFromMessage(msg); },
            (msg) => { void this.messageEditHandler.handleEditMessage(msg); },
            (msg) => { this.historyLoader.handleJumpToPrevUser(msg); },
            (msg) => { this.historyLoader.handleJumpToNextUser(msg); },
            (msg) => this.historyLoader.canJumpToPrevUser(msg),
            (msg) => this.historyLoader.canJumpToNextUser(msg),
            (msg) => { void this.handleQuickAskRequest(msg); },
            () => new Set((this.runtime?.quickAskTurns ?? []).map(t => t.parentMessageId)),
            // Preview overlay callback: open when user clicks an attachment image.
            (src, fileName) => this.handlePreviewImage(src, fileName),
            // Preview overlay callback: open when user clicks a mermaid diagram.
            (svg, code) => this.handlePreviewMermaid(svg, code),
        );
        this.addChild(this.bubbleRenderer);

        // Initialize follow-up suggestion bar (mounted on messagesEl on demand)
        this.followUpBar = new FollowUpBar(this.messagesEl, (action) => {
            this.followUpController.handleFollowUpPick(action);
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
                void this.historyLoader.loadOlderMessages();
            }
        });

        // Prompt-pin controller: shows a compact pinned bar at the top
        // when the user scrolls past their original question (Cursor-style).
        // The scrollToMessage callback is late-bound — the history loader
        // doesn't exist yet in buildMessageArea. We resolve it lazily
        // so the pin bar works as soon as history loading is available.
        this.promptPin = new PromptPinController(
            messagesWrapper,
            this.messagesEl,
            (messageId) => { void this.historyLoader?.scrollToMessage(messageId); },
        );
        this.promptPin.attach();

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
                void this.sendHandler.sendPrompt(t('view.continueAfterError'));
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

        // QuickAsk side-inquiry handler (P2). Constructed here because it
        // depends on `bubbleList`; the panel itself is built later in
        // buildInputArea and refreshed via the late-bound callback.
        this.quickAskHandler = new QuickAskHandler({
            plugin: this.plugin,
            getRuntime: () => this.runtime,
            bubbleList: this.bubbleList,
            refreshQuickAskPanel: () => this.quickAskPanel?.refresh(),
        });
    }

    /**
     * Build the docked input area: TODO panel, checkpoint row,
     * CodeMirror compose card, and the thinking row (file-ref, profile,
     * issue tracer, tips, session-status panel, refine
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

        // QuickAsk panel — mounted on body with position:fixed, never
        // interferes with session view scroll layout.
        this.quickAskPanel = new QuickAskPanel(
            (messageId) => this.bubbleList.messageBubbles.get(messageId),
            () => this.runtime?.quickAskTurns ?? [],
            async (parentMessageId, input) => {
                await this.quickAskHandler.handleQuickAskSubmit(parentMessageId, input);
            },
            (parentMessageId) => { void this.quickAskHandler.handleQuickAskDelete(parentMessageId); },
        );

        // ── Input container ───────────────────────────────────────────────────────
        const inputContainer = root.createEl('div', { cls: 'session-input-container' });

        // Checkpoint list control — full-width row docked to the top of the
        // compose card (dropdown opens as a sheet from the top edge).
        const checkpointRow = inputContainer.createEl('div', { cls: 'session-checkpoint-row' });
        this.checkpointSelector = createCheckpointSelector(checkpointRow, this.dropdownManager, {
            app: this.app,
            onGotoMessage: (messageId) => { void this.historyLoader.scrollToMessage(messageId); },
        });

        // ── Image attachment thumbnail row ──────────────────────────────────
        // Placed between the checkpoint row and the input row so the
        // user can see the pasted image before typing their message.
        this.attachmentRow = inputContainer.createEl('div', { cls: 'session-attachment-row session-attachment-row--hidden' });
        // Wrapper that sizes to the actual thumbnail dimensions so the
        // delete button always sits exactly on the image's top-right corner.
        const thumbWrap = this.attachmentRow.createEl('span', { cls: 'session-attachment-thumb-wrap' });
        // Thumbnail image
        this.attachmentThumb = thumbWrap.createEl('img', { cls: 'session-attachment-thumb' });
        // Delete button (×) in the top-right corner of the thumbnail
        this.attachmentDeleteBtn = thumbWrap.createEl('span', {
            cls: 'session-attachment-delete',
            attr: { role: 'button', 'aria-label': t('view.removeAttachment') },
        });
        setIcon(this.attachmentDeleteBtn, 'x');
        this.attachmentDeleteBtn.addEventListener('click', () => {
            void this.removeAttachment();
        });

        // ── Paste handler ──────────────────────────────────────────────────
        // Listen on the entire input container so paste events reach us
        // even when the CodeMirror editor doesn't have focus.
        this.registerDomEvent(inputContainer, 'paste', (e: ClipboardEvent) => {
            void this.handlePaste(e);
        });

        // Input area with CodeMirror 6 editor
        const inputRow = inputContainer.createEl('div', { cls: 'session-input-row' });
        const cmContainer = inputRow.createEl('div', { cls: 'session-cm-input' });
        this.cmInput = new CMInput(cmContainer, {
            app: this.app,
            placeholder: t('view.inputPlaceholder'),
            onEnter: () => {
                if (this.plugin.settings.enterToSend) {
                    void this.sendHandler.handleSend();
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
                this.promptOptimizer.updateAvailability();
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

        // ── Thinking row (file-ref, profile, issue tracer, tips, assets,
        //    session status, refine, send) ──────────────────────────────
        const { sessionStatusEl, sessionStatusMainEl, sessionStatusPanelEl } =
            this.buildThinkingRow(inputContainer);

        // ── Construct status controller ─────────────────────────────────
        // Owns title rendering and the session-status indicator (context
        // usage ring, detail panel). Constructed here because it needs
        // DOM elements from both buildToolbar (sessionTitleEl) and
        // buildInputArea (status elements).
        this.statusController = new SessionStatusController({
            sessionTitleEl,
            sessionStatusEl,
            sessionStatusMainEl,
            sessionStatusPanelEl,
            sessionManager: this.sessionManager,
            mcpManager: this.plugin.mcpManager,
            settings: this.plugin.settings,
            dropdownManager: this.dropdownManager,
            chat: () => this.chat,
            artifactStats: () => this.runtime?.artifactStore.stats() ?? null,
            isStreaming: () => this.isStreaming,
        });
        this.statusController.updateStatusDisplay();

        // ── Runtime binder (P0) ─────────────────────────────────────────
        // Owns the attach/detach/replay lifecycle between this view and
        // the SessionRuntime from the pool. Constructed last because it
        // depends on every UI controller created above.
        this.runtimeBinder = new SessionRuntimeBinder({
            plugin: this.plugin,
            sessionManager: this.sessionManager,
            messagesEl: this.messagesEl,
            scroller: this.scroller,
            bubbleList: this.bubbleList,
            bubbleRenderer: this.bubbleRenderer,
            messageWindow: this.messageWindow,
            streamingLoader: this.streamingLoader,
            followUpBar: this.followUpBar,
            insightCard: this.insightCard,
            todoPanel: this.todoPanel,
            historyLoadingOverlay: this.historyLoadingOverlay,
            errorBubbles: this.errorBubbles,
            draftController: this.draftController,
            statusController: this.statusController,
            promptOptimizer: this.promptOptimizer,
            cmInput: this.cmInput,
            assetPanelBtn: this.assetPanelBtn,
            checkpointSelector: this.checkpointSelector,
            sessionNavigator: this.sessionNavigator,
            scrollToBottomBtn: this.scrollToBottomBtn,
            updateNewChatBtnState: () => this.updateNewChatBtnState(),
            setInputLocked: (locked) => this.setInputLocked(locked),
            showStreamingLoader: () => this.showStreamingLoader(),
            hideStreamingLoader: () => this.hideStreamingLoader(),
            maybeScrollToBottom: () => this.maybeScrollToBottom(),
            forceScrollToBottom: () => this.forceScrollToBottom(),
            maybeShowFollowUpSuggestions: () => this.followUpController.maybeShowFollowUpSuggestions(),
            loadOlderMessages: () => void this.historyLoader.loadOlderMessages(),
        });

        // ── Send handler (P4) ───────────────────────────────────────────
        this.sendHandler = new SendHandler({
            plugin: this.plugin,
            cmInput: this.cmInput,
            draftController: this.draftController,
            promptOptimizer: this.promptOptimizer,
            scroller: this.scroller,
            bubbleList: this.bubbleList,
            runtimeBinder: this.runtimeBinder,
            getStreaming: () => this.isStreaming,
            getChat: () => this.chat,
            getAttachment: () => this.getCurrentAttachment(),
            clearAttachment: () => this.clearAttachmentUI(),
        });

        // ── History loader (P6) ─────────────────────────────────────────
        this.historyLoader = new HistoryLoader({
            scroller: this.scroller,
            bubbleList: this.bubbleList,
            messageWindow: this.messageWindow,
            historyLoadingOverlay: this.historyLoadingOverlay,
            getHistoryReplaySignal: () => this.runtimeBinder.getReplaySignal(),
        });

        // ── Session switch controller (P1) ──────────────────────────────
        this.switchController = new SessionSwitchController({
            plugin: this.plugin,
            sessionManager: this.sessionManager,
            runtimeBinder: this.runtimeBinder,
            draftController: this.draftController,
            cmInput: this.cmInput,
            scrollToMessage: (id) => this.historyLoader.scrollToMessage(id),
        });

        // ── Follow-up suggestion controller (P3) ────────────────────────
        this.followUpController = new FollowUpController({
            app: this.app,
            plugin: this.plugin,
            followUpBar: this.followUpBar,
            bubbleList: this.bubbleList,
            scroller: this.scroller,
            getChat: () => this.chat,
            sendPrompt: (text) => this.sendHandler.sendPrompt(text),
            getStreaming: () => this.isStreaming,
        });

        // ── Message edit handler (P5) ───────────────────────────────────
        this.messageEditHandler = new MessageEditHandler({
            app: this.app,
            runtimeBinder: this.runtimeBinder,
            sessionManager: this.sessionManager,
            promptOptimizer: this.promptOptimizer,
            draftController: this.draftController,
            cmInput: this.cmInput,
            getRuntime: () => this.runtime,
            waitForChatIdle: (timeoutMs) => this.sendHandler.waitForChatIdle(timeoutMs),
            guardSwitchSession: () => this.switchController.guardSwitchSession(),
            getStreaming: () => this.isStreaming,
        });
    }

    /**
     * Build the thinking row docked above the compose card: file-ref,
     * profile selector, issue tracer, tips (left side) and the
     * right-aligned group (assets → session status → refine → send).
     *
     * Sets `this.profileSelector`, `this.issueTracerButton`,
     * `this.tipsButton`, `this.assetPanelBtn`, `this.optimizeBtn`,
     * `this.promptOptimizer`, `this.sendBtn`.
     *
     * @returns The session-status DOM elements needed by the
     *          {@link SessionStatusController} constructed afterwards.
     */
    private buildThinkingRow(inputContainer: HTMLElement): {
        sessionStatusEl: HTMLElement;
        sessionStatusMainEl: HTMLElement;
        sessionStatusPanelEl: HTMLElement;
    } {
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
        // Order inside the group: assets → session status → refine prompt → send.
        const thinkingRowRight = thinkingRow.createEl('div', {
            cls: 'session-thinking-row__right',
        });

        // ── Generated-asset panel button ─────────────────────────────────
        // Image icon. Hides when no assets have been generated in this
        // session. Opens a popup grid of 64×64 thumbnails.
        this.assetPanelBtn = new AssetPanelButton(
            this.app,
            () => this.runtime?.assetCollection.assets ?? [],
        );
        const { button: assetBtn, dropdown: assetDropdown } = this.assetPanelBtn.mount(thinkingRowRight);
        this.dropdownManager.registerToggle({
            wrapper: assetBtn.parentElement!,
            button: assetBtn,
            dropdown: assetDropdown,
            onOpen: () => {
                this.assetPanelBtn.renderPanel();
            },
        });

        // ── Session status indicator ───────────────────────────────────────
        const status = this.buildSessionStatus(thinkingRowRight);

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
        // Wired AFTER cmInput, draftController, and optimizeBtn all exist.
        this.promptOptimizer = new SessionPromptOptimizer({
            cmInput: this.cmInput,
            optimizeBtn: this.optimizeBtn,
            isStreaming: () => this.isStreaming,
            draftController: this.draftController,
            getChatMessages: () => this.chat?.messages ?? [],
            plugin: this.plugin,
        });
        this.optimizeBtn.addEventListener('click', this.promptOptimizer.handleClick);

        this.sendBtn = thinkingRowRight.createEl('button', {
            cls: 'session-thinking-row__icon-btn session-send-btn',
            attr: { 'aria-label': t('view.sendMessage') },
        });
        setIcon(this.sendBtn, 'send');
        setTooltip(this.sendBtn, t('view.send'));
        this.sendBtn.addEventListener('click', () => void this.sendHandler.handleSend());

        return status;
    }

    /**
     * Build the session-status indicator (compact context-usage ring +
     * detail dropdown panel) inside the thinking row's right-aligned
     * group, wiring its dropdown toggle. The rendering itself is owned
     * by the {@link SessionStatusController}; this only builds the DOM.
     */
    private buildSessionStatus(thinkingRowRight: HTMLElement): {
        sessionStatusEl: HTMLElement;
        sessionStatusMainEl: HTMLElement;
        sessionStatusPanelEl: HTMLElement;
    } {
        // Primary metric: context-usage ring that also opens a
        // detailed panel on click. Placed before refine → send so
        // the eye-flow is "status → refine → send".
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
                // Align the dropdown panel's right edge close to the
                // session-view right edge (with a small gap). The CSS
                // `right: 0` anchors to the `session-toolbar__status`
                // wrapper which sits partway across the thinking row;
                // we push it further right by computing the distance
                // from the status element to the session-view edge.
                const sessionView = this.contentEl.closest('.session-view');
                if (sessionView) {
                    const viewRect = sessionView.getBoundingClientRect();
                    const statusRect = sessionStatusEl.getBoundingClientRect();
                    const gap = 4; // small visual gap from the session-view edge
                    const rightOffset = viewRect.right - statusRect.right - gap;
                    sessionStatusPanelEl.style.right = `-${rightOffset}px`;
                }

                // Refresh the compact toolbar indicator.
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

        return { sessionStatusEl, sessionStatusMainEl, sessionStatusPanelEl };
    }

    async onClose() {
        // All members below are created during onOpen's build* phase. Guard
        // every access with `?.` so a teardown that follows a partially
        // failed onOpen (e.g. an exception before buildInputArea ran) cleans
        // up whatever exists instead of throwing on the first missing field.

        // Clear draft save timer and save any pending draft
        this.draftController?.clearTimer();

        // Cancel any in-flight prompt-refinement request — the
        // resulting draft would have nowhere to land once the view
        // is torn down, and the LLM bill is best avoided.
        this.promptOptimizer?.abort();

        // Detach (NOT abort) the runtime so a background turn can keep
        // running in the pool. The pool decides retention based on
        // busy/idle state.
        this.runtimeBinder?.detachFromCurrentRuntime();

        this.profileSelector?.dispose();
        this.checkpointSelector?.dispose();
        this.tipsButton?.dispose();
        this.tipsButton = null;
        this.issueTracerButton?.dispose();
        this.issueTracerButton = null;
        this.assetPanelBtn?.dispose();
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
        this.promptPin?.detach();
        this.historyLoadingOverlay?.dispose();
        this.previewOverlay?.dispose();
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
     */
    async startNewSession(): Promise<boolean> {
        return this.switchController.startNewSession();
    }

    // ── QuickAsk handlers ─────────────────────────────────────────────────

    /**
     * Toggle the QuickAsk panel for a given assistant message.
     * If already showing for this message, hide; otherwise show.
     */
    private handleQuickAskRequest(msg: ChatMessage): void {
        if (this.quickAskPanel.activeMessageId === msg.id) {
            this.quickAskPanel.hide();
        } else {
            this.quickAskPanel.show(msg.id);
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
            await this.switchController.handleSearchResultNavigation(result);
        }
    }

    // ── Send logic ───────────────────────────────────────────────────────────

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
                await this.sendHandler.sendPrompt(text);
            },
            fillPromptDraft: (text: string) => this.fillPromptDraft(text),
            triggerFileRefSuggest: () => this.cmInput.triggerFileRefSuggest(),
        };
    }

    // ── DOM helpers ──────────────────────────────────────────────────────────

    private maybeScrollToBottom() {
        this.scroller.maybeScrollToBottom();
    }

    private forceScrollToBottom() {
        this.scroller.forceScrollToBottom();
    }

    // ── Preview overlay ───────────────────────────────────────────────────

    /**
     * Open the preview overlay for an attachment image.
     */
    private handlePreviewImage(src: string, fileName: string): void {
        const content: ImagePreviewContent = {
            kind: 'image',
            src,
            alt: fileName,
        };
        this.previewOverlay.show(content);
    }

    private handlePreviewMermaid(svg: string, code?: string): void {
        const content: MermaidPreviewContent = {
            kind: 'mermaid',
            svg,
            code,
        };
        this.previewOverlay.show(content);
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
        void this.sendHandler.handleSend();
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
        this.promptOptimizer.updateAvailability();
        // Keep the insight card's "Deepen" buttons in lockstep with the
        // chat send button: while a turn is in flight, no new turn may
        // be triggered (including from the insight card).
        this.insightCard?.setBusy(locked);
        // Note: Input remains editable during streaming - user can type but cannot send
        // The send button becomes a stop button when locked
    }

    // ── Image paste handling ──────────────────────────────────────────

    /**
     * Get the current image attachment info for the send handler.
     * Returns only the cache metadata — the base64 payload is resolved
     * later by {@link ChatStream._rebuildApiMessages}.
     */
    getCurrentAttachment(): { cachePath: string; mimeType: string; fileName: string } | null {
        if (!this.currentAttachment) return null;
        return {
            cachePath: this.currentAttachment.cachePath,
            mimeType: this.currentAttachment.mimeType,
            fileName: this.currentAttachment.fileName,
        };
    }

    /** Clear the attachment UI and state after sending. */
    clearAttachmentUI(): void {
        this.currentAttachment = null;
        this.attachmentRow.addClass('session-attachment-row--hidden');
        this.attachmentThumb.src = '';
    }

    /**
     * Handle paste events on the input container.
     * If the clipboard contains an image, save it to the session's
     * refs/ cache directory and display a thumbnail above the input.
     */
    private async handlePaste(e: ClipboardEvent): Promise<void> {
        // Only intercept image pastes; let text pastes through.
        const items = e.clipboardData?.items;
        if (!items) return;

        let imageFile: File | null = null;
        for (let i = 0; i < items.length; i++) {
            const item = items[i]!;
            if (item.type.startsWith('image/')) {
                imageFile = item.getAsFile();
                break;
            }
        }
        if (!imageFile) return;

        // Stop the event so CodeMirror doesn't insert garbage text.
        e.preventDefault();
        e.stopPropagation();

        try {
            const sessionId = this.runtime?.sessionId;
            if (!sessionId) {
                new Notice(t('view.attachmentNoSession'));
                return;
            }

            // Read the image data.
            const buf = await imageFile.arrayBuffer();
            const mimeType = imageFile.type || 'image/png';
            const ext = mimeType.split('/')[1] ?? 'png';
            const fileName = imageFile.name || `paste-${Date.now()}.${ext}`;
            const timestamp = Date.now();

            // Ensure the refs/ directory exists.
            const refsDir = `${this.plugin.paths.sessions()}/${sessionId}/refs`;
            if (!(await this.app.vault.adapter.exists(refsDir))) {
                await this.app.vault.adapter.mkdir(refsDir);
            }
            const cachePath = `${refsDir}/img_${timestamp}.${ext}`;

            // Write the image to the cache.
            await this.app.vault.adapter.writeBinary(cachePath, buf);

            // Generate a small thumbnail data URL for the preview chip.
            // Cap at 128px max dimension to keep the data URL compact.
            const thumbnailDataUrl = await this.createThumbnailDataUrl(buf, mimeType, 128);

            // If there was a previous attachment, delete its cache file.
            if (this.currentAttachment) {
                await this.removeAttachmentFile(this.currentAttachment.cachePath);
            }

            // Update state and show thumbnail.
            this.currentAttachment = { cachePath, mimeType, fileName, thumbnailDataUrl };
            this.attachmentThumb.src = thumbnailDataUrl;
            this.attachmentThumb.alt = fileName;
            this.attachmentRow.removeClass('session-attachment-row--hidden');
        } catch (err) {
            console.error('[SessionView] Failed to handle pasted image:', err);
            new Notice(t('view.attachmentPasteFailed'));
        }
    }

    /**
     * Remove the current attachment: delete cache file, clear state,
     * hide thumbnail.
     */
    private async removeAttachment(): Promise<void> {
        if (!this.currentAttachment) return;
        await this.removeAttachmentFile(this.currentAttachment.cachePath);
        this.currentAttachment = null;
        this.attachmentRow.addClass('session-attachment-row--hidden');
        this.attachmentThumb.src = '';
    }

    /** Delete a single attachment cache file (fire-and-forget). */
    private async removeAttachmentFile(cachePath: string): Promise<void> {
        try {
            if (await this.app.vault.adapter.exists(cachePath)) {
                await this.app.vault.adapter.remove(cachePath);
            }
        } catch (err) {
            console.warn('[SessionView] Failed to delete attachment file:', cachePath, err);
        }
    }

    /**
     * Create a thumbnail data URL from raw image bytes.
     * Uses a canvas to resize the image so the data URL stays small
     * (ideal for inline chip previews).
     */
    private createThumbnailDataUrl(
        buf: ArrayBuffer,
        mimeType: string,
        maxDim: number,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const blob = new Blob([buf], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                let { width, height } = img;
                if (width > maxDim || height > maxDim) {
                    const ratio = Math.min(maxDim / width, maxDim / height);
                    width = Math.round(width * ratio);
                    height = Math.round(height * ratio);
                }
                const canvas = activeDocument.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('Failed to get 2d context'));
                    return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL(mimeType, 0.7));
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load image for thumbnail'));
            };
            img.src = url;
        });
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
