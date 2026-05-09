/**
 * In-memory + on-disk store for AI Edit History tasks.
 *
 * The store owns:
 * - the canonical task list (newest first),
 * - per-task `AbortController`s so the UI can cancel running requests,
 * - a tiny event bus (`change` / `task-updated`) for the view to subscribe to,
 * - throttled JSON persistence to `<plugin-root>/cache/edit-history.json`.
 *
 * Persistence rules (see plan §0):
 * - Only finished states (`applied / cancelled / failed / stale`) are
 *   serialised to disk. Running / pending tasks never touch the file
 *   system, so a crash at most loses a single in-flight request.
 * - On startup, any leftover `running` / `pending` records (from a previous
 *   abrupt shutdown, in case persistence was extended later) are migrated
 *   to `cancelled` so the UI never shows phantom spinners.
 */

import type { App } from "obsidian";
import {
    EDIT_HISTORY_MAX_TASKS,
    EDIT_HISTORY_PREVIEW_LIMIT,
    EditTask,
    EditTaskStatus,
    EnqueueEditTaskInput,
} from "./edit-history-types";

type StoreEvent = "change" | "task-updated";
type ChangeListener = () => void;
type TaskUpdatedListener = (task: EditTask) => void;

/** Throttle window for persistence writes. */
const PERSIST_THROTTLE_MS = 1000;

/** Generate a small, locally-unique task id (good enough for in-vault use). */
function generateTaskId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Truncate a string to at most `limit` chars, preserving leading text. */
function truncatePreview(text: string, limit: number = EDIT_HISTORY_PREVIEW_LIMIT): string {
    if (text.length <= limit) return text;
    return text.slice(0, limit);
}

/** True when a task's status is terminal (won't change further on its own). */
function isTerminal(status: EditTaskStatus): boolean {
    return status === "applied" || status === "cancelled" || status === "failed" || status === "stale";
}

export interface EditHistoryStoreOptions {
    /** Vault-relative path to the JSON file used for persistence. */
    persistPath: string;
}

export class EditHistoryStore {
    /** Tasks ordered newest-first. */
    private _tasks: EditTask[] = [];
    /** Per-task abort controllers; entries removed when the task reaches a terminal state. */
    private readonly _abortControllers = new Map<string, AbortController>();

    private readonly _changeListeners = new Set<ChangeListener>();
    private readonly _taskUpdatedListeners = new Set<TaskUpdatedListener>();

    private _persistTimer: number | null = null;
    private _disposed = false;

    constructor(
        private readonly app: App,
        private readonly options: EditHistoryStoreOptions,
    ) {}

    // ── Lifecycle ────────────────────────────────────────────────────────

    /**
     * Load persisted tasks from disk. Safe to call once at plugin onload.
     *
     * Errors during read or parse are swallowed — the store simply starts
     * empty rather than blocking plugin startup.
     */
    async load(): Promise<void> {
        try {
            const exists = await this.app.vault.adapter.exists(this.options.persistPath);
            if (!exists) return;
            const raw = await this.app.vault.adapter.read(this.options.persistPath);
            const parsed = JSON.parse(raw) as { tasks?: EditTask[] } | null;
            if (!parsed || !Array.isArray(parsed.tasks)) return;

            // Defensive: drop any malformed entries; migrate non-terminal
            // states (shouldn't normally exist on disk) to `cancelled`.
            const now = Date.now();
            const cleaned: EditTask[] = [];
            for (const t of parsed.tasks) {
                if (!t || typeof t !== "object" || typeof t.id !== "string") continue;
                if (!isTerminal(t.status)) {
                    t.status = "cancelled";
                    t.updatedAt = now;
                }
                cleaned.push(t);
            }
            this._tasks = cleaned.slice(0, EDIT_HISTORY_MAX_TASKS);
            this.emit("change");
        } catch {
            // Corrupt or unreadable file — start clean rather than crash.
            this._tasks = [];
        }
    }

