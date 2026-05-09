import {
    ItemView,
    WorkspaceLeaf,
    IconName,
    TFile,
    TAbstractFile,
    Notice,
    setIcon,
    setTooltip,
    Platform,
    Menu,
} from 'obsidian';
import { ChatStream, ChatMessage, IChatAgent } from '../services/chat-stream';
import { AgentOrchestrator } from '../services/agent-orchestrator';
import { getActiveProfile, getSummarizerProfile, getActiveEmbeddingConfig } from '../settings';
import type { LLMProvider, MinimalModelConfig } from '../services/llm-provider';
import { createProviderForActiveProfile } from '../utils/provider-factory';
import { summarizeConversation } from '../services/context-reducer';
import { exportSessionToVault } from '../services/session-exporter';
import { ALL_TOOL_CAPABILITIES } from '../services/llm-provider';
import NoteAssistantPlugin from 'main';
import { createObsidianTools } from 'services/tools/obsidian';
import { createWebSearchTools } from 'services/tools/web-search-toolcall';
import { createWebFetchTools } from 'services/tools/web-fetch-toolcall';
import { createRSSFetchTools } from 'services/tools/rss-fetch-toolcall';
import { createBuiltinTools } from 'services/tools/builtin-toolcall';
import { createMemoryTools } from 'services/tools/memory-toolcall';
import { createJavaScriptTools } from 'services/tools/js_toolcall';
import { createSkillTools } from 'services/tools/skill-toolcall';
import { createImageTool } from 'services/tools/image-toolcall';
import { createConversationTools } from 'services/tools/conversation-toolcall';
import { t } from '../i18n';
import { SessionManager } from '../session-manager';
import { SessionSearchModal, SessionSearchResult } from '../modals/session-search-modal';
import { DeleteHistoryConfirmModal } from '../modals/delete-history-confirm-modal';
import {
    DropdownManager,
    BubbleRenderer,
    SessionStatusDisplay,
    DraftInputController,
    FollowUpBar,
    InsightCard,
} from '../components/session';
import { extractSuggestions, stripStructuredBlock } from '../services/suggestions';
import { extractInsights, type ConversationInsight, buildInsightDeepenPrompt } from '../services/insights';
import {
    createProfileSelector, type ProfileSelectorHandle,
    createCapabilitiesSelector, type CapabilitiesSelectorHandle,
    createMcpSelector, type McpSelectorHandle,
} from '../components/session/toolbar';
import { CMInput } from '../components/cm-input';
import { TITLE_SUMMARIZE_PROMPT, buildBuiltinSystemPrompt } from '../services/prompts/session-prompts';
import { buildSubAgentConfigs } from '../services/sub-agent-registry';
import { stripMarkdownToPlainText } from '../utils/markdown-sanitizer';

export class SessionView extends ItemView {
    static readonly VIEW_TYPE = 'ai-session-view';

    // ── UI elements ──────────────────────────────────────────────────────────
    private messagesEl!: HTMLElement;
    cmInput!: CMInput;
    private sendBtn!: HTMLButtonElement;
    private sessionStatusEl!: HTMLElement;
    private sessionStatusMainEl!: HTMLElement;
    private sessionStatusPanelEl!: HTMLElement;
    /**
     * Singleton typing indicator (three bouncing dots). Created once in onOpen,
     * lives as the last child of `messagesEl`, and is show/hidden via a CSS
     * modifier class — never removed and recreated. This prevents stale
     * indicator nodes from getting "stranded" between message bubbles when
     * callback paths forget to hide it before appending a new bubble.
     *
     * Note: any code that appends a new child to `messagesEl` must call
     * `pinTypingIndicatorToEnd()` afterwards to move this node back to the
     * tail position (DOM move, not recreate).
     */
    private typingIndicatorEl: HTMLElement | null = null;
    private isStreaming = false;
    /**
     * Set to true when the user manually scrolls up during streaming.
     * While true, auto-scroll-to-bottom is suppressed so the user can
     * read earlier content without being pulled back down on every
     * message update (especially during the thinking phase where tokens
     * arrive frequently but produce no visible output).
     *
     * Detection uses wheel / touchmove events (not the scroll event) so
     * that programmatic scrolls cannot accidentally clear or prevent
     * this flag from being set.
     *
     * Cleared when the user scrolls back to the bottom (wheel/touch
     * down + isNearBottom), clicks the scroll-to-bottom button, sends
     * a new message, or switches sessions.
     */
    private userScrolledUp = false;
    /** Flag to prevent concurrent session switches */
    private isSwitchingSession = false;
    private scrollToBottomBtn!: HTMLButtonElement;
    private newChatBtn!: HTMLButtonElement;
    private sessionBtn!: HTMLButtonElement;
    private sessionTitleEl!: HTMLElement;
    /** Incremented on each resetChat(); callbacks from a stale generation are silently discarded */
    private chatGeneration = 0;
    private static readonly SCROLL_THRESHOLD = 100;

    // ── ChatStream instance ──────────────────────────────────────────────────
    private chat?: IChatAgent;

    // ── Session management ──────────────────────────────────────────────────
    private sessionManager: SessionManager;
    private sessionDropdownEl!: HTMLElement;

    private plugin!: NoteAssistantPlugin;

    // ── In-flight streaming bubble ───────────────────────────────────────────
    /** Maps message id → the DOM element currently rendering that message */
    private messageBubbles: Map<string, HTMLElement> = new Map();
    /** Set of message IDs that were aborted by the user */
    private abortedMessageIds: Set<string> = new Set();
    /** Pending tool confirmation promises keyed by message ID */
    private pendingConfirmations: Map<string, (approved: boolean) => void> = new Map();

    // ── Draft input debounce ────────────────────────────────────────────────
    private draftController!: DraftInputController;

    // ── Toolbar selectors ────────────────────────────────────────────────────────────
    private profileSelector!: ProfileSelectorHandle;
    private capabilitiesSelector!: CapabilitiesSelectorHandle;
    private mcpSelector!: McpSelectorHandle;
    /** Settings-change listener that keeps the capabilities toolbar in sync. */
    private onSettingsChangedForCapabilities: (() => void) | null = null;

    // ── Context compression tracking ────────────────────────────────
    /** Whether context compression has occurred in this session */
    private hasContextCompressed = false;

    // ── Refactored components ────────────────────────────────────────────────
    private dropdownManager = new DropdownManager();
    private bubbleRenderer!: BubbleRenderer;
    /** Quick-pick bar for follow-up suggestions extracted from the last assistant reply. */
    private followUpBar!: FollowUpBar;
    /** Read-only preview card for candidate knowledge nuggets extracted from the last turn. */
    private insightCard!: InsightCard;
    /** Monotonic id of the most recent insight extraction request, used to drop stale results. */
    private insightExtractionGen = 0;

    constructor(leaf: WorkspaceLeaf, plugin: NoteAssistantPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.sessionManager = new SessionManager(plugin.app, plugin.paths.sessions());
    }

    getViewType() { return SessionView.VIEW_TYPE; }
    getDisplayText() { return t('view.name'); }
    getIcon(): IconName { return 'sparkles'; }

