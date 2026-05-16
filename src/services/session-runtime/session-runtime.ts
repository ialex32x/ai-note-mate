import type { IChatAgent, ChatMessage } from '../chat-stream';
import type { SessionManager } from '../../session-manager';
import { ArtifactStore, type ArtifactStoreOptions } from '../artifact-store';
import type { InsightCardState } from '../insights';
import type { CheckpointStore } from '../vault';
import type { RuntimeEvent, RuntimeListener } from './runtime-events';

/**
 * In-memory runtime container for a single chat session.
 *
 * A SessionRuntime owns an {@link IChatAgent} instance plus the
 * session-level state that USED to live on the SessionView (busy flag,
 * pending tool-call confirmations, "context has been compressed" flag).
 * It can keep running after the SessionView detaches — which is the
 * whole reason this layer exists: switching to another session no
 * longer forces an `abort()` on the in-flight stream.
 *
 * Lifecycle:
 *   1. `new SessionRuntime(sessionId, sessionManager)` — empty shell.
 *   2. `bindChat(chat)` — install the IChatAgent built by runtime-factory.
 *      Wiring the callbacks is the factory's job; the runtime only owns
 *      the post-processing side (state mutation + event forwarding).
 *   3. `attach(listener)` — view starts observing; returns detach fn.
 *   4. View calls `detach()` (the returned fn) when switching away.
 *      The chat keeps running; events still flow into the runtime's
 *      internal state and queues but are buffered (only confirmation
 *      events have a buffer; bubble updates are reconstructed from
 *      `chat.messages` on next attach).
 *   5. `dispose()` — final teardown when the pool decides to evict.
 *      Calls `chat.abort()`; idempotent.
 *
 * Persistence model:
 *   - On turn finish / abort / error, the runtime persists snapshots
 *     to disk via {@link SessionManager.saveSession} keyed by its OWN
 *     sessionId — never via the active-session shortcut, which would
 *     write to whichever session happens to be active in the view
 *     right now.
 *   - This is the only mechanism that lets a background runtime
 *     correctly accumulate into its own session file after the user
 *     has switched away.
 */
export class SessionRuntime {
    /** Identity. Set at construction; never reassigned. */
    readonly sessionId: string;

    /**
     * The underlying chat agent. Public because the SessionView reads
     * `messages`, `summaries`, `agentTokenBreakdown` etc. directly off
     * it during UI replay. Setter is private — the factory wires it
     * once via {@link bindChat}.
     */
    private _chat?: IChatAgent;

    /**
     * Whether the chat is currently producing output. Mirrors the chat
     * state machine (`state === 'streaming'`) but is updated by event
     * handlers so the SessionView can read it synchronously without
     * touching the IChatAgent.
     */
    private _isBusy = false;

    /**
     * True once context compression has happened at least once in this
     * session. Used by `buildDynamicTools` to decide whether to expose
     * conversation-history retrieval tools. Migrated off SessionView so
     * the dynamic-tool closure can be built once at chat construction
     * and remain accurate even after view detach.
     */
    hasContextCompressed = false;

    /**
     * True once the context reducer's emergency shrink has fired at
     * least once in this session. Drives single-Notice deduplication so
     * a long session that repeatedly trips the safety net only nags the
     * user once rather than spamming on every turn. Resets only on
     * session reload (not preserved across cold starts because it is a
     * UX hint, not state worth persisting).
     */
    hasEmergencyShrunk = false;

    /**
     * Tool-call confirmations awaiting user decision, keyed by the
     * `tool_call` message id that triggered them. Owned by the runtime
     * (not the view) so a background chat can correctly block on user
     * input even while no view is attached — the resolve closure stays
     * pinned here until the view re-attaches and the user clicks
     * Allow / Deny.
     */
    readonly pendingConfirmations = new Map<string, (approved: boolean) => void>();

    /** Active listeners. A Set so multi-leaf attaches work without re-registration. */
    private listeners = new Set<RuntimeListener>();

    /**
     * Monotonic timestamp updated on every attach. Used by the pool's
     * LRU eviction policy to pick the least-recently-viewed idle
     * runtime when capacity is exceeded. Pure runtimes that have never
     * been attached use the construction timestamp (i.e. they are
     * the "oldest" by definition until first attach).
     */
    lastAttachedAt: number;

