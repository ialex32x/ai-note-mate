import type { App } from 'obsidian';
import type { ChatMessage, ConversationSummary, AgentTokenBreakdown, QuickAskTurn } from './services/chat-stream';
import type { TokenUsage } from './services/llm-provider';
import type { InsightCardState } from './services/insights';
import type { SuggestionCardState } from './services/suggestions';
import type { TodoState, TodoItem } from './services/tools/todo-state';
import type { GeneratedAsset } from './services/generated-asset-collection';
import type {
    ReadonlyChatMessages,
    SessionMetadata,
    SessionMessagesFile,
    SessionListFile,
    GlobalTokenStatisticsFile,
    SessionSnapshot,
} from './session-manager-types';

// Re-export public types for backward compatibility
export type { SessionMetadata, SessionSnapshot } from './session-manager-types';

/**
 * Session manager with persistent storage and lazy loading.
 * - Metadata is stored in `sessions/list.json`
 * - Messages are stored in `sessions/${id}/messages.jsonl` (JSONL, loaded on demand)
 */
export class SessionManager {
    /** Session metadata map */
    private metadataMap: Map<string, SessionMetadata> = new Map();
    /** Loaded messages cache */
    private messagesCache: Map<string, ChatMessage[]> = new Map();
    /** Loaded summaries cache for context compression */
    private summariesCache: Map<string, ConversationSummary[]> = new Map();
    /** Loaded sub-agent messages cache, keyed by sessionId, then by parent toolCallId */
    private subAgentMessagesCache: Map<string, Record<string, ChatMessage[]>> = new Map();
    /** Loaded per-agent token usage breakdown cache, keyed by sessionId */
    private agentTokenBreakdownCache: Map<string, AgentTokenBreakdown> = new Map();
    /**
     * Loaded TODO state cache, keyed by sessionId. Absent entry means
     * "no todos for this session" — callers should not rely on a
     * sentinel empty state from this map.
     */
    private todosCache: Map<string, TodoState> = new Map();
    /** Loaded QuickAsk side-turns cache, keyed by sessionId (v6+). */
    private quickAskTurnsCache: Map<string, QuickAskTurn[]> = new Map();
    /** Loaded generated-asset records, keyed by sessionId (v7+). */
    private toolCallAssetsCache: Map<string, GeneratedAsset[]> = new Map();
    /** Set of session IDs whose messages have been loaded */
    private loadedMessages: Set<string> = new Set();
    /** Tracks how many messages have been persisted for each session
     *  (used for append-only JSONL writes). */
    private persistedMessageCounts: Map<string, number> = new Map();