    /** Cancel any pending writes and abort still-running tasks. */
    dispose(): void {
        this._disposed = true;
        if (this._persistTimer !== null) {
            window.clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
        for (const ac of this._abortControllers.values()) {
            try { ac.abort(); } catch { /* ignore */ }
        }
        this._abortControllers.clear();
    }

    // ── Read API ─────────────────────────────────────────────────────────

    /** Snapshot of the current task list (caller must not mutate). */
    get tasks(): readonly EditTask[] {
        return this._tasks;
    }

    /** Find a task by id, or `undefined`. */
    get(id: string): EditTask | undefined {
        return this._tasks.find(t => t.id === id);
    }

    // ── Mutation API ─────────────────────────────────────────────────────

    /**
     * Create a new task and push it to the front of the list.
     *
     * The returned `AbortController` is owned by the store and used by both
     * `cancel()` and the runner. The runner should pass `.signal` straight
     * to provider streaming APIs.
     */
    enqueue(input: EnqueueEditTaskInput): { task: EditTask; controller: AbortController } {
        const now = Date.now();
        const previewBefore = truncatePreview(input.originalText);
        const task: EditTask = {
            id: generateTaskId(),
            action: input.action,
            status: "pending",
            filePath: input.filePath,
            fromLine: input.fromLine,
            fromCh: input.fromCh,
            toLine: input.toLine,
            toCh: input.toCh,
            originalText: input.originalText,
            rewrittenText: "",
            previewBefore,
            previewAfter: "",
            createdAt: now,
            updatedAt: now,
            profileName: input.profileName,
            modelName: input.modelName,
            bytes: 0,
        };

        this._tasks.unshift(task);
        // Trim to capacity from the tail (oldest entries).
        if (this._tasks.length > EDIT_HISTORY_MAX_TASKS) {
            this._tasks.length = EDIT_HISTORY_MAX_TASKS;
        }

        const controller = new AbortController();
        this._abortControllers.set(task.id, controller);

        this.emit("change");
        this.schedulePersist();
        return { task, controller };
    }

    /**
     * Apply a partial mutation to a task. Updates `updatedAt`, refreshes
     * the cached `previewAfter` if `rewrittenText` changed, and re-derives
     * `bytes` for progress display. Persistence is scheduled when the
     * resulting status is terminal.
     */
    update(id: string, patch: Partial<EditTask>): EditTask | undefined {
        const idx = this._tasks.findIndex(t => t.id === id);
        if (idx < 0) return undefined;
        const current = this._tasks[idx]!;
        const next: EditTask = { ...current, ...patch, updatedAt: Date.now() };

        if (patch.rewrittenText !== undefined && patch.rewrittenText !== current.rewrittenText) {
            next.previewAfter = truncatePreview(patch.rewrittenText);
            next.bytes = patch.rewrittenText.length;
        }

        this._tasks[idx] = next;

        // Once terminal, the abort controller is no longer useful.
        if (isTerminal(next.status)) {
            this._abortControllers.delete(id);
            this.schedulePersist();
        }

        this.emitTaskUpdated(next);
        return next;
    }

    /**
     * Request cancellation of a running task.
     *
     * The runner observes the abort signal and is responsible for moving
     * the task into the `cancelled` state. We do not flip the status here
     * to avoid races where the runner is in the middle of writing back.
     */
    cancel(id: string): void {
        const ac = this._abortControllers.get(id);
        if (ac) {
            try { ac.abort(); } catch { /* ignore */ }
        }
    }

    /** Cancel every still-running task in one go. */
    cancelAll(): void {
        for (const id of [...this._abortControllers.keys()]) {
            this.cancel(id);
        }
    }

    /** Remove a single task. No-op if it's still running (cancel first). */
    remove(id: string): void {
        const idx = this._tasks.findIndex(t => t.id === id);
        if (idx < 0) return;
        const task = this._tasks[idx]!;
        if (!isTerminal(task.status)) {
            // Refuse to drop a running entry from the list — the runner still
            // holds a reference and would surface a stale update.
            return;
        }
        this._tasks.splice(idx, 1);
        this.emit("change");
        this.schedulePersist();
    }

    /** Remove all terminal tasks (`applied / cancelled / failed / stale`). */
    clearFinished(): void {
        const before = this._tasks.length;
        this._tasks = this._tasks.filter(t => !isTerminal(t.status));
        if (this._tasks.length !== before) {
            this.emit("change");
            this.schedulePersist();
        }
    }

    // ── Events ───────────────────────────────────────────────────────────

    on(event: "change", cb: ChangeListener): () => void;
    on(event: "task-updated", cb: TaskUpdatedListener): () => void;
    on(event: StoreEvent, cb: ChangeListener | TaskUpdatedListener): () => void {
        if (event === "change") {
            this._changeListeners.add(cb as ChangeListener);
            return () => this._changeListeners.delete(cb as ChangeListener);
        }
        this._taskUpdatedListeners.add(cb as TaskUpdatedListener);
        return () => this._taskUpdatedListeners.delete(cb as TaskUpdatedListener);
    }

    private emit(event: "change"): void {
        if (event === "change") {
            for (const cb of this._changeListeners) {
                try { cb(); } catch (e) { console.error("[edit-history] change listener failed", e); }
            }
        }
    }

    private emitTaskUpdated(task: EditTask): void {
        for (const cb of this._taskUpdatedListeners) {
            try { cb(task); } catch (e) { console.error("[edit-history] task-updated listener failed", e); }
        }
    }

    // ── Persistence ──────────────────────────────────────────────────────

    private schedulePersist(): void {
        if (this._disposed) return;
        if (this._persistTimer !== null) return;
        this._persistTimer = window.setTimeout(() => {
            this._persistTimer = null;
            void this.persistNow();
        }, PERSIST_THROTTLE_MS);
    }

    /**
     * Write the terminal-only snapshot to disk. Errors are logged and
     * swallowed — the user's primary content is never on this code path,
     * so a failed write should never surface a notice.
     */
    private async persistNow(): Promise<void> {
        if (this._disposed) return;
        try {
            const payload = {
                version: 1 as const,
                tasks: this._tasks.filter(t => isTerminal(t.status)),
            };
            const dir = this.options.persistPath.replace(/\/[^/]+$/, "");
            if (dir && dir !== this.options.persistPath) {
                if (!(await this.app.vault.adapter.exists(dir))) {
                    await this.app.vault.adapter.mkdir(dir);
                }
            }
            await this.app.vault.adapter.write(
                this.options.persistPath,
                JSON.stringify(payload),
            );
        } catch (e) {
            console.error("[edit-history] failed to persist", e);
        }
    }
}