    /**
     * Notifier registered by the pool. Fired when the runtime
     * transitions from busy → idle so the pool can compact stale
     * background-only entries. Pool sets this in `create()`.
     */
    onIdleNotifier?: () => void;

    /**
     * Live state of the insight preview card for this session. Owned
     * by the runtime so that:
     *   - background extraction (triggered by `onFinish` while no view
     *     is attached) can still drive the state machine and persist
     *     terminal phases into {@link SessionManager} metadata;
     *   - a view re-attaching mid-extraction can read the current
     *     state via {@link getInsightState} and render `loading`
     *     immediately instead of waiting for the next emit;
     *   - cold-loaded runtimes can be hydrated from persisted
     *     metadata via {@link restoreInsightState}.
     *
     * `null` means "no card should be shown".
     */
    private _insightState: InsightCardState | null = null;

    /**
     * Monotonic counter incremented every time an extraction begins
     * (auto or manual) or the state is cleared. Used by the helper in
     * `insight-runner.ts` to drop in-flight LLM callbacks that have
     * been superseded by a newer extraction or by a new turn starting.
     */
    private _insightGen = 0;

    /**
     * Per-session artifact store backing `delegate_task` envelopes
     * and the main agent's `recall_artifact` tool. Owned by the
     * runtime (plan §1.3 "Mounting") rather than by the orchestrator
     * or the plugin so that background sessions and the foreground
     * session never share a store. The store is constructed eagerly
     * with the knobs handed in by {@link createSessionRuntime}, which
     * derives them from plugin settings via
     * {@link deriveArtifactStoreOptions}.
     *
     * Lifetime: born with the runtime, cleared (→ `session_end`
     * tombstones) on {@link dispose} so any in-flight recall during
     * teardown gets a meaningful evicted-reason rather than a bare
     * miss. The reference itself is `readonly` so the chat-factory
     * getter can capture it once and stay correct for the runtime's
     * whole life.
     *
     * Note: settings are read once at runtime construction. Live
     * tuning (changing the cap mid-session) intentionally does not
     * affect existing runtimes; new sessions will pick up the new
     * values. Otherwise we'd need a re-balance protocol that's not
     * justified for a knob users adjust ~once.
     */
    readonly artifactStore: ArtifactStore;

    /**
     * Per-session checkpoint state machine. Holds the runtime-only
     * record of which AI mutations this session has performed, what
     * cross-session locks it owns, and which files are pending
     * user accept / discard. Lifetime is bound to the runtime —
     * disposal silently accepts every pending checkpoint (see
     * {@link dispose}).
     */
    readonly checkpointStore: CheckpointStore;

    private readonly sessionManager: SessionManager;

    constructor(
        sessionId: string,
        sessionManager: SessionManager,
        checkpointStore: CheckpointStore,
        artifactStoreOptions?: ArtifactStoreOptions,
    ) {
        this.sessionId = sessionId;
        this.sessionManager = sessionManager;
        this.checkpointStore = checkpointStore;
        this.lastAttachedAt = Date.now();
        this.artifactStore = new ArtifactStore(artifactStoreOptions);
    }

    /**
     * Install the IChatAgent that the factory built for this runtime.
     * Must be called exactly once before any external code interacts
     * with the runtime; the factory enforces this.
     */
    bindChat(chat: IChatAgent): void {
        if (this._chat) {
            throw new Error('SessionRuntime.bindChat: chat already bound');
        }
        this._chat = chat;
    }

    /**
     * Access the underlying chat agent. Throws if `bindChat` hasn't
     * been called yet — this is a programming error, not a runtime
     * condition, so a hard throw is more useful than a silent
     * `undefined`.
     */
    get chat(): IChatAgent {
        if (!this._chat) {
            throw new Error('SessionRuntime.chat accessed before bindChat()');
        }
        return this._chat;
    }

    /**
     * Whether a turn is currently in flight. Read by SessionView (for
     * the send/stop button), by SessionRuntimePool (for capacity
     * accounting), and by the dropdown to render a "still running"
     * indicator on background sessions.
     */
    get isBusy(): boolean {
        return this._isBusy;
    }

