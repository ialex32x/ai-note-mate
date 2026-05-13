import type NoteAssistantPlugin from 'main';
import { SessionRuntime } from './session-runtime';
import { createSessionRuntime } from './runtime-factory';

export interface SessionRuntimePoolOptions {
    /**
     * Maximum number of IDLE (non-busy) runtimes kept warm in the pool.
     * Busy runtimes are NEVER counted against this cap — that is the
     * whole point of the pool (a long-running background turn must not
     * be evicted just because the user opened a few other sessions).
     *
     * When the idle count would exceed `maxIdle` after a `release()`,
     * the pool evicts the least-recently-attached idle runtime first.
     */
    maxIdle: number;
}

/**
 * Plugin-wide registry of in-memory chat runtimes.
 *
 * Lifecycle invariants:
 *   - Exactly one {@link SessionRuntime} per `sessionId` at any moment.
 *     `get()` returns the live one; `create()` is the only way to
 *     instantiate.
 *   - `release(id)` is called by the view when it switches AWAY from
 *     a session. The pool then decides whether to keep the runtime
 *     warm or evict it (see §3.3 of the background-session-runtime
 *     plan):
 *       - busy: ALWAYS kept (background continuation).
 *       - idle: kept iff doing so does not exceed `maxIdle`.
 *   - `evict(id)` is called by the view on explicit user deletion of
 *     the session. Drops the runtime regardless of busy state.
 *   - `disposeAll()` is called on plugin unload. Aborts every chat.
 *
 * The pool is intentionally synchronous and non-async: callers may
 * need to release+create as part of a single switch step, and
 * mixing in await points would make it easy to introduce TOCTOU
 * bugs around which runtime is "current".
 */
export class SessionRuntimePool {
    private runtimes = new Map<string, SessionRuntime>();
    private readonly maxIdle: number;
    private readonly plugin: NoteAssistantPlugin;

    constructor(plugin: NoteAssistantPlugin, options: SessionRuntimePoolOptions) {
        this.plugin = plugin;
        this.maxIdle = Math.max(1, options.maxIdle | 0);
    }

    /** Lookup an existing runtime; does not create. */
    get(sessionId: string): SessionRuntime | undefined {
        return this.runtimes.get(sessionId);
    }

    has(sessionId: string): boolean {
        return this.runtimes.has(sessionId);
    }

    /**
     * Create a new runtime for `sessionId`. Throws if one already
     * exists — callers must `get()` first and only `create()` on
     * cache miss. This keeps "who owns the chat for this session"
     * unambiguous.
     */
    create(sessionId: string): SessionRuntime {
        if (this.runtimes.has(sessionId)) {
            throw new Error(
                `SessionRuntimePool.create: runtime for ${sessionId} already exists`,
            );
        }
        const runtime = createSessionRuntime(this.plugin, sessionId);
        // Wire the busy→idle compaction notifier so background
        // finishes can reclaim themselves if the pool is over capacity.
        runtime.onIdleNotifier = () => this.compact();
        this.runtimes.set(sessionId, runtime);
        return runtime;
    }

    /**
     * Get-or-create. Convenience for switch flows that don't care
     * whether the target session was already warm.
     */
    getOrCreate(sessionId: string): SessionRuntime {
        return this.runtimes.get(sessionId) ?? this.create(sessionId);
    }

    /**
     * Hand a runtime back to the pool. Called by the view when it
     * detaches from a session (switch / new chat / view close).
     *
     * Decision matrix:
     *   - busy:                always retained (background continuation).
     *   - pending checkpoints: always retained — evicting would
     *     auto-accept the user's unconfirmed file modifications,
     *     surprising them on the next attach.
     *   - idle, idle-count ≤ maxIdle:  retained (warm cache).
     *   - idle, idle-count > maxIdle:  evicted via LRU (the oldest
     *     idle runtime is dropped first, which may or may not be this
     *     one).
     *
     * Note: `release` is conceptually different from `evict`. Release
     * says "the view is done with this session for now"; eviction
     * says "the session itself is gone". The pool decides retention
     * for release; eviction is unconditional.
     */
    release(sessionId: string): void {
        const rt = this.runtimes.get(sessionId);
        if (!rt) return;
        // Busy runtimes are kept regardless of capacity.
        if (rt.isBusy) return;
        // Sessions with pending vault checkpoints are also kept: the
        // checkpoint state is runtime-only, so evicting it implicitly
        // auto-accepts the user's unconfirmed edits. We never want
        // that to happen silently on a session switch.
        if (rt.checkpointStore.hasPending) return;
        // Touch lastAttachedAt would lie about LRU; release means the
        // view JUST detached from this one, so the natural attach
        // timestamp is already up-to-date.
        this.compact();
    }

