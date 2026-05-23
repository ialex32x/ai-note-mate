import type { App } from 'obsidian';
import type { ChatMessage, ConversationSummary, AgentTokenBreakdown } from './services/chat-stream';
import type { TokenUsage } from './services/llm-provider';
import type { InsightCardState } from './services/insights';
import type { TodoState } from './services/tools/todo-state';

type ReadonlyChatMessages = ReadonlyArray<ChatMessage>;

/** Session metadata (stored in list.json) */
export interface SessionMetadata {
    id: string;
    /** Session title, empty string means "use firstUserMessage as display title" */
    title: string;
    /** First user message content (truncated for display), stored for quick access without loading full messages */
    firstUserMessage: string;
    tokenUsage: TokenUsage;
    createdAt: number;
    updatedAt: number;
    /** Draft input content (unsent text in input box), restored when loading session */
    draftInput?: string;
    /**
     * Last terminal state of the insight preview card. Persisted by
     * {@link SessionRuntime} after each successful (or failed) insight
     * extraction so that switching away and back to the session — or
     * reloading the plugin entirely — restores the card without
     * re-running the LLM call. Bound to a specific assistant
     * `messageId` so stale states are detectable on replay.
     *
     * `loading` is deliberately not persisted (it's transient).
     */
    lastInsights?: InsightCardState;
}

/** Messages file content (stored in sessions/${id}.json) */
interface SessionMessagesFile {
    /**
     * File schema version.
     * - v1: messages + summaries only
     * - v2: adds `subAgentMessages` (inline sub-agent bubbles for the UI)
     * - v3: adds `agentTokenBreakdown` (per-agent token usage split)
     * - v4: adds `todos` (per-session TODO state maintained by the
     *       `manage_todos` tool; pinned to the top of the chat UI).
     *       Items carried `content` (required) + `displayContent`
     *       (optional, user-facing override).
     * - v5: reshapes each TODO item to carry TWO required strings —
     *       `brief` (short user-facing summary, replaces v4's
     *       `displayContent`) and `content` (long machine-facing task
     *       spec). The loader migrates v4 items in place:
     *         · `displayContent` → `brief` when present,
     *         · `content[:80]` as a synthesized `brief` when neither
     *           was set (so old plans render in the panel without
     *           losing data).
     *       New writes always emit v5 once todos are involved.
     */
    version: 1 | 2 | 3 | 4 | 5;
    id: string;
    messages: ChatMessage[];
    /** Conversation summaries for context compression (persisted separately from messages) */
    summaries?: ConversationSummary[];
    /**
     * Sub-agent messages produced during delegate_task invocations, keyed by
     * the parent delegate_task toolCallId. Used by the UI to re-render inline
     * sub-agent bubbles after a session reload. Optional for backward
     * compatibility with v1 files.
     */
    subAgentMessages?: Record<string, ChatMessage[]>;
    /**
     * Per-agent token usage split (main + each sub-agent by name).
     * Only produced by multi-agent sessions; absent for single-agent
     * (ChatStream) sessions. Optional for backward compatibility with v1/v2.
     */
    agentTokenBreakdown?: AgentTokenBreakdown;
    /**
     * TODO state maintained by the `manage_todos` tool. Persisted so
     * the pinned panel + the model's view of in-progress subtasks
     * survive reloads. Absent / empty list in v1-v3 files is treated
     * as "no todos" by the loader.
     */
    todos?: TodoState;
}

/** List file content (stored in sessions/list.json) */
interface SessionListFile {
    version: 1;
    activeSessionId: string;
    nextId: number;
    sessions: SessionMetadata[];
}

/** Snapshot of a session (full data for backward compatibility with public API) */
export interface SessionSnapshot {
    id: string;
    title: string;
    firstUserMessage: string;
    messages: ChatMessage[];
    tokenUsage: TokenUsage;
    createdAt: number;
    updatedAt: number;
}

