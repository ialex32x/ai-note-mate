import type { IChatAgent, ChatMessage } from '../chat-stream';
import type { SessionManager } from '../../session-manager';
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
 *     sessionId — never via `saveCurrentSession`, which would write to
 *     whichever session happens to be active in the view right now.
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

    private readonly sessionManager: SessionManager;

    constructor(sessionId: string, sessionManager: SessionManager) {
        this.sessionId = sessionId;
        this.sessionManager = sessionManager;
        this.lastAttachedAt = Date.now();
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
    }
}