    /**
     * Populates the pane menu when user clicks "More options" or right-clicks tab header.
     */
    onPaneMenu(menu: Menu, _source: 'more-options' | 'tab-header' | string): void {
        menu.addItem((item) => {
            item
                .setTitle(t('view.exportSession'))
                .setIcon('download')
                .onClick(() => this.exportSession());
        });
    }

    private createSummarizerConfig(): MinimalModelConfig | undefined {
        const settings = this.plugin.settings;
        let summarizer: MinimalModelConfig | undefined;
        if (settings.summarizerProfileId) {
            const sp = getSummarizerProfile(settings);
            const spApiKey = this.app.secretStorage.getSecret(sp.apiKey) ?? sp.apiKey;
            if (spApiKey) {
                summarizer = {
                    type: sp.provider,
                    apiKey: spApiKey,
                    baseURL: sp.baseUrl,
                    model: sp.model,
                };
            }
        }
        return summarizer;
    }

    private createEmbeddingConfig(): MinimalModelConfig | undefined {
        const settings = this.plugin.settings;
        const embeddingConfig = getActiveEmbeddingConfig(settings);
        if (embeddingConfig) {
            const apiKey = this.app.secretStorage.getSecret(embeddingConfig.apiKey) ?? embeddingConfig.apiKey;
            if (apiKey) {
                return {
                    type: embeddingConfig.type,
                    apiKey,
                    baseURL: embeddingConfig.baseUrl,
                    model: embeddingConfig.model,
                };
            }
        }
        return undefined;
    }

    private createProviderForActiveProfile(): LLMProvider {
        return createProviderForActiveProfile(this.plugin).provider;
    }