/**
 * Session manager with persistent storage and lazy loading.
 * - Metadata is stored in `sessions/list.json`
 * - Messages are stored in `sessions/${id}.json` (loaded on demand)
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
    /** Set of session IDs whose messages have been loaded */
    private loadedMessages: Set<string> = new Set();

    /** Promise lock for saveToCache to prevent concurrent file writes */
    private savePromise: Promise<void> | null = null;

    private _activeSessionId: string;
    private _nextId = 1;
    private readonly app: App;
    private sessionsDir: string;
    private listFilePath: string;
    private cacheLoaded = false;

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
        this._activeSessionId = this.createSession();
    }

    get activeSessionId(): string {
        return this._activeSessionId;
    }

    get sessionCount(): number {
        return this.metadataMap.size;
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
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
            createdAt: now,
            updatedAt: now,
        };
        this.metadataMap.set(id, meta);
        this.messagesCache.set(id, []);
        this.loadedMessages.add(id);
        this._activeSessionId = id;
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

    /** Set the draft input for the active session */
    setDraftInput(draft: string): void {
        const meta = this.metadataMap.get(this._activeSessionId);
        if (meta) {
            meta.draftInput = draft;
        }
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
     * Only mutates in-memory metadata; callers should follow up with
     * {@link saveMetadata} (or rely on the next {@link saveToCache})
     * to flush to disk.
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
    }

    /** Convenience: clear the insight card state for a specific session. */
    clearSessionLastInsights(sessionId: string): void {
        this.setSessionLastInsights(sessionId, undefined);
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
     * Only mutates in-memory caches; the next {@link saveToCache}
     * (or `runtime.persist`) flushes to disk.
     */
    setSessionTodos(sessionId: string, state: TodoState | undefined): void {
        if (!this.metadataMap.has(sessionId)) return;
        if (!state || state.items.length === 0) {
            this.todosCache.delete(sessionId);
            return;
        }
        // Defensive clone so callers can't accidentally mutate the
        // cached snapshot after handing it off.
        this.todosCache.set(sessionId, {
            items: state.items.map(item => ({ ...item })),
            updatedAt: state.updatedAt,
        });
    }

    /** Convenience: clear the TODO state for a specific session. */
    clearSessionTodos(sessionId: string): void {
        this.setSessionTodos(sessionId, undefined);
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
    ): Promise<void> {
        const meta = this.metadataMap.get(sessionId);
        if (!meta) return;

        // Update messages cache
        this.messagesCache.set(sessionId, [...currentMessages]);
        this.loadedMessages.add(sessionId);

        // Update summaries cache
        if (summaries && summaries.length > 0) {
            this.summariesCache.set(sessionId, summaries.map(s => ({ ...s })));
        }

        // Update sub-agent messages cache (undefined means "no change";
        // pass an empty object to explicitly clear)
        if (subAgentMessages !== undefined) {
            if (Object.keys(subAgentMessages).length > 0) {
                this.subAgentMessagesCache.set(sessionId, subAgentMessages);
            } else {
                this.subAgentMessagesCache.delete(sessionId);
            }
        }

        // Update per-agent token usage breakdown cache (undefined means "no
        // change"; the orchestrator's getter always returns an object, and
        // single-agent ChatStream will simply never pass it).
        if (agentTokenBreakdown !== undefined) {
            const hasAny = Object.keys(agentTokenBreakdown.subAgents).length > 0
                || agentTokenBreakdown.main.totalTokens > 0;
            if (hasAny) {
                this.agentTokenBreakdownCache.set(sessionId, {
                    main: { ...agentTokenBreakdown.main },
                    subAgents: Object.fromEntries(
                        Object.entries(agentTokenBreakdown.subAgents).map(([k, v]) => [k, { ...v }]),
                    ),
                });
            } else {
                this.agentTokenBreakdownCache.delete(sessionId);
            }
        }

        // Update TODO state cache (undefined means "no change"; an
        // empty list explicitly clears, mirroring the subAgentMessages
        // convention). Defensive clone so the caller's snapshot stays
        // independent from the cache.
        if (todos !== undefined) {
            this.setSessionTodos(sessionId, todos);
        }

        // Update firstUserMessage if not already set
        if (!meta.firstUserMessage && currentMessages.length > 0) {
            const firstUserMsg = currentMessages.find(m => m.role === 'user');
            if (firstUserMsg) {
                meta.firstUserMessage = firstUserMsg.content.slice(0, 100);
            }
        }

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
            newMeta.draftInput = anchor.content;
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
            // Persist activeSessionId change to list.json
            await this.saveListFile();
            return true;
        }
        return false;
    }

    /**
     * Delete a session by ID. If deleting the active session, auto-switches to another.
     * Removes session from memory, saves list.json, and deletes the messages file.
     * Messages file deletion failure does not affect the result.
     * Returns the new active session ID if the deleted session was active, or null if no switch occurred.
     */
    async deleteSession(id: string): Promise<string | null> {
        if (!this.metadataMap.delete(id)) return null;

        const wasActive = id === this._activeSessionId;
        let newActiveId: string | null = null;

        // Clean up messages cache
        this.messagesCache.delete(id);
        this.loadedMessages.delete(id);
        // Clean up summaries cache
        this.summariesCache.delete(id);
        // Clean up sub-agent messages cache
        this.subAgentMessagesCache.delete(id);
        // Clean up per-agent token usage breakdown cache
        this.agentTokenBreakdownCache.delete(id);
        // Clean up TODO state cache
        this.todosCache.delete(id);

        // If deleted session was active, switch to another session
        if (wasActive) {
            // Get remaining sessions sorted by updatedAt (most recent first)
            const remaining = Array.from(this.metadataMap.values())
                .sort((a, b) => b.updatedAt - a.updatedAt);

            if (remaining.length > 0) {
                // Switch to the most recently updated session
                newActiveId = remaining[0]!.id;
                this._activeSessionId = newActiveId;
            } else {
                // No remaining sessions, create a new empty one
                newActiveId = this.createSession();
            }
        }

        // Save list.json after successful memory deletion
        await this.saveListFile();

        // Delete messages file (failure is non-critical)
        try {
            const adapter = this.app.vault.adapter;
            const msgPath = `${this.sessionsDir}/${id}.json`;
            if (await adapter.exists(msgPath)) {
                await adapter.remove(msgPath);
            }
            // Also clean up the session's artifacts subdirectory (if any).
            const artifactsDir = `${this.sessionsDir}/${id}`;
            if (await adapter.exists(artifactsDir)) {
                // Delete individual files first, then rmdir.
                try {
                    const listing = await adapter.list(artifactsDir);
                    for (const file of listing.files) {
                        await adapter.remove(`${artifactsDir}/${file}`);
                    }
                    for (const folder of listing.folders) {
                        // Recursively clean up nested dirs (paranoid; shouldn't exist).
                        try { await adapter.rmdir(`${artifactsDir}/${folder}`, true); } catch { /* ignore */ }
                    }
                } catch { /* best-effort listing; continue to rmdir anyway */ }
                try { await adapter.rmdir(artifactsDir, false); } catch { /* may have been removed already */ }
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to delete messages file:', error);
        }

        return newActiveId;
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
            await this.deleteSession(sessionId);
            // Check if session was successfully deleted by verifying it's no longer in metadataMap
            if (!this.metadataMap.has(sessionId)) {
                deletedCount++;
            }
        }

        return deletedCount;
    }

    /** Save only the list.json file (session metadata) - public version for draft input saves */
    async saveMetadata(): Promise<void> {
        await this.saveListFile();
    }

    /** Save only the list.json file (session metadata) */
    private async saveListFile(): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;

            // Ensure sessions directory exists
            if (!await adapter.exists(this.sessionsDir)) {
                await adapter.mkdir(this.sessionsDir);
            }

            const listData: SessionListFile = {
                version: 1,
                activeSessionId: this._activeSessionId,
                nextId: this._nextId,
                sessions: Array.from(this.metadataMap.values()),
            };

            await adapter.write(this.listFilePath, JSON.stringify(listData, null, 2));
        } catch (error) {
            console.warn('[SessionManager] Failed to save list file:', error);
        }
    }

    /** Load messages for a specific session (lazy load) */
    private async loadMessages(id: string): Promise<void> {
        if (this.loadedMessages.has(id)) return;

        const meta = this.metadataMap.get(id);
        if (!meta) return;

        try {
            const adapter = this.app.vault.adapter;
            const msgPath = `${this.sessionsDir}/${id}.json`;

            if (await adapter.exists(msgPath)) {
                const content = await adapter.read(msgPath);
                const data = JSON.parse(content) as SessionMessagesFile;

                if ((data.version === 1 || data.version === 2 || data.version === 3 || data.version === 4 || data.version === 5) && data.id === id) {
                    this.messagesCache.set(id, data.messages);
                    // Load summaries if present (for context compression)
                    if (data.summaries && Array.isArray(data.summaries)) {
                        this.summariesCache.set(id, data.summaries);
                    }
                    // Load sub-agent messages (v2+ only)
                    if (data.subAgentMessages && typeof data.subAgentMessages === 'object') {
                        this.subAgentMessagesCache.set(id, data.subAgentMessages);
                    }
                    // Load per-agent token usage breakdown (v3+ only)
                    if (data.agentTokenBreakdown && typeof data.agentTokenBreakdown === 'object'
                        && data.agentTokenBreakdown.main && data.agentTokenBreakdown.subAgents) {
                        this.agentTokenBreakdownCache.set(id, data.agentTokenBreakdown);
                    }
                    // Load TODO state (v4+ only). Validate shape defensively
                    // so a corrupt or partial file can't poison the runtime.
                    //
                    // v4 → v5 in-place migration: v4 items carried `content`
                    // + optional `displayContent` (user-facing). v5 items
                    // carry required `brief` + required `content` with
                    // disjoint audiences. We migrate per-item:
                    //   · `displayContent` ⇒ `brief` (verbatim if present),
                    //   · otherwise synthesize `brief` from `content` by
                    //     truncating to MAX_BRIEF_LEN so the panel always
                    //     has something to render.
                    // The migration is read-only; the upgraded shape only
                    // becomes durable when the runtime next persists.
                    if (data.todos
                        && typeof data.todos === 'object'
                        && Array.isArray(data.todos.items)
                        && data.todos.items.length > 0) {
                        // Must stay in sync with `MAX_TODO_BRIEF_LENGTH` in
                        // todo-toolcall.ts — synthesised brief must satisfy
                        // the same cap the tool would enforce on a fresh write.
                        const MAX_BRIEF_LEN = 80;
                        this.todosCache.set(id, {
                            items: data.todos.items.map((item) => {
                                const legacy = item as Partial<TodoState['items'][number]> & {
                                    displayContent?: unknown;
                                };
                                const content = typeof legacy.content === 'string' ? legacy.content : '';
                                let brief: string;
                                if (typeof legacy.brief === 'string' && legacy.brief.trim()) {
                                    brief = legacy.brief;
                                } else if (typeof legacy.displayContent === 'string' && legacy.displayContent.trim()) {
                                    brief = legacy.displayContent;
                                } else if (content.trim()) {
                                    brief = content.length <= MAX_BRIEF_LEN
                                        ? content
                                        : content.slice(0, MAX_BRIEF_LEN - 1).trimEnd() + '…';
                                } else {
                                    brief = '(untitled)';
                                }
                                return {
                                    id: String(legacy.id ?? ''),
                                    brief,
                                    content,
                                    status: legacy.status ?? 'pending',
                                    createdAt: typeof legacy.createdAt === 'number' ? legacy.createdAt : Date.now(),
                                    updatedAt: typeof legacy.updatedAt === 'number' ? legacy.updatedAt : Date.now(),
                                };
                            }),
                            updatedAt: typeof data.todos.updatedAt === 'number'
                                ? data.todos.updatedAt
                                : Date.now(),
                        });
                    }
                } else {
                    console.warn('[SessionManager] Invalid messages file format:', id);
                    this.messagesCache.set(id, []);
                }
            } else {
                this.messagesCache.set(id, []);
            }

            this.loadedMessages.add(id);
        } catch (error) {
            console.warn('[SessionManager] Failed to load messages:', error);
            this.messagesCache.set(id, []);
            this.loadedMessages.add(id);
        }
    }

    /** Save messages for a specific session to file */
    private async saveMessages(id: string): Promise<void> {
        if (!this.loadedMessages.has(id)) return;

        const messages = this.messagesCache.get(id);
        if (messages === undefined) return;

        try {
            const adapter = this.app.vault.adapter;

            // Ensure sessions directory exists
            if (!await adapter.exists(this.sessionsDir)) {
                await adapter.mkdir(this.sessionsDir);
            }

            // Get summaries for this session (may be empty)
            const summaries = this.summariesCache.get(id);
            // Get sub-agent messages for this session (may be absent)
            const subAgentMessages = this.subAgentMessagesCache.get(id);
            const hasSubAgentData = subAgentMessages && Object.keys(subAgentMessages).length > 0;
            // Get per-agent token usage breakdown for this session (may be absent)
            const agentTokenBreakdown = this.agentTokenBreakdownCache.get(id);
            const hasBreakdownData = !!agentTokenBreakdown
                && (Object.keys(agentTokenBreakdown.subAgents).length > 0
                    || agentTokenBreakdown.main.totalTokens > 0);
            // Get TODO state for this session (may be absent / empty)
            const todos = this.todosCache.get(id);
            const hasTodoData = !!todos && todos.items.length > 0;

            // Pick the minimal schema version that encodes all present
            // fields. Newer fields force the version up so older builds
            // refuse to overwrite a file they don't understand.
            //
            // NOTE: when todos are present we always write v5 (not v4),
            // because the per-item shape changed in v5 (`brief` +
            // `content` instead of v4's `content` + optional
            // `displayContent`). Writing v4 with v5-shaped items would
            // tag the file with the wrong schema and silently confuse
            // any future reader that took the version literally.
            const version: 1 | 2 | 3 | 4 | 5 = hasTodoData
                ? 5
                : hasBreakdownData
                    ? 3
                    : hasSubAgentData
                        ? 2
                        : 1;

            const data: SessionMessagesFile = {
                version,
                id,
                messages,
                summaries: summaries && summaries.length > 0 ? summaries : undefined,
                subAgentMessages: hasSubAgentData ? subAgentMessages : undefined,
                agentTokenBreakdown: hasBreakdownData ? agentTokenBreakdown : undefined,
                todos: hasTodoData ? todos : undefined,
            };

            const msgPath = `${this.sessionsDir}/${id}.json`;
            await adapter.write(msgPath, JSON.stringify(data, null, 2));
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

        try {
            const adapter = this.app.vault.adapter;
            const exists = await adapter.exists(this.listFilePath);

            if (!exists) {
                this.cacheLoaded = true;
                return;
            }

            const content = await adapter.read(this.listFilePath);
            const data = JSON.parse(content) as SessionListFile;

            // Validate cache version
            if (data.version !== 1) {
                console.warn('[SessionManager] Unknown cache version, ignoring cache');
                this.cacheLoaded = true;
                return;
            }

            // Restore session metadata
            this.metadataMap.clear();
            this.messagesCache.clear();
            this.summariesCache.clear();
            this.subAgentMessagesCache.clear();
            this.agentTokenBreakdownCache.clear();
            this.todosCache.clear();
            this.loadedMessages.clear();

            for (const meta of data.sessions) {
                // Migration: ensure firstUserMessage exists for old sessions
                if (meta.firstUserMessage === undefined) {
                    meta.firstUserMessage = '';
                }
                this.metadataMap.set(meta.id, meta);
            }

            // Restore active session ID if valid
            if (data.activeSessionId && this.metadataMap.has(data.activeSessionId)) {
                this._activeSessionId = data.activeSessionId;
                // Pre-load active session messages
                await this.loadMessages(this._activeSessionId);
            }

            // Restore next ID counter
            if (typeof data.nextId === 'number' && data.nextId > 1) {
                this._nextId = data.nextId;
            }

            this.cacheLoaded = true;
        } catch (error) {
            console.warn('[SessionManager] Failed to load cache:', error);
            this.cacheLoaded = true;
        }
    }

    /**
     * Save all session metadata to list file and save all loaded messages.
     * Called after each complete conversation round.
     * 
     * This method is protected against concurrent calls - if a save is already
     * in progress, subsequent calls will wait for it to complete before
     * starting a new save operation.
     */
    async saveToCache(): Promise<void> {
        // If already saving, wait for it to complete
        if (this.savePromise) {
            await this.savePromise;
        }

        // Start a new save operation
        this.savePromise = this._doSaveToCache();
        try {
            await this.savePromise;
        } finally {
            this.savePromise = null;
        }
    }

    /**
     * Internal implementation of saveToCache.
     * Should only be called through saveToCache() to ensure proper locking.
     */
    private async _doSaveToCache(): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;

            // Ensure sessions directory exists
            if (!await adapter.exists(this.sessionsDir)) {
                await adapter.mkdir(this.sessionsDir);
            }

            // Save metadata list
            const listData: SessionListFile = {
                version: 1,
                activeSessionId: this._activeSessionId,
                nextId: this._nextId,
                sessions: Array.from(this.metadataMap.values()),
            };

            await adapter.write(this.listFilePath, JSON.stringify(listData, null, 2));

            // Save all loaded messages to individual files
            for (const id of this.loadedMessages) {
                await this.saveMessages(id);
            }
        } catch (error) {
            console.warn('[SessionManager] Failed to save cache:', error);
        }
    }
}