    /** Global cumulative token usage across all sessions, persisted in statistics.json */
    private _globalTokenStats: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 };

    /**
     * Sequential write chain to prevent concurrent file writes (list.json + session files).
     *
     * Every write operation is appended to this chain rather than racing via a
     * bare boolean / null-check mutex. This eliminates the TOCTOU gap between
     * "await previous save" and "assign new save" that existed in the old
     * `savePromise` pattern. Each work item reads its snapshot right before
     * performing I/O, so state changes that happen during an earlier write
     * (e.g. `createSession()` adding a new session) are always visible to the
     * next writer in the chain.
     *
     * The `.then(fn, fn)` dual-handler form ensures a single failing write
     * (e.g. disk full) does not poison the chain — subsequent callers still
     * execute their own work.
     */
    private writeChain: Promise<void> = Promise.resolve();

    private _activeSessionId: string;
    private _nextId = 1;
    private readonly app: App;
    private sessionsDir: string;
    private listFilePath: string;
    private statisticsFilePath: string;
    private activeFilePath: string;
    private cacheLoaded = false;
    /** In-flight load promise so concurrent await calls do not race. */
    private _loadPromise: Promise<void> | null = null;

    /**
     * @param app        Obsidian app handle.
     * @param sessionsDir Vault-relative directory where session files live.
     *                    Resolved by the caller (typically `plugin.paths.sessions()`)
     *                    so this class stays agnostic of the plugin layout.
     */
    constructor(app: App, sessionsDir: string) {
        this.app = app;
        this.sessionsDir = sessionsDir;
        this.listFilePath = `${this.sessionsDir}/list.json`;
        this.statisticsFilePath = `${this.sessionsDir}/statistics.json`;
        this.activeFilePath = `${this.sessionsDir}/active.json`;
        this._activeSessionId = '';
    }

    /** Whether {@link loadFromCache} has completed successfully at least once. */
    get isCacheLoaded(): boolean {
        return this.cacheLoaded;
    }

    get activeSessionId(): string {
        return this._activeSessionId;
    }

    get sessionCount(): number {
        return this.metadataMap.size;
    }

    /** Get the global cumulative token usage across all sessions */
    getGlobalTokenUsage(): TokenUsage {
        return { ...this._globalTokenStats };
    }

    /** Get all sessions sorted by updatedAt (most recent first) - metadata only, no messages */
    getAllSessions(): SessionSnapshot[] {
        return Array.from(this.metadataMap.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(meta => this.metadataToSnapshot(meta));
    }

    /** Get a session snapshot by ID (loads messages if not cached) */
    async getSession(id: string): Promise<SessionSnapshot | undefined> {
        const meta = this.metadataMap.get(id);
        if (!meta) return undefined;
        await this.loadMessages(id);
        return this.metadataToSnapshot(meta);
    }

    /** Get session snapshot synchronously (returns undefined if messages not loaded) */
    getSessionSync(id: string): SessionSnapshot | undefined {
        const meta = this.metadataMap.get(id);
        if (!meta) return undefined;
        if (!this.loadedMessages.has(id)) return undefined;
        return this.metadataToSnapshot(meta);
    }

    /**
     * One-line display label from in-memory metadata only (no messages file read).
     * Same rule as the session toolbar: non-empty `title`, else non-empty `firstUserMessage`,
     * else `""` when the session exists but has no label yet.
     *
     * @returns `undefined` if `sessionId` is not in the registry (e.g. session removed).
     */
    getSessionMetadataDisplayLine(sessionId: string): string | undefined {
        const meta = this.metadataMap.get(sessionId);
        if (!meta) return undefined;
        const title = meta.title.trim();
        if (title.length > 0) return title;
        const first = meta.firstUserMessage.trim();
        if (first.length > 0) return first;
        return "";
    }

    /** Get the active session snapshot (loads messages if not cached) */
    async getActiveSession(): Promise<SessionSnapshot | undefined> {
        return this.getSession(this._activeSessionId);
    }

    /** Get active session synchronously (returns undefined if messages not loaded) */
    getActiveSessionSync(): SessionSnapshot | undefined {
        return this.getSessionSync(this._activeSessionId);
    }

    /** Convert metadata to snapshot (uses cached messages) */
    private metadataToSnapshot(meta: SessionMetadata): SessionSnapshot {
        return {
            id: meta.id,
            title: meta.title,
            firstUserMessage: meta.firstUserMessage,
            messages: this.messagesCache.get(meta.id) ?? [],
            tokenUsage: { ...meta.tokenUsage },
            createdAt: meta.createdAt,
            updatedAt: meta.updatedAt,
        };
    }

    /** Create a new empty session and make it active. Returns the new session ID. */
    createSession(): string {
        const id = `session-${this._nextId++}`;
        const now = Date.now();
        const meta: SessionMetadata = {
            id,
            title: '',
            firstUserMessage: '',
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
            createdAt: now,
            updatedAt: now,
        };
        this.metadataMap.set(id, meta);
        this.messagesCache.set(id, []);
        this.loadedMessages.add(id);
        this._activeSessionId = id;
        // Persist active session ID to active.json so the new session
        // survives a plugin reload before any other persistence happens.
        void this.saveActiveFile();
        return id;
    }

    /** Set the title of the active session */
    setTitle(title: string): void {
        this.setSessionTitle(this._activeSessionId, title);
    }

    /**
     * Set the title of a specific session by id. Used by background
     * SessionRuntime instances that finish their turn after the view
     * has switched away — they need to write into their own metadata,
     * not whichever session happens to be active.
     */
    setSessionTitle(sessionId: string, title: string): void {
        const meta = this.metadataMap.get(sessionId);
        if (meta) {
            meta.title = title;
        }
    }

    /** Get the draft input from the active session */
    getDraftInput(): string {
        const meta = this.metadataMap.get(this._activeSessionId);
        return meta?.draftInput ?? '';
    }

    /**
     * Set the draft input for a session. Defaults to the active session.
     * Accepts an explicit `sessionId` for callers like {@link branchSession}
     * that need to seed a non-active session's draft.
     *
     * Persists to `sessions/{id}/user-input.json` (fire-and-forget).
     */
    setDraftInput(draft: string, sessionId?: string): void {
        const id = sessionId ?? this._activeSessionId;
        const meta = this.metadataMap.get(id);
        if (meta) {
            meta.draftInput = draft;
        }
        void this.savePerSessionUserInput(id, draft);
    }

    /**
     * Get the persisted insight card state for a specific session, or
     * undefined if none has been recorded (or the session no longer
     * exists). Used by SessionRuntime on hydration / by the view on
     * cold-load replay.
     */
    getSessionLastInsights(sessionId: string): InsightCardState | undefined {
        return this.metadataMap.get(sessionId)?.lastInsights;
    }

    /**
     * Record (or clear) the insight card state for a specific session.
     * Pass `undefined` to clear. Calls with `state.phase === 'loading'`
     * are ignored on purpose — loading is a transient runtime-only
     * state that should never round-trip through disk.
     *
     * Mutates in-memory metadata and immediately persists the state to
     * the per-session `insights.json` file (fire-and-forget).
     */
    setSessionLastInsights(sessionId: string, state: InsightCardState | undefined): void {
        const meta = this.metadataMap.get(sessionId);
        if (!meta) return;
        if (state && state.phase === 'loading') return;
        if (state) {
            meta.lastInsights = state;
        } else {
            delete meta.lastInsights;
        }
        // Persist to per-session file (fire-and-forget; errors are logged internally).
        void this.savePerSessionInsights(sessionId, state);
    }

    /** Convenience: clear the insight card state for a specific session. */
    clearSessionLastInsights(sessionId: string): void {
        this.setSessionLastInsights(sessionId, undefined);
    }

    /**
     * Get the persisted suggestion bar state for a specific session,
     * or undefined if none has been recorded. Mirrors
     * {@link getSessionLastInsights}.
     */
    getSessionLastSuggestions(sessionId: string): SuggestionCardState | undefined {
        return this.metadataMap.get(sessionId)?.lastSuggestions;
    }

    /**
     * Record (or clear) the suggestion bar state for a specific session.
     * Pass `undefined` to clear. Calls with `state.phase === 'loading'`
     * are ignored — loading is a transient runtime-only state.
     *
     * Mutates in-memory metadata and immediately persists the state to
     * the per-session `suggestions.json` file (fire-and-forget).
     */
    setSessionLastSuggestions(sessionId: string, state: SuggestionCardState | undefined): void {
        const meta = this.metadataMap.get(sessionId);
        if (!meta) return;
        if (state && state.phase === 'loading') return;
        if (state) {
            meta.lastSuggestions = state;
        } else {
            delete meta.lastSuggestions;
        }
        // Persist to per-session file (fire-and-forget; errors are logged internally).
        void this.savePerSessionSuggestions(sessionId, state);
    }

    /** Convenience: clear the suggestion bar state for a specific session. */
    clearSessionLastSuggestions(sessionId: string): void {
        this.setSessionLastSuggestions(sessionId, undefined);
    }

    /**
     * Get the persisted TODO state for a specific session. Returns
     * `undefined` when nothing is on file (the session predates v4 or
     * the model never wrote anything). Callers that need a guaranteed
     * non-null snapshot should fall back to `emptyTodoState()`.
     */
    getSessionTodos(sessionId: string): TodoState | undefined {
        return this.todosCache.get(sessionId);
    }

    /**
     * Record the TODO state for a specific session. Pass `undefined`
     * or a state with an empty `items` array to clear the entry.
     *
     * Mutates in-memory caches and immediately persists the state to
     * the per-session `todos.json` file (fire-and-forget).
     */
    setSessionTodos(sessionId: string, state: TodoState | undefined): void {
        if (!this.metadataMap.has(sessionId)) return;
        if (!state || state.items.length === 0) {
            this.todosCache.delete(sessionId);
            void this.savePerSessionTodos(sessionId, undefined);
            return;
        }
        // Defensive clone so callers can't accidentally mutate the
        // cached snapshot after handing it off.
        const cloned: TodoState = {
            items: state.items.map(item => ({ ...item })),
            updatedAt: state.updatedAt,
        };
        this.todosCache.set(sessionId, cloned);
        // Persist to per-session file (fire-and-forget; errors are logged internally).
        void this.savePerSessionTodos(sessionId, cloned);
    }

    /** Convenience: clear the TODO state for a specific session. */
    clearSessionTodos(sessionId: string): void {
        this.setSessionTodos(sessionId, undefined);
    }

    /**
     * Get QuickAsk side-turns for the active session. Returns `undefined`
     * when nothing is on file (session predates v6 or has no side-turns).
     */
    getQuickAskTurns(): QuickAskTurn[] | undefined {
        return this.quickAskTurnsCache.get(this._activeSessionId);
    }

    /**
     * Get generated-asset records for a specific session (v7+).
     * Returns `undefined` when nothing is on file (session predates
     * v7 or no assets were generated).
     */
    getSessionToolCallAssets(sessionId: string): GeneratedAsset[] | undefined {
        return this.toolCallAssetsCache.get(sessionId);
    }

    /** Get the first user message content from the active session */
    getFirstUserMessage(): string | null {
        const messages = this.messagesCache.get(this._activeSessionId);
        if (!messages) return null;
        const firstUserMsg = messages.find(m => m.role === 'user');
        return firstUserMsg?.content ?? null;
    }

    /**
     * Save a session's state into the in-memory caches by explicit id,
     * independent of `activeSessionId`. This is the back-end used by both
     * the active-session shortcut above and by background SessionRuntime
     * instances that need to persist their progress after the view has
     * already switched away from them.
     *
     * Only updates the in-memory caches + metadata; callers still need to
     * invoke {@link saveToCache} (or one of its triggers) to flush to disk.
     */
    async saveSession(
        sessionId: string,
        currentMessages: ReadonlyChatMessages,
        currentTokenUsage: TokenUsage,
        summaries?: ConversationSummary[],
        subAgentMessages?: Record<string, ChatMessage[]>,
        agentTokenBreakdown?: AgentTokenBreakdown,
        todos?: TodoState,
        quickAskTurns?: QuickAskTurn[],
        toolCallAssets?: GeneratedAsset[],
    ): Promise<void> {
        const meta = this.metadataMap.get(sessionId);
        if (!meta) return;

        // Update messages cache
        this.messagesCache.set(sessionId, [...currentMessages]);
        this.loadedMessages.add(sessionId);

        // Update summaries cache (undefined means "no change")
        if (summaries && summaries.length > 0) {
            const cloned = summaries.map(s => ({ ...s }));
            this.summariesCache.set(sessionId, cloned);
            void this.savePerSessionSummaries(sessionId, cloned);
        }

        // Update sub-agent messages cache (undefined means "no change";
        // pass an empty object to explicitly clear)
        if (subAgentMessages !== undefined) {
            if (Object.keys(subAgentMessages).length > 0) {
                this.subAgentMessagesCache.set(sessionId, subAgentMessages);
                // Persist to individual files (fire-and-forget).
                void this.savePerSessionSubAgentMessages(sessionId, subAgentMessages);
            } else {
                this.subAgentMessagesCache.delete(sessionId);
                void this.savePerSessionSubAgentMessages(sessionId, undefined);
            }
        }

        // Update per-agent token usage breakdown cache (undefined means "no
        // change"; the orchestrator's getter always returns an object, and
        // single-agent ChatStream will simply never pass it).
        if (agentTokenBreakdown !== undefined) {
            const hasAny = Object.keys(agentTokenBreakdown.subAgents).length > 0
                || agentTokenBreakdown.main.totalTokens > 0;
            if (hasAny) {
                const cloned: AgentTokenBreakdown = {
                    main: { ...agentTokenBreakdown.main },
                    subAgents: Object.fromEntries(
                        Object.entries(agentTokenBreakdown.subAgents).map(([k, v]) => [k, { ...v }]),
                    ),
                };
                this.agentTokenBreakdownCache.set(sessionId, cloned);
                // Persist to per-session file (fire-and-forget).
                void this.savePerSessionAgentTokenBreakdown(sessionId, cloned);
            } else {
                this.agentTokenBreakdownCache.delete(sessionId);
                void this.savePerSessionAgentTokenBreakdown(sessionId, undefined);
            }
        }

        // Update TODO state cache (undefined means "no change"; an
        // empty list explicitly clears, mirroring the subAgentMessages
        // convention). Defensive clone so the caller's snapshot stays
        // independent from the cache.
        if (todos !== undefined) {
            this.setSessionTodos(sessionId, todos);
        }

        // Update side-turns cache (undefined means "no change";
        // pass an empty array to explicitly clear).
        if (quickAskTurns !== undefined) {
            if (quickAskTurns.length > 0) {
                const cloned = quickAskTurns.map(t => ({ ...t }));
                this.quickAskTurnsCache.set(sessionId, cloned);
                void this.savePerSessionQuickAskTurns(sessionId, cloned);
            } else {
                this.quickAskTurnsCache.delete(sessionId);
                void this.savePerSessionQuickAskTurns(sessionId, undefined);
            }
        }

        // Update generated-asset collection (v7+; undefined means "no
        // change"; pass an empty array to explicitly clear).
        if (toolCallAssets !== undefined) {
            if (toolCallAssets.length > 0) {
                const cloned = [...toolCallAssets];
                this.toolCallAssetsCache.set(sessionId, cloned);
                void this.savePerSessionToolCallAssets(sessionId, cloned);
            } else {
                this.toolCallAssetsCache.delete(sessionId);
                void this.savePerSessionToolCallAssets(sessionId, undefined);
            }
        }

        // Update firstUserMessage if not already set
        if (!meta.firstUserMessage && currentMessages.length > 0) {
            const firstUserMsg = currentMessages.find(m => m.role === 'user');
            if (firstUserMsg) {
                meta.firstUserMessage = firstUserMsg.content.slice(0, 100);
            }
        }

        // Compute delta vs previous metadata and accumulate into global stats.
        // Only positive deltas are applied — token usage is monotonic within a
        // session, so a negative delta would indicate a bug; clamping prevents
        // the global stats from going out of sync.
        const prev = meta.tokenUsage;
        this._globalTokenStats.promptTokens += Math.max(0, currentTokenUsage.promptTokens - prev.promptTokens);
        this._globalTokenStats.completionTokens += Math.max(0, currentTokenUsage.completionTokens - prev.completionTokens);
        this._globalTokenStats.totalTokens += Math.max(0, currentTokenUsage.totalTokens - prev.totalTokens);
        this._globalTokenStats.cachedPromptTokens += Math.max(0, currentTokenUsage.cachedPromptTokens - prev.cachedPromptTokens);

        meta.tokenUsage = { ...currentTokenUsage };
        meta.updatedAt = Date.now();
    }

    /** Get sub-agent messages for the active session */
    getSubAgentMessages(): Record<string, ChatMessage[]> | undefined {
        return this.subAgentMessagesCache.get(this._activeSessionId);
    }

    /** Get per-agent token usage breakdown for the active session (v3+ only). */
    getAgentTokenBreakdown(): AgentTokenBreakdown | undefined {
        return this.agentTokenBreakdownCache.get(this._activeSessionId);
    }

    /** Get summaries for the active session */
    getSummaries(): ConversationSummary[] {
        return this.summariesCache.get(this._activeSessionId) ?? [];
    }

    /** Set summaries for the active session */
    setSummaries(summaries: ConversationSummary[]): void {
        this.summariesCache.set(this._activeSessionId, summaries.map(s => ({ ...s })));
    }

    /** Get summaries for a specific session */
    getSessionSummaries(sessionId: string): ConversationSummary[] {
        return this.summariesCache.get(sessionId) ?? [];
    }

    /**
     * Branch off a new session from an existing session at a given user-message
     * anchor. The new session is initialised with the prefix of messages that
     * appear BEFORE the anchor (so the anchor's user input goes back into the
     * draft, ready to be edited and resent), and every other piece of session
     * state — token usage, summaries, sub-agent messages, agent token
     * breakdown, title, firstUserMessage — starts fresh, exactly as if the
     * user had created a brand-new session.
     *
     * The newly-created session is registered in {@link metadataMap} but is
     * NOT made the active session here. The caller is expected to drive the
     * usual switch flow (detach old runtime → `switchTo(newId)` → bind),
     * which keeps the view layer in charge of UI transitions.
     *
     * @returns `{ newSessionId, draftInput }` on success, or `null` when the
     *          source session is missing or the anchor is not a user message
     *          inside it.
     */
    async branchSession(
        sourceId: string,
        anchorMessageId: string,
    ): Promise<{ newSessionId: string; draftInput: string } | null> {
        const sourceMeta = this.metadataMap.get(sourceId);
        if (!sourceMeta) return null;

        // Ensure source messages are available before slicing.
        await this.loadMessages(sourceId);
        const sourceMessages = this.messagesCache.get(sourceId) ?? [];

        const anchorIdx = sourceMessages.findIndex(m => m.id === anchorMessageId);
        if (anchorIdx < 0) return null;
        const anchor = sourceMessages[anchorIdx]!;
        if (anchor.role !== 'user') return null;

        // Slice messages BEFORE the anchor; the anchor itself goes to draft.
        // Shallow-clone each entry and force `streaming: false` so the new
        // session never shares mutable state with the source.
        const prefix = sourceMessages.slice(0, anchorIdx).map(m => ({
            ...m,
            streaming: false,
        }));

        // Snapshot active id around createSession() — that helper sets itself
        // active as a side effect, but branchSession promises only to create
        // the session, leaving switching to the caller.
        const prevActive = this._activeSessionId;
        const newId = this.createSession();
        this._activeSessionId = prevActive;

        // Seed the new session with the prefix and the draft.
        const newMeta = this.metadataMap.get(newId);
        if (newMeta) {
            this.setDraftInput(anchor.content, newId);
            if (prefix.length > 0) {
                const firstUserMsg = prefix.find(m => m.role === 'user');
                if (firstUserMsg) {
                    newMeta.firstUserMessage = firstUserMsg.content.slice(0, 100);
                }
            }
        }
        this.messagesCache.set(newId, prefix);
        this.loadedMessages.add(newId);

        return { newSessionId: newId, draftInput: anchor.content };
    }

    /** Switch to a different session by ID. Returns true if successful. */
    async switchTo(targetId: string): Promise<boolean> {
        if (this.metadataMap.has(targetId) && targetId !== this._activeSessionId) {
            this._activeSessionId = targetId;
            // Persist activeSessionId change to active.json only — no need
            // to rewrite the entire list.json for a session switch.
            await this.saveActiveFile();
            return true;
        }
        return false;
    }

    /**
     * Delete a session by ID. Removes session from memory, saves list.json,
     * and deletes the messages file. Messages file deletion failure does not
     * affect the result.
     *
     * If the deleted session was the active one, its ID is cleared from the
     * active-session slot so that the caller (typically the session navigator)
     * can decide which session to switch to next.
     *
     * Returns true if the session was found and deleted, false otherwise.
     */
    async deleteSession(id: string): Promise<boolean> {
        if (!this.metadataMap.has(id)) return false;

        const wasActive = id === this._activeSessionId;

        // Deduct the session's token usage from global stats before removing metadata
        const meta = this.metadataMap.get(id)!;
        this._globalTokenStats.promptTokens = Math.max(0,
            this._globalTokenStats.promptTokens - meta.tokenUsage.promptTokens);
        this._globalTokenStats.completionTokens = Math.max(0,
            this._globalTokenStats.completionTokens - meta.tokenUsage.completionTokens);
        this._globalTokenStats.totalTokens = Math.max(0,
            this._globalTokenStats.totalTokens - meta.tokenUsage.totalTokens);
        this._globalTokenStats.cachedPromptTokens = Math.max(0,
            this._globalTokenStats.cachedPromptTokens - meta.tokenUsage.cachedPromptTokens);

        this.metadataMap.delete(id);

        // Clean up messages cache
        this.messagesCache.delete(id);
        this.loadedMessages.delete(id);
        this.persistedMessageCounts.delete(id);
        // Clean up summaries cache
        this.summariesCache.delete(id);
        // Clean up sub-agent messages cache
        this.subAgentMessagesCache.delete(id);
        // Clean up per-agent token usage breakdown cache
        this.agentTokenBreakdownCache.delete(id);
        // Clean up TODO state cache
        this.todosCache.delete(id);
        // Clean up side-turns cache
        this.quickAskTurnsCache.delete(id);
        // Clean up generated-asset cache
        this.toolCallAssetsCache.delete(id);

        // Save list.json after successful memory deletion — must go through
        // the write chain so concurrent background saves do not race.
        //
        // Persist updated session list (metadata removed).  The active
        // session ID is persisted separately below so that loadFromCache
        // can detect a stale activeSessionId and fall back gracefully.
        await this.saveMetadata();

        if (wasActive) {
            this._activeSessionId = '';
            void this.saveActiveFile();
        }

        // Delete messages file (failure is non-critical)
        try {
            const adapter = this.app.vault.adapter;
            // Remove new-format messages file
            const msgPath = this.getMessagesFilePath(id);
            if (await adapter.exists(msgPath)) {
                await adapter.remove(msgPath);
            }
            // Also clean up legacy flat file if present
            const oldPath = this.getOldMessagesFilePath(id);
            if (await adapter.exists(oldPath)) {
                await adapter.remove(oldPath);
            }
            // Also clean up the session's subdirectory (if any).
            const sessionDir = this.getSessionDirPath(id);
            if (await adapter.exists(sessionDir)) {
                // Delete individual files first, then rmdir.
                try {
                    const listing = await adapter.list(sessionDir);
                    for (const file of listing.files) {
                        await adapter.remove(`${sessionDir}/${file}`);
                    }
                    for (const folder of listing.folders) {
                        // Recursively clean up nested dirs (paranoid; shouldn't exist).
                        try { await adapter.rmdir(`${sessionDir}/${folder}`, true); } catch { /* ignore */ }
                    }
                } catch { /* best-effort listing; continue to rmdir anyway */ }
                try { await adapter.rmdir(sessionDir, false); } catch { /* may have been removed already */ }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to delete messages file:', error);
        }

        return true;
    }

    /**
     * Delete all sessions except the current active session.
     *
     * The currently active session is *always* preserved. When
     * `excludeIds` is provided, those additional session IDs are also
     * skipped — the typical use case is letting the user opt out of
     * deleting sessions whose runtime is currently mid-turn (busy).
     *
     * Returns the number of sessions actually deleted.
     */
    async deleteAllHistorySessions(excludeIds?: ReadonlySet<string>): Promise<number> {
        const sessionsToDelete = Array.from(this.metadataMap.keys()).filter(
            id => id !== this._activeSessionId && !(excludeIds?.has(id))
        );

        if (sessionsToDelete.length === 0) {
            return 0;
        }

        let deletedCount = 0;

        for (const sessionId of sessionsToDelete) {
            if (await this.deleteSession(sessionId)) {
                deletedCount++;
            }
        }

        return deletedCount;
    }

    /**
     * Append a unit of work to the serialised write chain.
     *
     * Every call to {@link saveMetadata}, {@link saveToCache},
     * {@link switchTo}, and {@link deleteSession} flows through here so
     * list.json is never written concurrently.  The `.then(fn, fn)`
     * dual-handler ensures a single failing write (e.g. disk full) does
     * not poison the chain — subsequent callers still execute their own
     * work.
     *
     * The work function reads `_activeSessionId`, `_nextId`, and
     * `metadataMap` at call time, which is *after* every preceding chain
     * entry has completed.  This eliminates the TOCTOU gap that existed
     * in the old `savePromise`-based mutex pattern.
     */
    private enqueueWrite(work: () => Promise<void>): Promise<void> {
        const next = this.writeChain.then(work, work);
        this.writeChain = next;
        return next;
    }

    /**
     * Save only the list.json file (session metadata).
     *
     * Appended to {@link writeChain} so concurrent callers (draft flush,
     * new-session creation, background runtime turn-finish, title gen,
     * insight extraction) never race on list.json.  The writer reads
     * `_activeSessionId` and `metadataMap` right before performing I/O,
     * after any preceding chain entry has completed, so state changes
     * made by an earlier writer are always visible.
     */
    async saveMetadata(): Promise<void> {
        await this.ensureCacheReady();
        await this.enqueueWrite(() => this.saveListFile());
    }

    /**
     * Block persistence until {@link loadFromCache} has finished successfully.
     * While the cache is not ready there is no active session to write.
     */
    private async ensureCacheReady(): Promise<void> {
        if (this.cacheLoaded) return;
        if (this._loadPromise) await this._loadPromise;
    }

    /** Strip per-session fields that live in their own files, not in list.json. */
    private stripPerSessionFields(sessions: SessionMetadata[]): SessionMetadata[] {
        return sessions.map(({ lastInsights: _, lastSuggestions: __, draftInput: ___, ...rest }) => rest as SessionMetadata);
    }

    /** Build the path for the per-session messages file (JSONL format). */
    private getMessagesFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/messages.jsonl`;
    }

    /** Build the path for the legacy flat messages file (pre-migration format). */
    private getOldMessagesFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}.json`;
    }

    /** Build the path for the per-session directory. */
    private getSessionDirPath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}`;
    }

    /** Build the path for the per-session insights file. */
    private getInsightsFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/insights.json`;
    }

    /** Build the path for the per-session suggestions file. */
    private getSuggestionsFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/suggestions.json`;
    }

    /** Build the path for the per-session todos file. */
    private getTodosFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/todos.json`;
    }

    /** Build the path for the per-session agent-token-breakdown file. */
    private getAgentTokenBreakdownFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/agent-token-breakdown.json`;
    }

    /** Build the path for the per-session summaries file. */
    private getSummariesFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/summaries.json`;
    }

    /** Build the path for the per-session quick-ask-turns file. */
    private getQuickAskTurnsFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/quick-ask-turns.json`;
    }

    /** Build the path for the per-session tool-call-assets file. */
    private getToolCallAssetsFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/tool-call-assets.json`;
    }

    /** Build the path for the per-session subagent messages directory. */
    private getSubAgentMessagesDirPath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/subagent`;
    }

    /** Build the path for a single sub-agent message file. */
    private getSubAgentMessageFilePath(sessionId: string, toolCallId: string): string {
        return `${this.sessionsDir}/${sessionId}/subagent/${toolCallId}.json`;
    }

    /**
     * Persist (or delete) the per-session insights.json file for a given session.
     * Called automatically by {@link setSessionLastInsights}.
     */
    private async savePerSessionInsights(sessionId: string, state: InsightCardState | undefined): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getInsightsFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (state) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify(state, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save insights file:', error);
        }
    }

    /**
     * Persist (or delete) the per-session suggestions.json file for a given session.
     * Called automatically by {@link setSessionLastSuggestions}.
     */
    private async savePerSessionSuggestions(sessionId: string, state: SuggestionCardState | undefined): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getSuggestionsFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (state) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify(state, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save suggestions file:', error);
        }
    }

    /**
     * Persist (or delete) the per-session todos.json file for a given session.
     * Called automatically by {@link setSessionTodos}.
     */
    private async savePerSessionTodos(sessionId: string, state: TodoState | undefined): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getTodosFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (state && state.items.length > 0) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify(state, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save todos file:', error);
        }
    }

    /**
     * Persist (or delete) the per-session agent-token-breakdown.json file
     * for a given session. Called automatically when the cache is mutated
     * in {@link saveSession}.
     */
    private async savePerSessionAgentTokenBreakdown(sessionId: string, state: AgentTokenBreakdown | undefined): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getAgentTokenBreakdownFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (state) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify(state, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save agent-token-breakdown file:', error);
        }
    }

    /**
     * Persist sub-agent messages to individual files under
     * `sessions/{id}/subagent/{toolCallId}.json`.
     *
     * Deletes the entire subagent directory when `messages` is
     * `undefined` or empty, and cleans up orphaned files when
     * switching from one set of tool-call IDs to another.
     */
    private async savePerSessionSubAgentMessages(
        sessionId: string,
        messages: Record<string, ChatMessage[]> | undefined,
    ): Promise<void> {
        const adapter = this.app.vault.adapter;
        const dirPath = this.getSubAgentMessagesDirPath(sessionId);
        const sessionDir = this.getSessionDirPath(sessionId);

        try {
            if (!messages || Object.keys(messages).length === 0) {
                // Clear everything
                if (await adapter.exists(dirPath)) {
                    try { await adapter.rmdir(dirPath, true); } catch { /* best-effort */ }
                }
                return;
            }

            // Ensure directories exist
            if (!await adapter.exists(sessionDir)) {
                await adapter.mkdir(sessionDir);
            }
            if (!await adapter.exists(dirPath)) {
                await adapter.mkdir(dirPath);
            }

            // Write current toolCallId files
            const writtenIds = new Set<string>();
            for (const [toolCallId, msgs] of Object.entries(messages)) {
                const filePath = this.getSubAgentMessageFilePath(sessionId, toolCallId);
                await adapter.write(filePath, JSON.stringify(msgs, null, 2));
                writtenIds.add(toolCallId);
            }

            // Clean up orphaned files from previous writes
            try {
                const listing = await adapter.list(dirPath);
                for (const file of listing.files) {
                    const toolCallId = file.replace(/\.json$/, '');
                    if (!writtenIds.has(toolCallId)) {
                        await adapter.remove(`${dirPath}/${file}`);
                    }
                }
            } catch { /* best-effort cleanup */ }
        } catch (error) {
            console.warn('[SessionManager] Failed to save sub-agent messages:', error);
        }
    }

    /**
     * Persist (or delete) the per-session summaries.json file for a given session.
     */
    private async savePerSessionSummaries(sessionId: string, state: ConversationSummary[] | undefined): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getSummariesFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (state && state.length > 0) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify(state, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save summaries file:', error);
        }
    }

    /**
     * Persist (or delete) the per-session quick-ask-turns.json file for a given session.
     */
    private async savePerSessionQuickAskTurns(sessionId: string, state: QuickAskTurn[] | undefined): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getQuickAskTurnsFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (state && state.length > 0) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify(state, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save quick-ask-turns file:', error);
        }
    }

    /**
     * Persist (or delete) the per-session tool-call-assets.json file for a given session.
     */
    private async savePerSessionToolCallAssets(sessionId: string, state: GeneratedAsset[] | undefined): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getToolCallAssetsFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (state && state.length > 0) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify(state, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save tool-call-assets file:', error);
        }
    }

    /** Build the path for the per-session user-input file. */
    private getUserInputFilePath(sessionId: string): string {
        return `${this.sessionsDir}/${sessionId}/user-input.json`;
    }

    /**
     * Persist (or delete) the per-session user-input.json file.
     * Called automatically by {@link setDraftInput}.
     */
    private async savePerSessionUserInput(sessionId: string, draft: string): Promise<void> {
        const adapter = this.app.vault.adapter;
        const filePath = this.getUserInputFilePath(sessionId);
        const dirPath = this.getSessionDirPath(sessionId);

        try {
            if (draft) {
                if (!await adapter.exists(dirPath)) {
                    await adapter.mkdir(dirPath);
                }
                await adapter.write(filePath, JSON.stringify({ draft }, null, 2));
            } else {
                if (await adapter.exists(filePath)) {
                    await adapter.remove(filePath);
                }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save user-input file:', error);
        }
    }

    /**
     * Try to load per-session files (insights, suggestions, user-input,
     * todos, agent-token-breakdown, sub-agent messages) for a given
     * session and populate the corresponding metadata fields / caches.
     * Best-effort: silently ignores missing or corrupt files.
     */
    private async loadPerSessionFiles(sessionId: string): Promise<void> {
        const meta = this.metadataMap.get(sessionId);
        if (!meta) return;

        const adapter = this.app.vault.adapter;

        // Load insights
        try {
            const insightsPath = this.getInsightsFilePath(sessionId);
            if (await adapter.exists(insightsPath)) {
                const content = await adapter.read(insightsPath);
                const state = JSON.parse(content) as InsightCardState;
                if (state && state.phase !== 'loading') {
                    meta.lastInsights = state;
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load suggestions
        try {
            const suggestionsPath = this.getSuggestionsFilePath(sessionId);
            if (await adapter.exists(suggestionsPath)) {
                const content = await adapter.read(suggestionsPath);
                const state = JSON.parse(content) as SuggestionCardState;
                if (state && state.phase !== 'loading') {
                    meta.lastSuggestions = state;
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load draft input
        try {
            const userInputPath = this.getUserInputFilePath(sessionId);
            if (await adapter.exists(userInputPath)) {
                const content = await adapter.read(userInputPath);
                const data = JSON.parse(content) as { draft?: string };
                if (data && typeof data.draft === 'string') {
                    meta.draftInput = data.draft;
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load todos
        try {
            const todosPath = this.getTodosFilePath(sessionId);
            if (await adapter.exists(todosPath)) {
                const content = await adapter.read(todosPath);
                const data = JSON.parse(content) as TodoState;
                if (data
                    && typeof data === 'object'
                    && Array.isArray(data.items)
                    && data.items.length > 0) {
                    this.todosCache.set(sessionId, {
                        items: data.items.map((item: TodoItem) => ({
                            id: String(item.id ?? ''),
                            brief: typeof item.brief === 'string' ? item.brief : '',
                            content: typeof item.content === 'string' ? item.content : '',
                            status: item.status ?? 'pending',
                            createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
                            updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
                        })),
                        updatedAt: typeof data.updatedAt === 'number'
                            ? data.updatedAt
                            : Date.now(),
                    });
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load agent token breakdown
        try {
            const breakdownPath = this.getAgentTokenBreakdownFilePath(sessionId);
            if (await adapter.exists(breakdownPath)) {
                const content = await adapter.read(breakdownPath);
                const data = JSON.parse(content) as AgentTokenBreakdown;
                if (data
                    && typeof data === 'object'
                    && data.main && data.subAgents) {
                    this.agentTokenBreakdownCache.set(sessionId, data);
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load summaries
        try {
            const summariesPath = this.getSummariesFilePath(sessionId);
            if (await adapter.exists(summariesPath)) {
                const content = await adapter.read(summariesPath);
                const data = JSON.parse(content) as ConversationSummary[];
                if (Array.isArray(data) && data.length > 0) {
                    this.summariesCache.set(sessionId, data);
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load quick-ask-turns
        try {
            const qaPath = this.getQuickAskTurnsFilePath(sessionId);
            if (await adapter.exists(qaPath)) {
                const content = await adapter.read(qaPath);
                const data = JSON.parse(content) as QuickAskTurn[];
                if (Array.isArray(data) && data.length > 0) {
                    this.quickAskTurnsCache.set(sessionId, data);
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load tool-call-assets
        try {
            const assetsPath = this.getToolCallAssetsFilePath(sessionId);
            if (await adapter.exists(assetsPath)) {
                const content = await adapter.read(assetsPath);
                const data = JSON.parse(content) as GeneratedAsset[];
                if (Array.isArray(data) && data.length > 0) {
                    this.toolCallAssetsCache.set(sessionId, data);
                }
            }
        } catch {
            // File absent or corrupt — silently ignore.
        }

        // Load sub-agent messages from individual files
        try {
            const subDir = this.getSubAgentMessagesDirPath(sessionId);
            if (await adapter.exists(subDir)) {
                const listing = await adapter.list(subDir);
                const messages: Record<string, ChatMessage[]> = {};
                for (const file of listing.files) {
                    if (!file.endsWith('.json')) continue;
                    const toolCallId = file.replace(/\.json$/, '');
                    try {
                        const content = await adapter.read(`${subDir}/${file}`);
                        const msgs = JSON.parse(content) as ChatMessage[];
                        if (Array.isArray(msgs) && msgs.length > 0) {
                            messages[toolCallId] = msgs;
                        }
                    } catch { /* skip corrupt files */ }
                }
                if (Object.keys(messages).length > 0) {
                    this.subAgentMessagesCache.set(sessionId, messages);
                }
            }
        } catch {
            // Directory absent or listing failed — silently ignore.
        }
    }

    /**
     * Persist the active session ID to `sessions/active.json`.
     *
     * Goes through {@link writeChain} so concurrent `mkdir`/`write` calls
     * (from `saveListFile`, `_doSaveToCache`, etc.) are serialized.  The
     * work lambda reads `_activeSessionId` at execution time, after every
     * preceding chain entry has completed.
     */
    private saveActiveFile(): Promise<void> {
        return this.enqueueWrite(async () => {
            try {
                const adapter = this.app.vault.adapter;
                if (!await adapter.exists(this.sessionsDir)) {
                    await adapter.mkdir(this.sessionsDir);
                }
                await adapter.write(this.activeFilePath, JSON.stringify({ activeSessionId: this._activeSessionId }, null, 2));
            } catch (error) {
                console.warn('[SessionManager] Failed to save active file:', error);
            }
        });
    }

    /** Save only the list.json file (session metadata) */
    private async saveListFile(): Promise<void> {
        if (!this._activeSessionId) return;

        try {
            const adapter = this.app.vault.adapter;

            // Ensure sessions directory exists
            if (!await adapter.exists(this.sessionsDir)) {
                await adapter.mkdir(this.sessionsDir);
            }

            const listData: SessionListFile = {
                version: 1,
                nextId: this._nextId,
                sessions: this.stripPerSessionFields(Array.from(this.metadataMap.values())),
            };

            await adapter.write(this.listFilePath, JSON.stringify(listData, null, 2));
        } catch (error) {
            console.warn('[SessionManager] Failed to save list file:', error);
        }
    }

    /** Load messages for a specific session (lazy load, JSONL format). */
    private async loadMessages(id: string): Promise<void> {
        if (!id) return;

        if (this.loadedMessages.has(id)) return;

        const meta = this.metadataMap.get(id);
        if (!meta) return;

        try {
            const adapter = this.app.vault.adapter;
            const jsonlPath = this.getMessagesFilePath(id);
            const jsonPath = `${this.sessionsDir}/${id}/messages.json`;
            const oldPath = this.getOldMessagesFilePath(id);

            const jsonlExists = await adapter.exists(jsonlPath);
            const jsonExists = await adapter.exists(jsonPath);
            const oldExists = await adapter.exists(oldPath);

            if (jsonlExists) {
                // JSONL format — parse line by line
                const content = await adapter.read(jsonlPath);
                const messages = content
                    .trim()
                    .split('\n')
                    .filter(line => line.length > 0)
                    .map(line => JSON.parse(line) as ChatMessage);
                this.messagesCache.set(id, messages);
                this.persistedMessageCounts.set(id, messages.length);

                // Clean up legacy files
                if (jsonExists) try { await adapter.remove(jsonPath); } catch { /* best-effort */ }
                if (oldExists) try { await adapter.remove(oldPath); } catch { /* best-effort */ }
            } else if (jsonExists) {
                // Old directory-based JSON format — migrate to JSONL
                const content = await adapter.read(jsonPath);
                const raw = JSON.parse(content) as { version: number; id: string } & Record<string, unknown>;

                if (raw.version >= 1 && raw.version <= 4) {
                    console.warn(`[SessionManager] Session ${id} has deprecated cache version ${raw.version}, purging`);
                    await adapter.remove(jsonPath);
                    this.metadataMap.delete(id);
                    this.messagesCache.set(id, []);
                } else if ((raw.version === 5 || raw.version === 6 || raw.version === 7) && raw.id === id) {
                    const data = raw as unknown as SessionMessagesFile;
                    const messages = data.messages;
                    this.messagesCache.set(id, messages);
                    // Migrate legacy inlined fields and convert to JSONL
                    await this._migratePerSessionFields(id, raw);
                    await this._writeJsonl(id, messages);
                    await adapter.remove(jsonPath);
                    this.persistedMessageCounts.set(id, messages.length);
                } else {
                    console.warn('[SessionManager] Invalid messages file format:', id);
                    this.messagesCache.set(id, []);
                }
                if (oldExists) try { await adapter.remove(oldPath); } catch { /* best-effort */ }
            } else if (oldExists) {
                // Old flat-file format — migrate to JSONL
                const content = await adapter.read(oldPath);
                const raw = JSON.parse(content) as { version: number; id: string } & Record<string, unknown>;

                if (raw.version >= 1 && raw.version <= 4) {
                    console.warn(`[SessionManager] Session ${id} has deprecated cache version ${raw.version}, purging`);
                    await adapter.remove(oldPath);
                    this.metadataMap.delete(id);
                    this.messagesCache.set(id, []);
                } else if ((raw.version === 5 || raw.version === 6 || raw.version === 7) && raw.id === id) {
                    const data = raw as unknown as SessionMessagesFile;
                    const messages = data.messages;
                    this.messagesCache.set(id, messages);
                    await this._migratePerSessionFields(id, raw);
                    await this._writeJsonl(id, messages);
                    await adapter.remove(oldPath);
                    this.persistedMessageCounts.set(id, messages.length);
                } else {
                    console.warn('[SessionManager] Invalid messages file format:', id);
                    this.messagesCache.set(id, []);
                }
            } else {
                // No file exists — fresh session
                this.messagesCache.set(id, []);
            }

            this.loadedMessages.add(id);
            await this.loadPerSessionFiles(id);
        } catch (error) {
            console.warn('[SessionManager] Failed to load messages:', error);
            this.messagesCache.set(id, []);
            this.loadedMessages.add(id);
            await this.loadPerSessionFiles(id);
        }
    }

    /**
     * Write messages to a JSONL file (full rewrite — used for migration
     * and for branch/clear scenarios).
     */
    private async _writeJsonl(id: string, messages: ChatMessage[]): Promise<void> {
        const adapter = this.app.vault.adapter;
        const jsonlPath = this.getMessagesFilePath(id);
        const sessionDir = this.getSessionDirPath(id);
        if (!await adapter.exists(sessionDir)) {
            await adapter.mkdir(sessionDir);
        }
        const lines = messages.map(m => JSON.stringify(m));
        await adapter.write(jsonlPath, lines.join('\n') + '\n');
        this.persistedMessageCounts.set(id, messages.length);
    }

    /**
     * Migrate legacy inlined fields (todos, agentTokenBreakdown,
     * subAgentMessages) from the old messages.json format to their
     * own per-session files.
     *
     * Called during `loadMessages()` on every v5+ file so that
     * existing data is split out transparently.  Populates in-memory
     * caches AND persists the new files before returning — this
     * guarantees that `loadPerSessionFiles()` (which reads from the
     * new paths) sees the migrated data on first load.
     */
    private async _migratePerSessionFields(
        id: string,
        raw: Record<string, unknown>,
    ): Promise<void> {
        // --- todos ---
        try {
            const rawTodos = raw.todos;
            if (rawTodos
                && typeof rawTodos === 'object'
                && Array.isArray((rawTodos as Record<string, unknown>).items)
                && ((rawTodos as Record<string, unknown>).items as unknown[]).length > 0) {
                const todos = rawTodos as TodoState;
                // Defensive clone + normalize
                const normalized: TodoState = {
                    items: todos.items.map((item: TodoItem) => ({
                        id: String(item.id ?? ''),
                        brief: typeof item.brief === 'string' ? item.brief : '',
                        content: typeof item.content === 'string' ? item.content : '',
                        status: item.status ?? 'pending',
                        createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
                        updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
                    })),
                    updatedAt: typeof todos.updatedAt === 'number' ? todos.updatedAt : Date.now(),
                };
                // Populate cache + persist before loadPerSessionFiles runs
                this.todosCache.set(id, normalized);
                await this.savePerSessionTodos(id, normalized);
            }
        } catch { /* best-effort migration */ }

        // --- agentTokenBreakdown ---
        try {
            const rawBreakdown = raw.agentTokenBreakdown;
            if (rawBreakdown
                && typeof rawBreakdown === 'object'
                && (rawBreakdown as Record<string, unknown>).main
                && (rawBreakdown as Record<string, unknown>).subAgents) {
                const breakdown = rawBreakdown as AgentTokenBreakdown;
                this.agentTokenBreakdownCache.set(id, breakdown);
                await this.savePerSessionAgentTokenBreakdown(id, breakdown);
            }
        } catch { /* best-effort migration */ }

        // --- summaries ---
        try {
            const rawSummaries = raw.summaries;
            if (rawSummaries
                && Array.isArray(rawSummaries)
                && rawSummaries.length > 0) {
                const summaries = rawSummaries as ConversationSummary[];
                this.summariesCache.set(id, summaries);
                await this.savePerSessionSummaries(id, summaries);
            }
        } catch { /* best-effort migration */ }

        // --- quickAskTurns ---
        try {
            const rawQuickAsk = raw.quickAskTurns;
            if (rawQuickAsk
                && Array.isArray(rawQuickAsk)
                && rawQuickAsk.length > 0) {
                const quickAskTurns = rawQuickAsk as QuickAskTurn[];
                this.quickAskTurnsCache.set(id, quickAskTurns);
                await this.savePerSessionQuickAskTurns(id, quickAskTurns);
            }
        } catch { /* best-effort migration */ }

        // --- toolCallAssets ---
        try {
            const rawAssets = raw.toolCallAssets;
            if (rawAssets
                && Array.isArray(rawAssets)
                && rawAssets.length > 0) {
                const toolCallAssets = rawAssets as GeneratedAsset[];
                this.toolCallAssetsCache.set(id, toolCallAssets);
                await this.savePerSessionToolCallAssets(id, toolCallAssets);
            }
        } catch { /* best-effort migration */ }

        // --- subAgentMessages ---
        try {
            const rawSub = raw.subAgentMessages;
            if (rawSub && typeof rawSub === 'object') {
                const sub = rawSub as Record<string, ChatMessage[]>;
                if (Object.keys(sub).length > 0) {
                    this.subAgentMessagesCache.set(id, sub);
                    await this.savePerSessionSubAgentMessages(id, sub);
                }
            }
        } catch { /* best-effort migration */ }
    }

    /** Save messages for a specific session to file (JSONL append-based). */
    private async saveMessages(id: string): Promise<void> {
        if (!this.loadedMessages.has(id)) return;

        const messages = this.messagesCache.get(id);
        if (messages === undefined) return;

        const persisted = this.persistedMessageCounts.get(id) ?? 0;

        try {
            const adapter = this.app.vault.adapter;
            const jsonlPath = this.getMessagesFilePath(id);
            const sessionDir = this.getSessionDirPath(id);

            // Ensure directory exists
            if (!await adapter.exists(sessionDir)) {
                await adapter.mkdir(sessionDir);
            }

            if (messages.length === 0) {
                // Empty → delete file, reset count
                if (await adapter.exists(jsonlPath)) {
                    await adapter.remove(jsonlPath);
                }
                this.persistedMessageCounts.set(id, 0);
            } else if (messages.length < persisted) {
                // Shrunk (branch, clear) → full rewrite
                const lines = messages.map(m => JSON.stringify(m));
                await adapter.write(jsonlPath, lines.join('\n') + '\n');
                this.persistedMessageCounts.set(id, messages.length);
            } else if (messages.length > persisted) {
                // Grew (normal turn-end) → append new lines
                const newMessages = messages.slice(persisted);
                const newLines = newMessages.map(m => JSON.stringify(m));
                await adapter.append(jsonlPath, newLines.join('\n') + '\n');
                this.persistedMessageCounts.set(id, messages.length);
            }
            // else: same count, nothing to do

            // Clean up legacy formats
            const jsonPath = `${this.sessionsDir}/${id}/messages.json`;
            if (await adapter.exists(jsonPath)) {
                try { await adapter.remove(jsonPath); } catch { /* best-effort */ }
            }
            const oldPath = this.getOldMessagesFilePath(id);
            if (await adapter.exists(oldPath)) {
                try { await adapter.remove(oldPath); } catch { /* best-effort */ }
            }

            // Mirror the message schema version into metadata
            const meta = this.metadataMap.get(id);
            if (meta) {
                meta.messageVersion = 5;
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save messages:', error);
        }
    }

    /** Ensure messages for the active session are loaded */
    async ensureActiveMessagesLoaded(): Promise<void> {
        await this.loadMessages(this._activeSessionId);
    }

    /** Ensure messages for a specific session are loaded */
    async ensureMessagesLoaded(id: string): Promise<void> {
        await this.loadMessages(id);
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    /**
     * Load sessions metadata from list file. Called once at startup.
     * Messages are loaded on demand.
     */
    async loadFromCache(): Promise<void> {
        if (this.cacheLoaded) return;
        // Guard against concurrent calls: await in SessionView.onOpen() may overlap.
        if (this._loadPromise) return this._loadPromise;

        this._loadPromise = this._doLoadFromCache()
            .then(() => {
                this.cacheLoaded = true;
            })
            .catch((error) => {
                console.warn('[SessionManager] Failed to load cache:', error);
                // cacheLoaded stays false so a later call can retry.
            })
            .finally(() => {
                this._loadPromise = null;
            });
        return this._loadPromise;
    }

    private async _doLoadFromCache(): Promise<void> {
        const adapter = this.app.vault.adapter;
        const exists = await adapter.exists(this.listFilePath);

        if (!exists) {
            this.createSession();
            return;
        }

        const content = await adapter.read(this.listFilePath);
        const data = JSON.parse(content) as SessionListFile;

        // Validate cache version
        if (data.version !== 1) {
            console.warn('[SessionManager] Unknown cache version, ignoring cache');
            this.createSession();
            return;
        }

        // Restore session metadata
        this.metadataMap.clear();
        this.messagesCache.clear();
        this.summariesCache.clear();
        this.subAgentMessagesCache.clear();
        this.agentTokenBreakdownCache.clear();
        this.todosCache.clear();
        this.quickAskTurnsCache.clear();
        this.toolCallAssetsCache.clear();
        this.loadedMessages.clear();

        for (const meta of data.sessions) {
            // Migration: ensure firstUserMessage exists for old sessions
            if (meta.firstUserMessage === undefined) {
                meta.firstUserMessage = '';
            }
            this.metadataMap.set(meta.id, meta);
        }

        // Purge sessions with deprecated v1–v4 cache files, so they
        // never appear in the session list. Remove from metadataMap
        // and delete the backing file.
        //
        // For sessions whose metadata already carries the message
        // schema version (written by saveMessages for every write),
        // we skip the expensive file read entirely. Only sessions
        // whose metadata predates this optimisation (missing
        // messageVersion) fall back to reading the full file — and
        // we backfill the version so the next startup is fast.
        let purgedCount = 0;
        let metadataDirty = false;
        for (const [id, meta] of this.metadataMap) {
            const newPath = this.getMessagesFilePath(id);
            const oldPath = this.getOldMessagesFilePath(id);

            // Fast path: version already cached in metadata.
            if (typeof meta.messageVersion === 'number') {
                if (meta.messageVersion >= 1 && meta.messageVersion <= 4) {
                    console.warn(`[SessionManager] Purging deprecated v${meta.messageVersion} session: ${id}`);
                    if (await adapter.exists(newPath)) {
                        await adapter.remove(newPath);
                    }
                    if (await adapter.exists(oldPath)) {
                        await adapter.remove(oldPath);
                    }
                    this.metadataMap.delete(id);
                    purgedCount++;
                }
                // v5+ — no action needed.
                continue;
            }

            // Slow path: metadata from an older plugin version lacks
            // messageVersion. Read the file once to discover the real
            // version, then backfill so subsequent startups skip this.
            // Check new path first, then fall back to old path.
            let readPath: string | null = null;
            if (await adapter.exists(newPath)) {
                readPath = newPath;
            } else if (await adapter.exists(oldPath)) {
                readPath = oldPath;
            }

            if (readPath) {
                try {
                    const msgContent = await adapter.read(readPath);
                    const sessionData = JSON.parse(msgContent) as { version: number };
                    // Backfill for future fast startups.
                    meta.messageVersion = sessionData.version;
                    metadataDirty = true;
                    if (sessionData.version >= 1 && sessionData.version <= 4) {
                        console.warn(`[SessionManager] Purging deprecated v${sessionData.version} session: ${id}`);
                        await adapter.remove(readPath);
                        // Also clean up the other path if it exists
                        const otherPath = readPath === newPath ? oldPath : newPath;
                        if (await adapter.exists(otherPath)) {
                            await adapter.remove(otherPath);
                        }
                        this.metadataMap.delete(id);
                        purgedCount++;
                    }
                } catch {
                    // Corrupt file — also purge
                    console.warn(`[SessionManager] Purging corrupt session file: ${id}`);
                    await adapter.remove(readPath);
                    // Also clean up the other path if it exists
                    const otherPath = readPath === newPath ? oldPath : newPath;
                    if (await adapter.exists(otherPath)) {
                        await adapter.remove(otherPath);
                    }
                    this.metadataMap.delete(id);
                    purgedCount++;
                }
            }
        }

        // Restore next ID counter BEFORE any createSession() fallback so
        // a freshly-created session never reuses a previously-issued id.
        if (typeof data.nextId === 'number' && data.nextId > 1) {
            this._nextId = data.nextId;
        }

        // Restore active session ID from active.json.  If the file is
        // absent or the stored ID no longer maps to a surviving session,
        // fall back to the most-recently-updated session (or create a
        // fresh one when the vault has no sessions).
        let candidateId: string | undefined;
        try {
            if (await adapter.exists(this.activeFilePath)) {
                const activeContent = await adapter.read(this.activeFilePath);
                const activeData = JSON.parse(activeContent) as { activeSessionId?: string };
                if (activeData && typeof activeData.activeSessionId === 'string') {
                    candidateId = activeData.activeSessionId;
                }
            }
        } catch (error) {
            // active.json absent or corrupt — fall through.
            console.warn('[SessionManager] Failed to read active file:', error);
        }

        if (candidateId && this.metadataMap.has(candidateId)) {
            this._activeSessionId = candidateId;
        } else if (this.metadataMap.size > 0) {
            // Fallback: pick the most recent surviving session.
            this._activeSessionId = this.getAllSessions()[0]!.id;
        } else {
            this.createSession();
        }

        // If any sessions were purged, persist the updated list so
        // stale entries are cleaned from disk.  Must run AFTER
        // activeSessionId is restored.
        if (purgedCount > 0 || metadataDirty) {
            await this.enqueueWrite(() => this.saveListFile());
        }

        // Pre-load active session messages (this also triggers lazy
        // loading of per-session insights.json / suggestions.json)
        await this.loadMessages(this._activeSessionId);

        // Load global token statistics after sessions are restored (so
        // the fallback can recompute from metadata if the file is absent
        // or corrupt — first-run migration for existing users).
        await this._loadGlobalStatistics();
    }

    /**
     * Load global cumulative token statistics from statistics.json.
     * Falls back to recomputing from all session metadata when the file
     * is absent, has an unknown version, or is corrupt.
     */
    private async _loadGlobalStatistics(): Promise<void> {
        const adapter = this.app.vault.adapter;
        try {
            if (await adapter.exists(this.statisticsFilePath)) {
                const content = await adapter.read(this.statisticsFilePath);
                const stats = JSON.parse(content) as GlobalTokenStatisticsFile;
                if (stats.version === 1
                    && typeof stats.promptTokens === 'number'
                    && typeof stats.completionTokens === 'number'
                    && typeof stats.totalTokens === 'number') {
                    this._globalTokenStats = {
                        promptTokens: stats.promptTokens,
                        completionTokens: stats.completionTokens,
                        totalTokens: stats.totalTokens,
                        cachedPromptTokens:
                            typeof stats.cachedPromptTokens === 'number'
                                ? stats.cachedPromptTokens
                                : 0,
                    };
                    return;
                }
            }
        } catch {
            // File absent or corrupt — fall through to recompute.
        }

        // Fallback: recompute from all session metadata (first-run migration).
        let p = 0, c = 0, t = 0, cp = 0;
        for (const meta of this.metadataMap.values()) {
            p += meta.tokenUsage.promptTokens;
            c += meta.tokenUsage.completionTokens;
            t += meta.tokenUsage.totalTokens;
            cp += meta.tokenUsage.cachedPromptTokens;
        }
        this._globalTokenStats = { promptTokens: p, completionTokens: c, totalTokens: t, cachedPromptTokens: cp };
    }

    /**
     * Save all session metadata to list file and save all loaded messages.
     * Called after each complete conversation round.
     * 
     * Appended to {@link writeChain} so this call is serialised with all
     * other writers (saveMetadata, switchTo, deleteSession).
     */
    async saveToCache(): Promise<void> {
        await this.ensureCacheReady();
        await this.enqueueWrite(() => this._doSaveToCache());
    }

    /**
     * Internal implementation of saveToCache.
     * Should only be called through saveToCache() to ensure proper locking.
     */
    private async _doSaveToCache(): Promise<void> {
        if (!this._activeSessionId) return;

        try {
            const adapter = this.app.vault.adapter;

            // Ensure sessions directory exists
            if (!await adapter.exists(this.sessionsDir)) {
                await adapter.mkdir(this.sessionsDir);
            }

            // Save metadata list (excluding per-session fields stored in their own files)
            const listData: SessionListFile = {
                version: 1,
                nextId: this._nextId,
                sessions: this.stripPerSessionFields(Array.from(this.metadataMap.values())),
            };

            await adapter.write(this.listFilePath, JSON.stringify(listData, null, 2));

            // Save global token statistics
            const statsData: GlobalTokenStatisticsFile = {
                version: 1,
                promptTokens: this._globalTokenStats.promptTokens,
                completionTokens: this._globalTokenStats.completionTokens,
                totalTokens: this._globalTokenStats.totalTokens,
                cachedPromptTokens: this._globalTokenStats.cachedPromptTokens,
            };
            await adapter.write(this.statisticsFilePath, JSON.stringify(statsData, null, 2));

            // Save all loaded messages to individual files
            for (const id of this.loadedMessages) {
                await this.saveMessages(id);
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save cache:', error);
        }
    }
}