    /**
     * Forcefully remove a session from the pool, e.g. when the user
     * deletes the session. Aborts the chat if it was running.
     */
    evict(sessionId: string): void {
        const rt = this.runtimes.get(sessionId);
        if (!rt) return;
        this.runtimes.delete(sessionId);
        rt.dispose();
    }

    /**
     * Tear down ALL runtimes. Called from `Plugin.onunload`.
     *
     * For any busy runtime, we kick off a best-effort persistence
     * before aborting so the partial in-flight output isn't silently
     * lost when Obsidian closes mid-turn. The persistence is
     * fire-and-forget — Obsidian doesn't give us an await point to
     * block on during unload, but `SessionManager.saveSession`
     * synchronously updates its in-memory caches, and the subsequent
     * `saveToCache()` call kicks an async file write that usually
     * completes before the process tears down.
     */
    disposeAll(): void {
        const all = Array.from(this.runtimes.values());
        this.runtimes.clear();
        // First pass: snapshot every busy runtime's chat state into
        // the SessionManager's in-memory cache. This is synchronous
        // (persist updates caches inline; the actual disk write is
        // async). Doing this BEFORE abort means the snapshot
        // includes whatever the chat had produced up to that
        // moment, not the post-abort placeholder.
        for (const rt of all) {
            if (rt.isBusy) {
                void rt.persist().catch(() => { /* unload-time, best-effort */ });
            }
        }
        // Kick the file flush. Fire-and-forget — there is no
        // `await` available during onunload.
        void this.plugin.sessionManager.saveToCache().catch(() => { /* swallow */ });
        // Then abort + cleanup.
        for (const rt of all) rt.dispose();
    }

    /** Diagnostic helper — counts for debugging / future UI hints. */
    stats(): { busy: number; idle: number } {
        let busy = 0;
        let idle = 0;
        for (const rt of this.runtimes.values()) {
            if (rt.isBusy) busy++;
            else idle++;
        }
        return { busy, idle };
    }

    /**
     * Reclaim idle slots when capacity is exceeded. Evicts in
     * least-recently-attached order so users navigating between a
     * handful of recent sessions get cache hits while one-off
     * detours get reclaimed first.
     *
     * Called from `release()` after a view detach, and from a
     * runtime's `onIdleNotifier` when a background runtime
     * transitions from busy → idle (because that finish could push
     * the idle count over the cap).
     *
     * Runtimes that hold pending vault checkpoints are NOT counted
     * toward the cap and are NEVER eligible for eviction here —
     * letting LRU silently auto-accept unconfirmed file edits would
     * be a footgun. They effectively pin the runtime alive until
     * the user accepts or discards.
     */
    private compact(): void {
        const idles: SessionRuntime[] = [];
        for (const rt of this.runtimes.values()) {
            if (rt.isBusy) continue;
            if (rt.checkpointStore.hasPending) continue;
            idles.push(rt);
        }
        if (idles.length <= this.maxIdle) return;
        // Sort ascending by lastAttachedAt — oldest first.
        idles.sort((a, b) => a.lastAttachedAt - b.lastAttachedAt);
        const toEvict = idles.length - this.maxIdle;
        for (let i = 0; i < toEvict; i++) {
            const rt = idles[i]!;
            this.runtimes.delete(rt.sessionId);
            rt.dispose();
        }
    }
}