    private getChatStream(): IChatAgent {
        if (!this.chat) {
            const settings = this.plugin.settings;
            const generation = this.chatGeneration;

            // Build sub-agent configurations first (needed for system prompt)
            const subAgentConfigs = buildSubAgentConfigs(this.plugin);

            // Build sub-agent descriptors for the dynamic system prompt
            const subAgentDescriptors = subAgentConfigs.map(c => ({
                name: c.name,
                description: c.description,
            }));

            const builtinSystemPrompt = buildBuiltinSystemPrompt(subAgentDescriptors, {
                structuredFollowUps: settings.followUpSuggestionsEnabled && settings.followUpSuggestionsStructured,
            });

            const skillsPrompt = this.plugin.skillManager.buildSystemPrompt();
            const fullSystemPrompt = builtinSystemPrompt +
                (settings.systemPrompt || '') +
                (skillsPrompt ? '\n\n' + skillsPrompt : '');

            const chatStreamConfig = {
                systemPrompt: fullSystemPrompt,
                dynamicTools: () => this.getDynamicTools(),
                onStart: () => {
                    if (this.chatGeneration !== generation) return;
                    this.isStreaming = true;
                    this.setInputLocked(true);
                    this.showTypingIndicator();
                },
                onMessageUpdate: (msg: ChatMessage) => {
                    if (this.chatGeneration !== generation) return;

                    // Hide typing indicator as soon as the assistant starts
                    // producing visible content (thinking text, streaming
                    // content, or a streaming tool_call). In those states the
                    // bubble itself (plus the blinking in-bubble `▍` cursor)
                    // already indicates activity, so the global "waiting" dots
                    // should step aside.
                    if (this.isMessageProducingVisibleContent(msg)) {
                        this.hideTypingIndicator();
                    }

                    this.handleMessageUpdate(msg);
                },
                onToolCallEnd: () => {
                    if (this.chatGeneration !== generation) return;

                    // Tool execution completed - show typing indicator to fill the gap
                    // before AI starts its next response (may include thinking)
                    this.showTypingIndicator();
                },
                onFinish: () => {
                    if (this.chatGeneration !== generation) return;
                    this.isStreaming = false;
                    this.userScrolledUp = false;
                    this.hideTypingIndicator();
                    this.setInputLocked(false);
                    void this.saveCurrentSessionState();
                    this.maybeGenerateSessionTitle();
                    // Save session cache to disk after each complete conversation round
                    void this.sessionManager.saveToCache();
                    // Offer quick-pick follow-up suggestions derived from the last
                    // assistant reply, if the user has the feature enabled.
                    this.maybeShowFollowUpSuggestions();
                    // Optionally extract reusable knowledge nuggets from this turn.
                    void this.maybeShowInsightCard();
                },
                onAbort: (msg: ChatMessage) => {
                    if (this.chatGeneration !== generation) return;
                    this.isStreaming = false;
                    this.userScrolledUp = false;
                    this.hideTypingIndicator();
                    this.handleAbort(msg);
                },
                onUsageUpdate: () => {
                    if (this.chatGeneration !== generation) return;
                    this.updateSessionStatusDisplay();
                },
                onError: (err: Error) => {
                    if (this.chatGeneration !== generation) return;
                    console.warn('ChatStream error:', err);
                    this.isStreaming = false;
                    this.userScrolledUp = false;
                    this.hideTypingIndicator();
                    this.setInputLocked(false);
                    this.appendErrorBubble(err.message);
                },
                // Only provide onConfirmToolCall in "always" mode. In "auto" mode
                // we deliberately omit the callback so ChatStream skips the whole
                // pending → allowed flow — otherwise the UI would briefly render
                // an Allow button even though no user approval is actually needed.
                ...(this.plugin.settings.toolConfirmMode === 'always' ? {
                    onConfirmToolCall: ({ messageId }: { messageId: string }) => {
                        if (this.chatGeneration !== generation) {
                            return Promise.resolve(true);
                        }
                        return new Promise<boolean>((resolve) => {
                            this.pendingConfirmations.set(messageId, resolve);
                        });
                    },
                } : {}),
                onContextCompressed: () => {
                    if (this.chatGeneration !== generation) return;
                    this.hasContextCompressed = true;
                },
            };

            if (subAgentConfigs.length > 0) {
                // Multi-agent mode: use AgentOrchestrator
                this.chat = new AgentOrchestrator({
                    ...chatStreamConfig,
                    subAgents: subAgentConfigs,
                    onSubAgentMessageUpdate: (_agentName, msg) => {
                        if (this.chatGeneration !== generation) return;
                        // Mirror the main-agent rule: once the sub-agent
                        // starts emitting visible content, hide the global
                        // typing dots so the bubble's own cursor takes over.
                        if (this.isMessageProducingVisibleContent(msg)) {
                            this.hideTypingIndicator();
                        }
                        this.handleSubAgentMessageUpdate(msg);
                    },
                });

                // Register main-agent tools (memory, conversation, builtin, skill)
                createBuiltinTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
                createSkillTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
            } else {
                // Fallback: single-agent mode (all tools on one ChatStream)
                this.chat = new ChatStream(chatStreamConfig);

                createObsidianTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
                createWebSearchTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
                createWebFetchTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
                createRSSFetchTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
                createBuiltinTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
                createJavaScriptTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
                createSkillTools(this.plugin).forEach(tool => this.chat!.registerTool(tool));
            }
        }
        return this.chat;
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
            const sessionWrapper = leftGroup.createEl('span', { cls: 'session-selector session-session-selector' });
            const sessionBtnGroup = sessionWrapper.createEl('span', {
                cls: 'session-toolbar__btn-group',
            });

            const sessionBtn = sessionBtnGroup.createEl('button', {
                cls: 'session-toolbar__btn session-toolbar__session-btn',
                attr: { 'aria-label': t('view.switchSession') },
            });
            setIcon(sessionBtn, 'list');
            this.sessionBtn = sessionBtn;

            this.sessionDropdownEl = sessionWrapper.createEl('div', {
                cls: 'session-dropdown',
            });

            this.dropdownManager.registerToggle({
                wrapper: sessionWrapper,
                button: sessionBtn,
                dropdown: this.sessionDropdownEl,
                onOpen: () => this.rebuildSessionDropdown(),
            });

            // More actions dropdown button for session operations
            const sessionMoreActionsBtn = sessionBtnGroup.createEl('button', {
                cls: 'session-toolbar__btn session-toolbar__btn--dropdown',
                attr: { 'aria-label': t('view.moreSessionActions') },
            });
            setIcon(sessionMoreActionsBtn, 'chevron-down');

            const sessionMoreActionsDropdown = sessionBtnGroup.createEl('div', {
                cls: 'session-dropdown-menu session-dropdown-menu--toolbar',
            });

            // Delete history sessions menu item
            const deleteHistoryItem = sessionMoreActionsDropdown.createEl('div', { cls: 'session-dropdown-item' });
            const deleteIcon = deleteHistoryItem.createEl('span', { cls: 'session-dropdown-item__icon' });
            setIcon(deleteIcon, 'trash-2');
            deleteHistoryItem.createEl('span', { text: t('view.deleteHistorySessions') });
            deleteHistoryItem.addEventListener('click', () => {
                this.dropdownManager.closeActive();
                void this.handleDeleteHistorySessions();
            });

            this.dropdownManager.registerToggle({
                wrapper: sessionBtnGroup,
                button: sessionMoreActionsBtn,
                dropdown: sessionMoreActionsDropdown,
                onOpen: () => {
                    // DropdownManager automatically closes other active dropdowns
                },
            });

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
                        SessionStatusDisplay.renderPanel(this.sessionStatusPanelEl, this.chat, max);
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

            // Create the singleton typing indicator as the last child of
            // messagesEl. It stays in the DOM for the view's lifetime; we
            // toggle its visibility via `session-typing-indicator--hidden`
            // and move it back to the tail after any bubble append.
            this.typingIndicatorEl = this.messagesEl.createEl('div', {
                cls: 'session-typing-indicator session-typing-indicator--hidden',
            });
            const dotsContainer = this.typingIndicatorEl.createEl('span', { cls: 'session-typing-indicator__dots' });
            for (let i = 0; i < 3; i++) {
                dotsContainer.createEl('span', { cls: 'session-typing-indicator__dot', text: '.' });
            }

            // Initialize BubbleRenderer with messagesEl
            this.bubbleRenderer = new BubbleRenderer(
                this.app,
                () => this.maybeScrollToBottom(),
                (msg) => this.handleExtractInsightsForMessage(msg),
            );
            this.addChild(this.bubbleRenderer);

            // Initialize follow-up suggestion bar (mounted on messagesEl on demand)
            this.followUpBar = new FollowUpBar(this.messagesEl, (action) => {
                this.handleFollowUpPick(action);
            });

            // Initialize conversation-insight preview card.
            this.insightCard = new InsightCard(
                this.messagesEl,
                (insight) => this.handleInsightDeepen(insight),
            );

            // Scroll-to-bottom button
            this.scrollToBottomBtn = messagesWrapper.createEl('button', {
                cls: 'session-scroll-to-bottom-btn',
                attr: { 'aria-label': 'Scroll to latest' },
            });
            setIcon(this.scrollToBottomBtn, 'chevrons-down');
            this.scrollToBottomBtn.hide();
            this.scrollToBottomBtn.addEventListener('click', () => {
                this.userScrolledUp = false;
                this.scrollToBottomBtn.hide();
                this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
            });
            this.messagesEl.addEventListener('scroll', () => this.onMessagesScroll());

            // Detect user scroll intent via wheel / touch events.
            // These are guaranteed user-initiated and cannot be confused
            // with programmatic scrollTop changes (unlike the scroll event).
            this.messagesEl.addEventListener('wheel', (e: WheelEvent) => this.onMessagesWheel(e), { passive: true });

            // Touch scroll detection for mobile devices
            let touchStartY = 0;
            this.messagesEl.addEventListener('touchstart', (e: TouchEvent) => {
                const touch = e.touches[0];
                if (touch) touchStartY = touch.clientY;
            }, { passive: true });
            this.messagesEl.addEventListener('touchmove', (e: TouchEvent) => {
                if (!this.isStreaming) return;
                const touch = e.touches[0];
                if (!touch) return;
                const deltaY = touchStartY - touch.clientY;
                if (deltaY > 10) {
                    // Finger moved up → user wants to scroll up
                    this.userScrolledUp = true;
                } else if (deltaY < -10) {
                    // Finger moved down — check if they reached the bottom
                    requestAnimationFrame(() => {
                        if (this.isNearBottom()) {
                            this.userScrolledUp = false;
                        }
                    });
                }
                touchStartY = touch.clientY;
            }, { passive: true });

            // ── Input container ───────────────────────────────────────────────────────
            const inputContainer = root.createEl('div', { cls: 'session-input-container' });

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
                        this.app.workspace.getLeaf().openFile(file);
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
                onChange: async (allowed) => {
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
                    await this.plugin.saveSettings();
                },
            });
            // Keep the toolbar selector in sync with external settings changes
            // (e.g. toggled from the global settings tab while a session is open).
            this.onSettingsChangedForCapabilities = () => {
                this.capabilitiesSelector.setAllowed(this.plugin.settings.allowedCapabilities);
            };
            this.plugin.onSettingsChange(this.onSettingsChangedForCapabilities);

            // ── MCP tools selector (using DropdownManager) ──────────────────────────
            this.mcpSelector = createMcpSelector(thinkingRow, this.plugin, this.dropdownManager);

            // ── Restore session UI from cache ────────────────────────────────
            await this.restoreSessionUI();        } catch (error) {
            this.showInitializationError(error);
        }
    }

    /** Display an initialization error on the UI */
    private showInitializationError(error: unknown) {
        const root = this.contentEl;
        root.empty();
        root.addClass('session-view');

        const errorContainer = root.createEl('div', { cls: 'session-error-container' });

        errorContainer.createEl('div', {
            cls: 'session-error-title',
            text: '⚠️ Session View Initialization Error',
        });

        const errorMessage = errorContainer.createEl('div', { cls: 'session-error-message' });
        const errorText = error instanceof Error
            ? `${error.name}: ${error.message}\n\nStack trace:\n${error.stack}`
            : String(error);

        errorMessage.createEl('pre', { cls: 'session-error-stack', text: errorText });

        const copyBtn = errorContainer.createEl('button', { cls: 'session-error-copy-btn', text: 'Copy Error' });
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(errorText).then(() => {
                copyBtn.setText('Copied!');
                setTimeout(() => copyBtn.setText('Copy Error'), 2000);
            });
        });

        const retryBtn = errorContainer.createEl('button', { cls: 'session-error-retry-btn', text: 'Retry' });
        retryBtn.addEventListener('click', () => this.onOpen());

        console.error('SessionView initialization error:', error);
    }

    async onClose() {
        // Clear draft save timer and save any pending draft
        this.draftController.clearTimer();
        
        this.profileSelector.dispose();
        this.mcpSelector.dispose();
        if (this.onSettingsChangedForCapabilities) {
            this.plugin.offSettingsChange(this.onSettingsChangedForCapabilities);
            this.onSettingsChangedForCapabilities = null;
        }
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
        }
        this.dropdownManager.closeActive();
        this.messageBubbles.clear();
        // Drop the singleton typing indicator reference; its DOM node is
        // inside contentEl which will be torn down by the parent ItemView.
        this.typingIndicatorEl = null;
    }

    private async handleNewChat() {
        // Prevent concurrent session operations
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return;
        }
        if (this.isStreaming) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }

        this.isSwitchingSession = true;
        try {
            // Save draft input before switching
            await this.draftController.flush();
            
            const messages = this.chat ? this.chat.messages : [];
            const usage = this.chat ? this.chat.sessionTokenUsage : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            const summaries = this.chat ? this.chat.summaries : [];
            await this.sessionManager.saveAndSwitch(messages, usage, summaries);
            this.clearViewForSessionSwitch();
            new Notice(t('view.newSessionCreated'));
        } finally {
            this.isSwitchingSession = false;
        }
    }

    private async handleSwitchSession(targetId: string) {
        // Prevent concurrent session operations
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return;
        }
        if (this.isStreaming) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }
        if (targetId === this.sessionManager.activeSessionId) return;

        this.isSwitchingSession = true;
        try {
            // Save draft input before switching
            await this.draftController.flush();
            
            const messages = this.chat ? this.chat.messages : [];
            const usage = this.chat ? this.chat.sessionTokenUsage : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            const summaries = this.chat ? this.chat.summaries : [];
            await this.sessionManager.saveAndSwitch(messages, usage, summaries, targetId);

            // Pre-load messages for the new active session (lazy load)
            await this.sessionManager.ensureActiveMessagesLoaded();

            this.clearViewForSessionSwitch();
            await this.restoreSessionUI();
        } finally {
            this.isSwitchingSession = false;
        }
    }

    private clearViewForSessionSwitch() {
        if (this.chat) this.chat.abort();
        if ('speechSynthesis' in window && speechSynthesis.speaking) speechSynthesis.cancel();
        this.bubbleRenderer?.cancelSpeech();
        this.chatGeneration++;
        this.isStreaming = false;
        this.userScrolledUp = false;
        this.hideTypingIndicator();
        this.setInputLocked(false);

        // Clear draft save timer and reset draft state
        this.draftController.reset();

        this.mcpSelector.reset();

        this.followUpBar?.hide();
        this.insightCard?.hide();
        // Invalidate any in-flight insight extraction so a late callback
        // cannot resurrect a card on a freshly cleared session.
        this.insightExtractionGen++;
        // Detach the singleton typing indicator before emptying, then
        // reattach so it remains the sole instance and still lives at the
        // tail of messagesEl.
        this.typingIndicatorEl?.detach();
        this.messagesEl.empty();
        if (this.typingIndicatorEl) {
            this.messagesEl.appendChild(this.typingIndicatorEl);
        }
        this.messageBubbles.clear();
        this.abortedMessageIds.clear();

        for (const msgId of this.pendingConfirmations.keys()) {
            document.body.querySelector(`[data-confirm-msg-id="${msgId}"]`)?.remove();
        }
        this.pendingConfirmations.clear();
        this.chat = undefined;
        this.cmInput.clear();
        this.scrollToBottomBtn.hide();
        this.updateSessionStatusDisplay();
        this.updateNewChatBtnState();
    }

    private async restoreSessionUI() {
        const session = await this.sessionManager.getActiveSession();
        if (!session || session.messages.length === 0) {
            // Restore draft input even for empty sessions
            this.draftController.restore();
            return;
        }

        const chatStream = this.getChatStream();
        chatStream.restoreState(session.messages, session.tokenUsage);

        // Restore summaries for context compression
        const summaries = this.sessionManager.getSummaries();
        if (summaries.length > 0) {
            chatStream.restoreSummaries(summaries);
            this.hasContextCompressed = true;
        }

        // Restore sub-agent inline messages (new sessions only; legacy v1 sessions
        // have no such data and will fall back to the nested delegate_task display).
        const subAgentMessages = this.sessionManager.getSubAgentMessages();
        if (subAgentMessages && Object.keys(subAgentMessages).length > 0 && typeof chatStream.restoreSubAgentMessages === 'function') {
            chatStream.restoreSubAgentMessages(subAgentMessages);
        }

        // Restore per-agent token usage breakdown (v3+ sessions only).
        // Must be called AFTER restoreState, which stuffs the combined total into
        // main-agent's session usage; this corrects main-agent's usage to its
        // historical own value (see AgentOrchestrator.restoreAgentTokenBreakdown).
        const agentTokenBreakdown = this.sessionManager.getAgentTokenBreakdown();
        if (agentTokenBreakdown && typeof chatStream.restoreAgentTokenBreakdown === 'function') {
            chatStream.restoreAgentTokenBreakdown(agentTokenBreakdown);
        }

        for (const msg of session.messages) {
            this.appendBubble({ ...msg, streaming: false });

            // After a delegate_task bubble, append any inline sub-agent bubbles
            // belonging to this invocation so history reads naturally.
            if (
                msg.role === 'tool_call' &&
                msg.toolCallMeta?.toolName === 'delegate_task' &&
                typeof chatStream.getSubAgentMessages === 'function'
            ) {
                const children = chatStream.getSubAgentMessages(msg.id);
                for (const child of children) {
                    this.appendBubble({ ...child, streaming: false });
                }
            }
        }

        // Restore draft input after restoring messages
        this.draftController.restore();

        this.forceScrollToBottom();
        this.updateSessionStatusDisplay();
        this.updateNewChatBtnState();
    }

    private async saveCurrentSessionState() {
        if (!this.chat) return;
        // Snapshot sub-agent inline messages (if supported) for persistence
        let subAgentMessagesObj: Record<string, ChatMessage[]> | undefined;
        if (typeof this.chat.getAllSubAgentMessages === 'function') {
            const map = this.chat.getAllSubAgentMessages();
            if (map.size > 0) {
                subAgentMessagesObj = {};
                for (const [parentId, msgs] of map.entries()) {
                    // Freeze streaming flag to false when persisted so reloads
                    // don't resurrect transient streaming state.
                    subAgentMessagesObj[parentId] = msgs.map(m => ({ ...m, streaming: false }));
                }
            }
        }
        // Snapshot per-agent token usage breakdown (multi-agent only)
        const agentTokenBreakdown = this.chat.agentTokenBreakdown;
        await this.sessionManager.saveCurrentSession(
            this.chat.messages,
            this.chat.sessionTokenUsage,
            this.chat.summaries,
            subAgentMessagesObj,
            agentTokenBreakdown,
        );
        this.updateSessionTitle();
    }



    /**
     * Rebuild session dropdown content (called by DropdownManager onOpen)
     */
    private rebuildSessionDropdown(): void {
        const dropdown = this.sessionDropdownEl;
        dropdown.empty();

        const sessions = this.sessionManager.getAllSessions();



        if (sessions.length === 0) {
            dropdown.createEl('div', { cls: 'session-dropdown__empty', text: t('view.noSessions') });
        } else {
            for (const session of sessions) {
                const item = dropdown.createEl('div', { cls: 'session-dropdown__item' });
                const isActive = session.id === this.sessionManager.activeSessionId;
                if (isActive) item.addClass('session-dropdown__item--active');

                const checkIcon = item.createEl('span', { cls: 'session-dropdown__item-check' });
                if (isActive) setIcon(checkIcon, 'check');

                const textWrapper = item.createEl('span', { cls: 'session-dropdown__item-body' });
                const displayTitle = session.title || session.firstUserMessage || t('view.newChat');
                textWrapper.createEl('span', { cls: 'session-dropdown__item-text' })
                    .setText(displayTitle);

                const metaRow = textWrapper.createEl('span', { cls: 'session-dropdown__item-meta' });
                metaRow.createEl('span', { cls: 'session-dropdown__item-time' })
                    .setText(new Date(session.createdAt).toLocaleString());

                // Token usage (prompt / completion). Hidden when no tokens were ever spent.
                const usage = session.tokenUsage;
                if (usage && (usage.promptTokens > 0 || usage.completionTokens > 0)) {
                    const tokensEl = metaRow.createEl('span', { cls: 'session-dropdown__item-tokens' });
                    const promptStr = SessionStatusDisplay.formatCompact(usage.promptTokens);
                    const completionStr = SessionStatusDisplay.formatCompact(usage.completionTokens);
                    tokensEl.createEl('span', {
                        cls: 'session-dropdown__item-token',
                        text: `↑${promptStr}`,
                    });
                    tokensEl.createEl('span', {
                        cls: 'session-dropdown__item-token',
                        text: `↓${completionStr}`,
                    });
                    setTooltip(
                        tokensEl,
                        `${t('statusLabel.prompt')}: ${usage.promptTokens.toLocaleString()}\n` +
                        `${t('statusLabel.completion')}: ${usage.completionTokens.toLocaleString()}`,
                    );
                }

                // Delete button (shown for all sessions including active)
                const deleteBtn = item.createEl('button', {
                    cls: 'session-dropdown__item-delete',
                    attr: { 'aria-label': t('view.deleteSession') },
                });
                setIcon(deleteBtn, 'trash-2');
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    void this.handleDeleteSession(session.id, item, isActive);
                });

                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.dropdownManager.closeActive();
                    if (!isActive) void this.handleSwitchSession(session.id);
                });
            }
        }
    }

    private async handleDeleteSession(sessionId: string, itemEl: HTMLElement, isActive: boolean) {
        // Prevent deleting while streaming
        if (this.isStreaming) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }

        // Clear draft save timer before deleting (draft will be lost with the session)
        if (isActive) {
            this.draftController.clearTimer();
        }

        const newActiveId = await this.sessionManager.deleteSession(sessionId);
        if (newActiveId === undefined) {
            // Delete failed (session not found)
            return;
        }

        // Remove from dropdown with animation
        itemEl.addClass('session-dropdown__item--deleting');
        setTimeout(() => {
            itemEl.remove();
            // Update session button visibility
            this.updateSessionBtnState();
            // Close dropdown if no more sessions
            if (this.sessionDropdownEl && this.sessionDropdownEl.querySelectorAll('.session-dropdown__item').length === 0) {
                this.sessionDropdownEl.createEl('div', { cls: 'session-dropdown__empty', text: t('view.noSessions') });
            }
        }, 200);

        // If deleted session was active, switch to the new active session
        if (isActive && newActiveId !== null) {
            // Close dropdown
            this.dropdownManager.closeActive();
            // Clear and restore UI for the new active session
            await this.sessionManager.ensureActiveMessagesLoaded();
            this.clearViewForSessionSwitch();
            await this.restoreSessionUI();
        }

        new Notice(t('view.sessionDeleted'));
    }

    private async openSessionSearch() {
        // Prevent search while streaming
        if (this.isStreaming) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }

        const modal = new SessionSearchModal(this.app, this.sessionManager);
        const result = await modal.waitForResult();

        if (result) {
            await this.handleSearchResultNavigation(result);
        }
    }

    private async handleSearchResultNavigation(result: SessionSearchResult) {
        // Prevent concurrent session operations
        if (this.isSwitchingSession) {
            new Notice(t('view.sessionSwitchInProgress'));
            return;
        }
        if (this.isStreaming) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }

        this.isSwitchingSession = true;
        try {
            // Save draft input before switching
            await this.draftController.flush();
            
            // Save current session and switch to target
            const messages = this.chat ? this.chat.messages : [];
            const usage = this.chat ? this.chat.sessionTokenUsage : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
            const summaries = this.chat ? this.chat.summaries : [];
            await this.sessionManager.saveAndSwitch(messages, usage, summaries, result.sessionId);

            // Ensure messages are loaded
            await this.sessionManager.ensureActiveMessagesLoaded();

            // Clear and restore UI
            this.clearViewForSessionSwitch();
            await this.restoreSessionUI();

            // Scroll to the specific message
            requestAnimationFrame(() => {
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
            setTimeout(() => {
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

        const msgId = `user-${Date.now()}`;
        this.appendBubble({
            id: msgId,
            role: 'user',
            content: text,
            streaming: false,
            timestamp: Date.now(),
        });
        this.forceScrollToBottom();
        this.updateSessionTitle();

        await this.getChatStream().prompt(text, {
            allowedCapabilities: (() => {
                const allowed = this.capabilitiesSelector.getAllowed();
                return allowed.length < ALL_TOOL_CAPABILITIES.length ? allowed : undefined;
            })(),
            provider: this.createProviderForActiveProfile(),
            summarizer: this.createSummarizerConfig(),
            embedding: this.createEmbeddingConfig(),
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

    private isNearBottom(): boolean {
        const { scrollTop, scrollHeight, clientHeight } = this.messagesEl;
        return scrollHeight - scrollTop - clientHeight < SessionView.SCROLL_THRESHOLD;
    }

    private maybeScrollToBottom() {
        if (this.userScrolledUp) {
            // User intentionally scrolled up — show the button so they
            // can jump back when ready, but don't force-scroll.
            if (this.isStreaming) {
                this.scrollToBottomBtn.show();
            }
            return;
        }
        if (this.isNearBottom()) {
            this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            this.scrollToBottomBtn.hide();
        } else if (this.isStreaming) {
            this.scrollToBottomBtn.show();
        }
    }

    private forceScrollToBottom() {
        this.userScrolledUp = false;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        this.scrollToBottomBtn.hide();
    }

    /**
     * Scroll-event handler.  Only updates button visibility and
     * detects keyboard-based scroll-up during streaming.
     *
     * User scroll-up is primarily detected via wheel / touchmove events
     * (registered in onOpen) which are guaranteed to be user-initiated
     * and cannot be confused with programmatic scrolls.  The scroll
     * event is unreliable for this purpose because both programmatic
     * and user scrolls fire it.
     */
    private onMessagesScroll() {
        if (this.isNearBottom()) {
            this.scrollToBottomBtn.hide();
        } else if (this.isStreaming) {
            this.scrollToBottomBtn.show();
            // Also set the flag here as a fallback for keyboard
            // scrolling (Page-Up, Arrow-Up, etc.) which does NOT
            // fire wheel events.
            this.userScrolledUp = true;
        }
    }

    /**
     * Wheel-event handler for detecting user scroll intent.
     * Wheel events are guaranteed to be user-initiated, so they
     * cannot be confused with programmatic scrollTop changes.
     */
    private onMessagesWheel(e: WheelEvent) {
        if (!this.isStreaming) return;
        if (e.deltaY < 0) {
            // User scrolled up → suppress auto-scroll
            this.userScrolledUp = true;
        } else if (e.deltaY > 0) {
            // User scrolled down — if they reached the bottom,
            // resume auto-scrolling.
            requestAnimationFrame(() => {
                if (this.isNearBottom()) {
                    this.userScrolledUp = false;
                }
            });
        }
    }

    private appendBubble(msg: ChatMessage): HTMLElement {
        // Any new bubble invalidates the previous follow-up suggestions bar.
        // Must dismiss BEFORE creating the new bubble so the bar (which lives at
        // the tail of messagesEl) does not end up sandwiched between two bubbles.
        this.followUpBar?.hide();
        // Same reasoning applies to the insight preview card.
        this.insightCard?.hide();
        // Invalidate any in-flight insight extraction so a late callback
        // cannot resurrect a card on a freshly cleared session.
        this.insightExtractionGen++;

        let statusCls = '';
        if (msg.role === 'tool_call' && msg.toolCallResult) {
            statusCls = ` session-bubble--tool-${msg.toolCallResult.status}`;
        }
        let subAgentCls = '';
        if (msg.subAgent) {
            subAgentCls = ` session-bubble--subagent session-bubble--subagent-${msg.subAgent.agentName}`;
        }
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
        // Keep the singleton typing indicator pinned to the tail of messagesEl
        // so it never ends up visually stranded between bubbles.
        this.pinTypingIndicatorToEnd();
        this.maybeScrollToBottom();
        this.updateNewChatBtnState();
        return bubble;
    }

    private updateBubbleContent(bubble: HTMLElement, msg: ChatMessage) {
        // Preserve expanded states
        const thinkingBody = bubble.querySelector('.session-bubble__thinking-body') as HTMLElement | null;
        const wasThinkingExpanded = thinkingBody?.classList.contains('session-bubble__thinking-body--expanded') ?? false;
        const toolDetailBody = bubble.querySelector('.session-bubble__tool-detail-body') as HTMLElement | null;
        const wasToolDetailExpanded = toolDetailBody?.classList.contains('session-bubble__tool-detail-body--expanded') ?? false;

        // Use BubbleRenderer.renderInto to update existing bubble
        this.bubbleRenderer.renderInto(bubble, msg, {
            wasThinkingExpanded,
            wasToolDetailExpanded,
            abortedMessageIds: this.abortedMessageIds,
            pendingConfirmations: this.pendingConfirmations,
        });

        this.maybeScrollToBottom();
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

        void this.saveCurrentSessionState();
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
     * If the user has insight extraction enabled, run a one-shot, stateless
     * call (using the context summarizer profile) to surface candidate
     * "knowledge nuggets" as a read-only card at the tail of the
     * conversation. Phase 2: preview only — adoption to vault is gated.
     */
    private async maybeShowInsightCard(): Promise<void> {
        if (!this.insightCard) return;
        const settings = this.plugin.settings;
        if (!settings.insightExtractionEnabled) {
            this.insightCard.hide();
            return;
        }

        // Locate the most recent assistant message and the user message
        // that triggered it (skipping intermediate tool/sub-agent traffic).
        const messages = this.chat?.messages ?? [];
        let assistant: ChatMessage | undefined;
        let user: ChatMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m) continue;
            if (!assistant) {
                if (m.role === 'assistant' && !m.streaming && m.content) {
                    if (this.abortedMessageIds.has(m.id)) {
                        // Aborted reply: skip extraction entirely.
                        this.insightCard.hide();
                        return;
                    }
                    assistant = m;
                }
                continue;
            }
            if (m.role === 'user' && m.content) {
                user = m;
                break;
            }
        }
        if (!assistant || !user) {
            this.insightCard.hide();
            return;
        }

        // Threshold guard: skip very short replies to avoid token waste.
        const replyText = stripStructuredBlock(assistant.content ?? '').trim();
        const minLen = Math.max(0, settings.insightExtractionMinReplyChars | 0);
        if (replyText.length < minLen) {
            this.insightCard.hide();
            return;
        }

        await this.runInsightExtraction(user, assistant, { force: false });
    }

    /**
     * Click handler for the per-bubble "Extract insights" action — a manual
     * counterpart to {@link maybeShowInsightCard}.
     *
     * Differences from the auto path:
     *   - Bypasses the `insightExtractionEnabled` toggle and the minimum
     *     reply length: this is an explicit user gesture.
     *   - Surfaces a Notice when no summarizer profile is configured (the
     *     auto path stays silent on purpose, but a manual gesture deserves
     *     visible feedback).
     *   - Pairs the assistant message with its preceding user message when
     *     one exists, falling back to an empty user prompt otherwise so
     *     the extractor still has something to anchor against.
     */
    private handleExtractInsightsForMessage(assistant: ChatMessage): void {
        if (!this.insightCard) return;

        // Don't fight an in-flight chat turn. The action bar button doesn't
        // disable itself globally, so we guard here.
        if (this.isStreaming) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }

        // Walk back from this assistant message to its triggering user
        // turn. We allow extraction even when no preceding user message
        // exists — the extractor handles an empty user prompt fine.
        const messages = this.chat?.messages ?? [];
        let user: ChatMessage | undefined;
        const assistantIdx = messages.findIndex((m) => m.id === assistant.id);
        if (assistantIdx > 0) {
            for (let i = assistantIdx - 1; i >= 0; i--) {
                const m = messages[i];
                if (m && m.role === 'user' && m.content) {
                    user = m;
                    break;
                }
            }
        }

        const summarizerConfig = this.createSummarizerConfig();
        if (!summarizerConfig) {
            new Notice(t('view.insightExtractionUnavailable'));
            return;
        }

        void this.runInsightExtraction(user, assistant, { force: true });
    }

    /**
     * Shared extraction pipeline used by both the automatic post-reply
     * trigger and the manual per-bubble action. Mounts the Insights block,
     * runs the one-shot LLM call, and renders the results — taking care to
     * drop stale callbacks if the user has moved on (new turn, cleared
     * session, or another extraction superseded this one).
     *
     * @param user      The user message that triggered the assistant reply,
     *                  or undefined when none could be located (manual path
     *                  on a "naked" assistant message).
     * @param assistant The assistant message to extract from.
     * @param opts.force  When true this is the *manual* path (user clicked
     *                    the per-bubble "Extract insights" button). We then
     *                    force-scroll the Insights card into view so the
     *                    user can see the loading/result/empty state even
     *                    if the clicked bubble was far up in history.
     *                    When false, the auto path respects the user's
     *                    current scroll position (maybeScrollToBottom).
     */
    private async runInsightExtraction(
        user: ChatMessage | undefined,
        assistant: ChatMessage,
        opts: { force: boolean },
    ): Promise<void> {
        if (!this.insightCard) return;

        const summarizerConfig = this.createSummarizerConfig();
        if (!summarizerConfig) {
            // No summarizer configured (or no API key) — silently skip on
            // the auto path; the manual path validates this earlier and
            // shows a Notice, so reaching here on the manual path is rare.
            this.insightCard.hide();
            return;
        }

        const messageId = assistant.id;
        const requestGen = ++this.insightExtractionGen;
        const manual = opts.force;

        // Mount the loading card immediately so the user sees progress.
        // On the manual path we force-scroll so the card is guaranteed
        // visible even when the trigger was a history bubble.
        this.insightCard.showLoading(messageId);
        if (manual) {
            this.forceScrollToBottom();
        } else {
            this.maybeScrollToBottom();
        }

        let insights: ConversationInsight[] = [];
        let failed = false;
        try {
            insights = await extractInsights(summarizerConfig, {
                userMessage: user?.content ?? '',
                assistantMessage: assistant.content ?? '',
            });
        } catch (err) {
            console.warn('[Insights] extraction failed:', err);
            failed = true;
        }

        // Drop the result if anything moved on (new turn / cleared / etc.)
        if (this.insightExtractionGen !== requestGen) return;
        if (this.insightCard.messageId !== messageId) return;

        if (failed) {
            this.insightCard.showError(messageId);
            if (manual) this.forceScrollToBottom();
            return;
        }
        this.insightCard.showResults(messageId, insights);
        if (manual) {
            // Always keep the card in view on the manual path (including
            // the "No insights" empty state).
            this.forceScrollToBottom();
        } else if (insights.length > 0) {
            this.maybeScrollToBottom();
        }
    }

    /**
     * Handle a click on a follow-up suggestion button.
     *
     * Default behaviour: prefill the input editor with the full prompt and
     * focus it, so the user can review/edit before sending. When the
     * "auto-send on click" option is enabled, the prompt is sent immediately.
     */
    private handleFollowUpPick(action: { label: string; prompt: string }): void {
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
     * Click handler for the per-item "Deepen" button on the insight card.
     *
     * Strategy: rather than running a hidden background task, we send a
     * normal user message into the current chat session so the model can
     * use the full toolchain (streaming, tools, follow-up extraction,
     * etc.). The new assistant reply will naturally trigger another
     * insight-extraction pass, replacing the current card with refined
     * nuggets the user can then save as a note.
     *
     * Guards:
     * - Bail out if the chat is currently streaming (the insight card's
     *   own busy state already disables the buttons, this is belt-and-
     *   suspenders for any race with stream start).
     * - Bail if there's a non-empty draft in the input editor — we don't
     *   want to silently clobber whatever the user is typing. In that
     *   case we just drop the prompt into the editor and focus it,
     *   matching the non-auto-send branch of follow-up picks.
     */
    private handleInsightDeepen(insight: ConversationInsight): void {
        if (this.isStreaming) return;

        const prompt = buildInsightDeepenPrompt({
            title: insight.title,
            summary: insight.summary,
            tags: insight.tags,
            linkedNotes: insight.linkedNotes,
        });

        const draft = this.cmInput.getContent().trim();
        if (draft.length > 0) {
            // Don't trash the user's in-progress message — surface the
            // generated prompt so they can decide what to do.
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

    private getDynamicTools() {
        const tools = [];

        const imageTool = createImageTool(this.plugin);
        if (imageTool) tools.push(imageTool);

        if (this.plugin.settings.memoryEnabled) {
            tools.push(...createMemoryTools(this.plugin));
        }

        // Only add conversation history retrieval tools if context compression has occurred
        if (this.hasContextCompressed) {
            tools.push(...createConversationTools());
        }

        if (this.plugin.mcpManager) {
            tools.push(...this.plugin.mcpManager.getRegisteredTools(this.mcpSelector.getEnabledServers()));
        }
        return tools;
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

    /**
     * Returns true iff this message update represents the assistant (or a
     * sub-agent) having started to emit something the user can see — thinking
     * text, streaming content, or a streaming tool_call. In those states the
     * global typing indicator should step aside in favour of the bubble's own
     * in-place cursor (`▍`).
     */
    private isMessageProducingVisibleContent(msg: ChatMessage): boolean {
        if (msg.role === 'assistant') {
            if (msg.thinkingContent && !msg.thinkingComplete) return true;
            if (msg.streaming && msg.content) return true;
        }
        if (msg.role === 'tool_call' && msg.streaming) return true;
        return false;
    }

    /**
     * Move the singleton typing indicator to the tail of messagesEl. This is
     * a no-op if the indicator is already last, and a DOM move (not a
     * recreate) otherwise — `appendChild` on an existing child relocates it.
     */
    private pinTypingIndicatorToEnd() {
        const el = this.typingIndicatorEl;
        if (!el) return;
        if (el.parentElement !== this.messagesEl) {
            this.messagesEl.appendChild(el);
            return;
        }
        if (this.messagesEl.lastElementChild !== el) {
            this.messagesEl.appendChild(el);
        }
    }

    private showTypingIndicator() {
        const el = this.typingIndicatorEl;
        if (!el) return;
        this.pinTypingIndicatorToEnd();
        el.removeClass('session-typing-indicator--hidden');
        this.maybeScrollToBottom();
    }

    private hideTypingIndicator() {
        const el = this.typingIndicatorEl;
        if (!el) return;
        el.addClass('session-typing-indicator--hidden');
    }

    private hasUserMessages(): boolean {
        return this.chat ? this.chat.messages.some(m => m.role === 'user' || m.role === 'assistant') : false;
    }

    private updateNewChatBtnState() {
        if (this.newChatBtn) {
            this.newChatBtn.disabled = !this.hasUserMessages();
        }
        this.updateSessionBtnState();
        this.updateSessionTitle();
    }

    private updateSessionBtnState(): void {
        // Update session button visibility based on session count
        const shouldShow = this.sessionManager.sessionCount > 1;
        
        if (this.sessionBtn) {
            this.sessionBtn.style.display = shouldShow ? '' : 'none';
        }
        
        // Also hide the more actions button when there's only one session
        const sessionBtnGroup = this.sessionBtn?.parentElement;
        if (sessionBtnGroup) {
            const moreActionsBtn = sessionBtnGroup.querySelector('.session-toolbar__btn--dropdown');
            if (moreActionsBtn) {
                (moreActionsBtn as HTMLElement).style.display = shouldShow ? '' : 'none';
            }
        }
    }

    private updateSessionTitle() {
        const session = this.sessionManager.getActiveSessionSync();

        // Get full title for tooltip (no truncation)
        const fullTitle = session?.title || session?.firstUserMessage || t('view.newChat');
        // Truncate for display
        const displayTitle = fullTitle.length > 40 ? fullTitle.slice(0, 40) + '…' : fullTitle;

        if (this.sessionTitleEl) {
            this.sessionTitleEl.textContent = displayTitle;
            setTooltip(this.sessionTitleEl, fullTitle);
        }
    }

    /**
     * Handle click on session title to enable renaming
     */
    private handleTitleClick(container: HTMLElement): void {
        // Don't allow renaming while streaming
        if (this.isStreaming) return;

        // Get current full title
        const session = this.sessionManager.getActiveSessionSync();
        const currentTitle = session?.title || session?.firstUserMessage || '';

        // Hide the title element
        if (this.sessionTitleEl) {
            this.sessionTitleEl.style.display = 'none';
        }

        // Create input element for editing
        const input = container.createEl('input', {
            cls: 'session-toolbar__title-input',
            attr: {
                type: 'text',
                value: currentTitle,
                placeholder: t('view.sessionTitlePlaceholder'),
            },
        });

        input.focus();
        input.select();

        // Cleanup function
        const cleanup = () => {
            input.remove();
            if (this.sessionTitleEl) {
                this.sessionTitleEl.style.display = '';
            }
        };

        // Handle commit (save if non-empty)
        const commit = async () => {
            const newTitle = input.value.trim();
            if (newTitle) {
                this.sessionManager.setTitle(newTitle);
                await this.sessionManager.saveMetadata();
                this.updateSessionTitle();
            }
            // If empty, treat as cancel
            cleanup();
        };

        // Handle cancel
        const cancel = () => {
            cleanup();
        };

        // Event listeners
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void commit();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
            }
        });

        input.addEventListener('blur', () => {
            void commit();
        });
    }

    private async maybeGenerateSessionTitle() {
        const session = await this.sessionManager.getActiveSession();
        if (!session) return;

        if (session.title) return;
        const rounds = session.messages.filter(m => m.role === 'user').length;
        if (rounds <= 2) return;

        const summarizerConfig = this.createSummarizerConfig();
        if (!summarizerConfig) return;

        try {
            const summarySource = session.messages.filter(msg => msg.role === 'user' || msg.role === 'assistant');
            const generatedTitle = await summarizeConversation(summarizerConfig, { content: TITLE_SUMMARIZE_PROMPT }, summarySource);
            if (!generatedTitle) return;
            // Strip any markdown formatting the model may have emitted
            // despite the prompt's plain-text instruction, then cap length.
            const trimmedTitle = stripMarkdownToPlainText(generatedTitle).slice(0, 150);
            if (trimmedTitle) {
                this.sessionManager.setTitle(trimmedTitle);
                this.updateSessionTitle();
            }
        } catch (e) {
            console.warn('Failed to generate session title:', e);
        }
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
            SessionStatusDisplay.renderPanel(this.sessionStatusPanelEl, this.chat, max);
        }
    }

    private appendErrorBubble(message: string) {
        const errorText = this.formatErrorMessage(message);

        const bubble = this.messagesEl.createEl('div', {
            cls: 'session-bubble session-bubble--error',
        });

        const role = bubble.createEl('div', { cls: 'session-bubble__role' });
        const roleIcon = role.createEl('span', { cls: 'session-bubble__error-icon' });
        setIcon(roleIcon, 'alert-triangle');
        role.createEl('span', { text: t('view.roleError') });

        const content = bubble.createEl('div', { cls: 'session-bubble__content' });
        content.createEl('pre', {
            cls: 'session-bubble__error-text',
            text: errorText,
        });

        const actions = bubble.createEl('div', { cls: 'session-bubble__actions' });
        const copyBtn = actions.createEl('button', {
            cls: 'session-bubble__action-btn',
            attr: { 'aria-label': t('view.copyError') },
        });
        setIcon(copyBtn, 'copy');
        setTooltip(copyBtn, t('view.copyError'));
        copyBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            void this.copyErrorToClipboard(errorText);
        });

        bubble.addEventListener('contextmenu', (ev: MouseEvent) => {
            ev.preventDefault();
            const menu = new Menu();
            menu.addItem((item) => {
                item.setTitle(t('view.copyError'));
                item.setIcon('copy');
                item.onClick(() => {
                    void this.copyErrorToClipboard(errorText);
                });
            });
            menu.showAtMouseEvent(ev);
        });

        // Keep singleton typing indicator pinned to tail even when we insert
        // an error bubble via a different code path than `appendBubble`.
        this.pinTypingIndicatorToEnd();
        this.maybeScrollToBottom();
        console.error('Error:', message);
    }

    /**
     * Best-effort prettify error messages so JSON payloads embedded in the
     * message are easier to read inside the bubble. Falls back to the original
     * string when the input is not a recognisable JSON object.
     */
    private formatErrorMessage(message: string): string {
        if (!message) return '';
        const trimmed = message.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
            try {
                const parsed = JSON.parse(trimmed);
                return JSON.stringify(parsed, null, 2);
            } catch {
                /* not valid JSON — fall through */
            }
        }
        return message;
    }

    private async copyErrorToClipboard(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
            new Notice(t('view.copied'));
        } catch (err) {
            console.warn('Failed to copy error message:', err);
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

    private async handleDeleteHistorySessions(): Promise<void> {
        // Prevent deletion while streaming
        if (this.isStreaming) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }

        // Check if there are any sessions to delete (excluding current)
        const allSessions = this.sessionManager.getAllSessions();
        const historySessionsCount = allSessions.filter(s => s.id !== this.sessionManager.activeSessionId).length;
        
        if (historySessionsCount === 0) {
            new Notice(t('view.noHistorySessionsToDelete'));
            return;
        }

        // Show confirmation dialog
        const confirmed = await this.showDeleteHistoryConfirmation(historySessionsCount);
        if (!confirmed) return;

        try {
            // Delete all history sessions
            const deletedCount = await this.sessionManager.deleteAllHistorySessions();
            
            if (deletedCount > 0) {
                new Notice(t('view.historySessionsDeleted', { count: deletedCount }));
                
                // Update UI
                this.updateSessionBtnState();
                
                // Rebuild dropdown if open
                if (this.sessionDropdownEl && this.sessionDropdownEl.classList.contains('session-dropdown--open')) {
                    this.rebuildSessionDropdown();
                }
            } else {
                new Notice(t('view.noHistorySessionsDeleted'));
            }
        } catch (error) {
            console.error('Failed to delete history sessions:', error);
            new Notice(t('view.deleteHistorySessionsFailed'));
        }
    }

    private async showDeleteHistoryConfirmation(sessionCount: number): Promise<boolean> {
        return new DeleteHistoryConfirmModal(this.app, sessionCount).waitForResult();
    }


}
