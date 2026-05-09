import { App, Modal, setIcon, debounce } from 'obsidian';
import { t } from '../i18n';
import { SessionManager, SessionSnapshot } from '../session-manager';
import type { ChatMessage } from '../services/chat-stream';

export interface SessionSearchResult {
    sessionId: string;
    sessionTitle: string;
    messageId: string;
    messageIndex: number;
    messageRole: 'user' | 'assistant';
    matchedContent: string;
    /** Whether messages were loaded during search */
    loadedOnDemand?: boolean;
}

export class SessionSearchModal extends Modal {
    private sessionManager: SessionManager;
    private inputEl!: HTMLInputElement;
    private resultsEl!: HTMLElement;
    private loadingEl!: HTMLElement;
    private statusEl!: HTMLElement;
    private resultResolver: ((result: SessionSearchResult | null) => void) | null = null;
    private currentResults: SessionSearchResult[] = [];
    private searchAbortController: AbortController | null = null;
    private sessionsLoading: Set<string> = new Set();

    constructor(app: App, sessionManager: SessionManager) {
        super(app);
        this.sessionManager = sessionManager;
    }

    /** Opens the modal and returns the user's choice, or null if cancelled. */
    waitForResult(): Promise<SessionSearchResult | null> {
        return new Promise(resolve => {
            this.resultResolver = resolve;
            this.open();
        });
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('session-search-modal');

        this.setTitle(t('search.title'));

        // Search input
        const inputRow = contentEl.createDiv({ cls: 'session-search-modal__input-row' });
        const searchIcon = inputRow.createSpan({ cls: 'session-search-modal__search-icon' });
        setIcon(searchIcon, 'search');

        this.inputEl = inputRow.createEl('input', {
            cls: 'session-search-modal__input',
            attr: {
                type: 'text',
                placeholder: t('search.placeholder'),
                autocomplete: 'off',
            },
        });

        // Loading indicator
        this.loadingEl = contentEl.createDiv({ cls: 'session-search-modal__loading' });
        this.loadingEl.hide();
        const loadingSpinner = this.loadingEl.createSpan({ cls: 'session-search-modal__loading-spinner' });
        setIcon(loadingSpinner, 'loader');
        this.loadingEl.createSpan({ text: t('search.loading') });

        // Results container
        this.resultsEl = contentEl.createDiv({ cls: 'session-search-modal__results' });

        // Status bar
        this.statusEl = contentEl.createDiv({ cls: 'session-search-modal__status' });
        this.statusEl.hide();

        // Initial empty state
        this.showEmptyState();

        // Debounced search
        const debouncedSearch = debounce((query: string) => {
            void this.performSearch(query);
        }, 300, true);

        this.inputEl.addEventListener('input', () => {
            const query = this.inputEl.value.trim();
            if (query.length >= 2) {
                debouncedSearch(query);
            } else {
                this.clearResults();
                this.showEmptyState();
            }
        });

        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const selectedItem = this.resultsEl.querySelector('.session-search-modal__result-item--selected');
                const selectedIndex = selectedItem
                    ? Array.from(this.resultsEl.querySelectorAll('.session-search-modal__result-item')).indexOf(selectedItem)
                    : -1;

                if (selectedIndex >= 0 && this.currentResults[selectedIndex]) {
                    this.selectResult(this.currentResults[selectedIndex]!);
                } else if (this.currentResults.length > 0) {
                    this.selectResult(this.currentResults[0]!);
                }
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.navigateResults(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.navigateResults(-1);
            }
        });

        // Auto-focus input
        setTimeout(() => this.inputEl.focus(), 50);
    }

    onClose() {
        // Abort any pending search
        if (this.searchAbortController) {
            this.searchAbortController.abort();
            this.searchAbortController = null;
        }

        if (this.resultResolver) {
            this.resultResolver(null);
            this.resultResolver = null;
        }

        const { contentEl } = this;
        contentEl.empty();
        contentEl.removeClass('session-search-modal');
    }

    private showEmptyState() {
        this.resultsEl.empty();
        this.resultsEl.createDiv({
            cls: 'session-search-modal__empty',
            text: t('search.empty'),
        });
        this.statusEl.hide();
    }

    private clearResults() {
        this.currentResults = [];
        this.resultsEl.empty();
        this.statusEl.hide();
    }

    private navigateResults(direction: number) {
        const items = this.resultsEl.querySelectorAll('.session-search-modal__result-item');
        if (items.length === 0) return;

        let currentIndex = -1;
        items.forEach((item, i) => {
            if (item.classList.contains('session-search-modal__result-item--selected')) {
                currentIndex = i;
            }
        });

        items.forEach(item => item.classList.remove('session-search-modal__result-item--selected'));

        let newIndex = currentIndex + direction;
        if (newIndex < 0) newIndex = items.length - 1;
        if (newIndex >= items.length) newIndex = 0;

        items[newIndex]?.classList.add('session-search-modal__result-item--selected');
        items[newIndex]?.scrollIntoView({ block: 'nearest' });
    }

    private async performSearch(query: string) {
        // Abort previous search
        if (this.searchAbortController) {
            this.searchAbortController.abort();
        }
        this.searchAbortController = new AbortController();
        const signal = this.searchAbortController.signal;

        // Show loading
        this.loadingEl.show();
        this.resultsEl.empty();
        this.currentResults = [];

        const lowerQuery = query.toLowerCase();
        const sessions = this.sessionManager.getAllSessions();
        let totalSearched = 0;
        let resultsFound = 0;

        // Track sessions that need to be loaded
        const sessionsToLoad: string[] = [];
        const loadedResults: SessionSearchResult[] = [];

        try {
            // First pass: search already loaded sessions
            for (const session of sessions) {
                if (signal.aborted) return;

                const fullSession = this.sessionManager.getSessionSync(session.id);
                if (fullSession && fullSession.messages.length > 0) {
                    // Session is loaded, search it now
                    const results = this.searchSessionMessages(fullSession, lowerQuery);
                    loadedResults.push(...results);
                    totalSearched++;
                } else {
                    // Session needs to be loaded
                    sessionsToLoad.push(session.id);
                }
            }

            // Show initial results from already loaded sessions
            this.updateResults(loadedResults, totalSearched, sessionsToLoad.length);
            resultsFound = loadedResults.length;

            // Second pass: load and search remaining sessions asynchronously
            for (const sessionId of sessionsToLoad) {
                if (signal.aborted) return;

                this.sessionsLoading.add(sessionId);

                try {
                    const fullSession = await this.sessionManager.getSession(sessionId);
                    if (signal.aborted) return;

                    if (fullSession && fullSession.messages.length > 0) {
                        const results = this.searchSessionMessages(fullSession, lowerQuery, true);
                        loadedResults.push(...results);
                        resultsFound += results.length;
                    }
                } catch (err) {
                    console.warn(`[SessionSearch] Failed to load session ${sessionId}:`, err);
                }

                this.sessionsLoading.delete(sessionId);
                totalSearched++;

                // Update results dynamically
                this.updateResults(loadedResults, totalSearched, sessionsToLoad.length - (totalSearched - sessions.length + sessionsToLoad.length));
            }

            // Final update
            this.updateResults(loadedResults, totalSearched, 0);

        } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            console.error('[SessionSearch] Search error:', err);
        } finally {
            this.loadingEl.hide();
            this.searchAbortController = null;
        }
    }

    private searchSessionMessages(
        session: SessionSnapshot,
        lowerQuery: string,
        loadedOnDemand = false
    ): SessionSearchResult[] {
        const results: SessionSearchResult[] = [];
        const displayTitle = session.title || session.firstUserMessage || t('view.newChat');

        for (let i = 0; i < session.messages.length; i++) {
            const msg = session.messages[i]!;
            // Only search user and assistant messages
            if (msg.role !== 'user' && msg.role !== 'assistant') continue;

            const content = msg.content || '';
            if (content.toLowerCase().includes(lowerQuery)) {
                results.push({
                    sessionId: session.id,
                    sessionTitle: displayTitle,
                    messageId: msg.id,
                    messageIndex: i,
                    messageRole: msg.role as 'user' | 'assistant',
                    matchedContent: this.extractMatchContext(content, lowerQuery),
                    loadedOnDemand,
                });
            }
        }

        return results;
    }

    private extractMatchContext(content: string, lowerQuery: string): string {
        const maxLength = 120;
        const lowerContent = content.toLowerCase();
        const matchIndex = lowerContent.indexOf(lowerQuery);

        if (matchIndex === -1) {
            return content.slice(0, maxLength) + (content.length > maxLength ? '…' : '');
        }

        // Get context around the match
        const contextStart = Math.max(0, matchIndex - 30);
        const contextEnd = Math.min(content.length, matchIndex + lowerQuery.length + 60);
        let context = content.slice(contextStart, contextEnd);

        if (contextStart > 0) context = '…' + context;
        if (contextEnd < content.length) context = context + '…';

        return context;
    }

    private updateResults(results: SessionSearchResult[], searchedCount: number, loadingCount: number) {
        this.currentResults = results;
        this.resultsEl.empty();

        if (results.length === 0) {
            if (loadingCount > 0) {
                this.resultsEl.createDiv({
                    cls: 'session-search-modal__empty',
                    text: t('search.searching'),
                });
            } else {
                this.resultsEl.createDiv({
                    cls: 'session-search-modal__empty',
                    text: t('search.noResults'),
                });
            }
        } else {
            for (let i = 0; i < results.length; i++) {
                const result = results[i]!;
                const item = this.resultsEl.createDiv({
                    cls: 'session-search-modal__result-item' + (i === 0 ? ' session-search-modal__result-item--selected' : ''),
                });

                // Session title
                const header = item.createDiv({ cls: 'session-search-modal__result-header' });
                header.createSpan({
                    cls: 'session-search-modal__result-title',
                    text: result.sessionTitle,
                });
                const roleLabel = result.messageRole === 'user' ? t('view.roleYou') : t('view.roleAI');
                header.createSpan({
                    cls: 'session-search-modal__result-role session-search-modal__result-role--' + result.messageRole,
                    text: roleLabel,
                });

                // Matched content
                item.createDiv({
                    cls: 'session-search-modal__result-content',
                    text: result.matchedContent,
                });

                // Loading indicator for on-demand loaded sessions
                if (result.loadedOnDemand) {
                    item.createDiv({
                        cls: 'session-search-modal__result-badge',
                        text: t('search.loadedOnDemand'),
                    });
                }

                item.addEventListener('click', () => {
                    this.selectResult(result);
                });

                item.addEventListener('mouseenter', () => {
                    this.resultsEl.querySelectorAll('.session-search-modal__result-item')
                        .forEach(el => el.classList.remove('session-search-modal__result-item--selected'));
                    item.classList.add('session-search-modal__result-item--selected');
                });
            }
        }

        // Update status
        this.statusEl.show();
        this.statusEl.empty();
        const statusText = t('search.status', {
            count: String(results.length),
            searched: String(searchedCount),
        });
        this.statusEl.setText(statusText);

        if (loadingCount > 0) {
            this.statusEl.createSpan({
                cls: 'session-search-modal__status-loading',
                text: ' ' + t('search.loadingMore', { count: String(loadingCount) }),
            });
        }
    }

    private selectResult(result: SessionSearchResult) {
        if (this.resultResolver) {
            this.resultResolver(result);
            this.resultResolver = null;
        }
        this.close();
    }
}