    /**
     * Subscribe to runtime events. Returns a detach function that
     * removes the listener. Calling the returned fn more than once is a
     * no-op (Set.delete tolerates it).
     */
    attach(listener: RuntimeListener): () => void {
        this.listeners.add(listener);
        this.lastAttachedAt = Date.now();
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * True iff at least one listener is currently attached. Used by
     * runtime-internal handlers to decide whether a side-effect needs
     * the view (e.g. follow-up suggestions, insight extraction) or can
     * be deferred until reattach.
     */
    get hasListener(): boolean {
        return this.listeners.size > 0;
    }

    /**
     * Emit an event to all attached listeners. Order: listeners receive
     * events in insertion order. Errors from one listener do not abort
     * delivery to subsequent listeners — but they are surfaced via
     * console.error to avoid swallowing bugs silently.
     */
    emit(event: RuntimeEvent): void {
        // Iterate a snapshot so listeners detaching during dispatch
        // don't perturb the iteration.
        const snapshot = Array.from(this.listeners);
        for (const listener of snapshot) {
            try {
                listener(event);
            } catch (err) {
                console.error('[SessionRuntime] listener threw:', err);
            }
        }
    }

    /**
     * Mark the chat as having started a turn. Called by the factory's
     * onStart hook before forwarding the event.
     */
    markBusy(): void {
        this._isBusy = true;
    }

    /**
     * Mark the chat as idle. Triggers the pool's compaction notifier so
     * stale background-only idle entries can be reclaimed.
     */
    markIdle(): void {
        if (!this._isBusy) return;
        this._isBusy = false;
        // Fire-and-forget; the pool's compact is synchronous.
        try {
            this.onIdleNotifier?.();
        } catch (err) {
            console.error('[SessionRuntime] onIdleNotifier threw:', err);
        }
    }

    /**
     * Record a pending tool confirmation. The chat-side onConfirmToolCall
     * builds a promise; this stores its `resolve` so the view's
     * Allow/Deny UI can settle it later. Whether or not a listener is
     * currently attached, the resolve closure stays pinned here until
     * the user makes a decision, so background chat that triggers a
     * confirmation cleanly blocks instead of falsely auto-approving.
     */
    enqueueConfirmation(messageId: string, resolve: (approved: boolean) => void): void {
        this.pendingConfirmations.set(messageId, resolve);
        this.emit({ type: 'confirm-tool-call', messageId });
    }

    /**
     * Resolve a previously-queued tool confirmation. Returns true if a
     * matching entry was found and resolved, false otherwise.
     */
    resolveConfirmation(messageId: string, approved: boolean): boolean {
        const resolve = this.pendingConfirmations.get(messageId);
        if (!resolve) return false;
        this.pendingConfirmations.delete(messageId);
        resolve(approved);
        return true;
    }

    /**
     * Persist this runtime's chat state to disk via SessionManager.
     * Called from the post-turn hooks below (finish / abort) so the
     * write target is always THIS session, never whichever session the
     * view is showing right now.
     */
    async persist(): Promise<void> {
        if (!this._chat) return;
        const chat = this._chat;

        // Snapshot sub-agent inline messages (if supported) for persistence.
        // Freeze streaming flag to false so reloads don't resurrect transient
        // streaming state.
        let subAgentMessagesObj: Record<string, ChatMessage[]> | undefined;
        if (typeof chat.getAllSubAgentMessages === 'function') {
            const map = chat.getAllSubAgentMessages();
            if (map.size > 0) {
                subAgentMessagesObj = {};
                for (const [parentId, msgs] of map.entries()) {
                    subAgentMessagesObj[parentId] = msgs.map(m => ({ ...m, streaming: false }));
                }
            }
        }

        await this.sessionManager.saveSession(
            this.sessionId,
            chat.messages,
            chat.sessionTokenUsage,
            chat.summaries,
            subAgentMessagesObj,
            chat.agentTokenBreakdown,
        );
    }

    // ── Insight card state ────────────────────────────────────────────

    /**
     * Read the current insight card state. Returns the in-memory copy
     * the runtime keeps in sync with persisted metadata.
     *
     * Views call this on attach so they can render the latest known
     * state without waiting for the next `insight-update` emit (which
     * would never come for an already-terminal extraction).
     */
    getInsightState(): InsightCardState | null {
        return this._insightState;
    }

    /**
     * Begin a new extraction for the given assistant message id. Bumps
     * the generation counter and switches the in-memory state to
     * `loading`. Returns the generation id the caller must hand to
     * {@link commitInsightResult} so stale callbacks can be dropped.
     *
     * The `loading` phase is emitted but deliberately NOT persisted —
     * it's a transient runtime-only state.
     */
    beginInsightExtraction(messageId: string, cause: 'auto' | 'manual'): number {
        this._insightGen++;
        this._insightState = { messageId, phase: 'loading', insights: [], cause };
        this.emit({ type: 'insight-update', state: this._insightState });
        return this._insightGen;
    }

    /**
     * Commit the result of a previously-begun extraction. The `gen`
     * argument is the value returned by {@link beginInsightExtraction};
     * if a newer extraction or a state-clear has happened in the
     * meantime, this call is a no-op (the in-flight LLM result is
     * stale and gets dropped).
     *
     * On success the terminal state is written to in-memory metadata
     * via {@link SessionManager.setSessionLastInsights}; callers are
     * responsible for flushing to disk afterwards.
     */
    commitInsightResult(gen: number, state: InsightCardState | null): void {
        if (gen !== this._insightGen) return;
        this._insightState = state;
        if (state) {
            this.sessionManager.setSessionLastInsights(this.sessionId, state);
        } else {
            this.sessionManager.clearSessionLastInsights(this.sessionId);
        }
        this.emit({ type: 'insight-update', state });
    }

    /**
     * Clear both the in-memory state and the persisted metadata.
     * Bumps the generation counter so any in-flight extraction
     * becomes stale. Emits an `insight-update` with `null` state so
     * attached views drop their card. Idempotent — no-op when the
     * state is already `null` (no spurious emits).
     */
    clearInsightState(): void {
        if (this._insightState === null) return;
        this._insightGen++;
        this._insightState = null;
        this.sessionManager.clearSessionLastInsights(this.sessionId);
        this.emit({ type: 'insight-update', state: null });
    }

    /**
     * Initialise the in-memory state from persisted metadata. Used by
     * SessionView's `hydrateRuntimeFromDisk` when binding a fresh
     * runtime that hasn't yet been attached / has no extraction
     * history of its own. Bumps the generation counter so any
     * (impossible-but-defensive) leftover in-flight gen captured at
     * the wrong instant cannot pollute the restored state.
     *
     * Does not emit — the caller (the view's replay pass) is expected
     * to read via {@link getInsightState} and render directly.
     */
    restoreInsightState(state: InsightCardState): void {
        this._insightGen++;
        this._insightState = state;
    }

    /**
     * Tear down the runtime: abort the in-flight chat (idempotent at
     * the chat layer), clear listeners and pending confirmations.
     * After dispose the runtime is unusable; the pool should drop its
     * reference.
     */
    dispose(): void {
        try {
            this._chat?.abort();
        } catch (err) {
            console.warn('[SessionRuntime] abort during dispose threw:', err);
        }
        // Reject any pending confirmations to unblock background promises
        // (would otherwise leak forever if the runtime was disposed mid-confirm).
        for (const resolve of this.pendingConfirmations.values()) {
            try { resolve(false); } catch { /* ignore */ }
        }
        this.pendingConfirmations.clear();
        this.listeners.clear();
        this._isBusy = false;
        // Auto-accept every pending checkpoint so cross-session locks
        // don't leak past the runtime that owned them. On-disk
        // mutations stay as-is — the user implicitly chose to commit
        // them by deleting the session / closing the plugin.
        // Fire-and-forget: dispose() is synchronous (it's called from
        // SessionRuntimePool's evict / disposeAll, which onunload also
        // hits), and snapshot deletion is best-effort cleanup.
        void this.checkpointStore.acceptAllPending().catch(err => {
            console.warn('[SessionRuntime] checkpoint auto-accept on dispose failed:', err);
        });
        // Convert remaining live artifacts to `session_end` tombstones so
        // any racing `recall_artifact` resolves to a clear evicted reason
        // rather than a confusing pure miss. The whole runtime is about
        // to be GC'd anyway, but the cost is constant in liveCount and
        // worth the diagnostic clarity (plan §1.3 last bullet).
        try {
            this.artifactStore.clear();
        } catch (err) {
            console.warn('[SessionRuntime] artifactStore.clear during dispose threw:', err);
        }
    }
}
