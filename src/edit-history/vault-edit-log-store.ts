/**
 * In-memory aggregator + writer-owner for the AI file-changes log.
 *
 * The store owns:
 * - a bounded list of {@link VaultEditLogEntry} records (newest first),
 * - a tiny event bus (`change`) for the view to subscribe to,
 * - the {@link EditLogWriter} registry (one per session).
 *
 * Each session's vault mutations are persisted via its own
 * {@link EditLogWriter} instance — obtained through {@link getWriter} —
 * into `sessions/{sessionId}/edit-log.jsonl`.  The store aggregates
 * per-session files on startup and stays in sync via {@link addEntry}.
 *
 * Because the store owns every writer, {@link clear} can drain all
 * pending writes, delete every file, and reset the writer registry in
 * one controlled pass — no race between independent writers and a
 * separate file sweep.
 *
 * Design notes:
 * - Capacity is bounded by {@link VAULT_EDIT_LOG_MAX_ENTRIES}; we trim
 *   from the oldest tail on every `addEntry()` so memory stays O(cap).
 * - Entries are metadata-only (no content).
 */

import type { App } from "obsidian";
import {
    EDIT_LOG_FILENAME,
    VAULT_EDIT_LOG_MAX_ENTRIES,
    VaultEditLogEntry,
} from "./vault-edit-log-types";
import { EditLogWriter } from "./edit-log-writer";

type ChangeListener = () => void;

export interface VaultEditLogStoreOptions {
    /** Vault-relative path to the sessions directory (e.g. `"<plugin>/sessions"`). */
    sessionsDir: string;
    /**
     * Vault-relative path to the legacy centralised edit-log file
     * (`cache/vault-edit-log.json`).  If present on `load()`, it is
     * deleted — per-session JSONL files have replaced the old
     * single-file format.
     *
     * This is a one-shot migration helper; the field can be removed
     * in a future version once every user has migrated.
     */
    legacyPersistPath: string;
}

export class VaultEditLogStore {
    /** Entries ordered newest-first. */
    private _entries: VaultEditLogEntry[] = [];
    private readonly _changeListeners = new Set<ChangeListener>();

    private _loaded = false;
    /** In-flight load promise so concurrent calls do not race. */
    private _loadPromise: Promise<void> | null = null;

    /** Per-session write chain registry. */
    private readonly _writers = new Map<string, EditLogWriter>();

    constructor(
        private readonly app: App,
        private readonly options: VaultEditLogStoreOptions,
    ) {}

    // ── Lifecycle ────────────────────────────────────────────────────────

    /** Dispose every writer.  Safe to call multiple times. */
    dispose(): void {
        for (const w of this._writers.values()) w.dispose();
        this._writers.clear();
    }

    /**
     * Load persisted entries from per-session JSONL files.  Idempotent.
     * Errors during read / parse are swallowed.
     *
     * Also performs a one-shot migration: deletes the legacy
     * `cache/vault-edit-log.json` if it still exists.
     */
    async load(): Promise<void> {
        if (this._loaded) return;
        if (this._loadPromise) return this._loadPromise;

        this._loadPromise = this._doLoad().finally(() => {
            this._loaded = true;
            this._loadPromise = null;
        });
        return this._loadPromise;
    }

    private async _doLoad(): Promise<void> {
        const adapter = this.app.vault.adapter;

        // ── One-shot migration: delete the legacy centralised edit-log file ──
        // Before v8, edit-log entries were persisted as a single JSON blob at
        // `cache/vault-edit-log.json`. We now store entries per-session in JSONL
        // format under `sessions/{sessionId}/edit-log.jsonl`. The old file is
        // intentionally NOT migrated — it is simply removed. This block can be
        // deleted in a future release once all users have migrated.
        try {
            if (await adapter.exists(this.options.legacyPersistPath)) {
                await adapter.remove(this.options.legacyPersistPath);
            }
        } catch {
            // Best-effort — a leftover file is harmless.
        }

        // ── Read per-session edit-log.jsonl files ──
        try {
            const sessionIds = await this.resolveSessionIds();
            if (sessionIds.length === 0) return;

            const allEntries: VaultEditLogEntry[] = [];
            for (const sid of sessionIds) {
                const jsonlPath = this.editLogPath(sid);
                if (!(await adapter.exists(jsonlPath))) continue;

                try {
                    const raw = await adapter.read(jsonlPath);
                    const lines = raw.split('\n');
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed) continue;
                        try {
                            const e = JSON.parse(trimmed) as VaultEditLogEntry;
                            if (!e || typeof e !== "object") continue;
                            if (typeof e.id !== "string" || typeof e.path !== "string") continue;
                            if (typeof e.kind !== "string" || typeof e.toolName !== "string") continue;
                            if (typeof e.sessionId !== "string") continue;
                            if (typeof e.createdAt !== "number") continue;
                            allEntries.push(e);
                        } catch {
                            // Skip malformed lines
                        }
                    }
                } catch {
                    // Skip unreadable files
                }
            }

            // Sort newest-first and cap.
            allEntries.sort((a, b) => b.createdAt - a.createdAt);
            this._entries = allEntries.slice(0, VAULT_EDIT_LOG_MAX_ENTRIES);
            this.emit();
        } catch {
            this._entries = [];
        }
    }

    // ── Read API ─────────────────────────────────────────────────────────

    /** Snapshot of the current entry list (caller must not mutate). */
    get entries(): readonly VaultEditLogEntry[] {
        return this._entries;
    }

    // ── Writer registry ──────────────────────────────────────────────────

    /**
     * Get or create the {@link EditLogWriter} for a given session.
     *
     * Called by {@link VaultMutator.recordAudit} every time a vault
     * mutation is recorded so the writer is always the store's canonical
     * instance.  After a {@link clear}, the registry is reset and future
     * calls get a fresh writer.
     */
    getWriter(sessionId: string): EditLogWriter {
        let writer = this._writers.get(sessionId);
        if (!writer || writer.disposed) {
            writer = new EditLogWriter(
                this.app,
                this.options.sessionsDir,
                sessionId,
            );
            this._writers.set(sessionId, writer);
        }
        return writer;
    }

    // ── In-memory mutation (called by VaultMutator) ──────────────────────

    /**
     * Register a newly-persisted entry in the in-memory list.
     *
     * Called by {@link VaultMutator} immediately after the entry has
     * been handed to the session's writer.  The disk write is
     * fire-and-forget; this keeps the memory view in sync.
     */
    addEntry(entry: VaultEditLogEntry): void {
        this._entries.unshift(entry);
        if (this._entries.length > VAULT_EDIT_LOG_MAX_ENTRIES) {
            this._entries.length = VAULT_EDIT_LOG_MAX_ENTRIES;
        }
        this.emit();
    }

    /**
     * Clear all in-memory entries, drain every pending write, delete
     * every edit-log.jsonl file, and reset the writer registry.
     *
     * Memory is cleared first so the view updates immediately; file
     * deletion and registry reset are fire-and-forget.  Because the
     * store owns every writer, there is no race between independent
     * writers and a separate file sweep — after drain, all writes are
     * settled; after registry reset, new writes get fresh writers that
     * create new files.
     */
    clear(): void {
        if (this._entries.length === 0) return;
        this._entries = [];
        this.emit();

        // Snapshot session IDs now.  Drain all writers.  Delete files.
        // Reset the registry so future writes get fresh writers.
        void this._clearFilesAndWriters();
    }

    private async _clearFilesAndWriters(): Promise<void> {
        const sessionIds = await this.resolveSessionIds();

        // Drain every writer's pending chain.
        const writers = Array.from(this._writers.values());
        await Promise.allSettled(writers.map(w => w.drain()));

        // Delete all per-session files.
        await this.deleteEditLogFiles(sessionIds);

        // Dispose every writer and remove disposed entries from the
        // map so getWriter() creates fresh instances.  We dispose
        // rather than simply clearing the map so that any writer
        // created by a concurrent recordAudit between drain and here
        // is also terminated — its pending append will be a no-op
        // and the entry is already in memory via addEntry().
        for (const w of this._writers.values()) w.dispose();
        this._writers.clear();
    }

    // ── Events ───────────────────────────────────────────────────────────

    on(_event: "change", cb: ChangeListener): () => void {
        this._changeListeners.add(cb);
        return () => this._changeListeners.delete(cb);
    }

    private emit(): void {
        for (const cb of this._changeListeners) {
            try { cb(); } catch (e) { console.error("[vault-edit-log] listener failed", e); }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    private editLogPath(sessionId: string): string {
        return `${this.options.sessionsDir}/${sessionId}/${EDIT_LOG_FILENAME}`;
    }

    /**
     * Resolve the authoritative session-id list from
     * `sessions/list.json` (maintained by {@link SessionManager}).
     * Returns an empty array when the file is absent or unreadable.
     */
    private async resolveSessionIds(): Promise<string[]> {
        try {
            const adapter = this.app.vault.adapter;
            const listPath = `${this.options.sessionsDir}/list.json`;
            if (!(await adapter.exists(listPath))) return [];

            const raw = await adapter.read(listPath);
            const parsed = JSON.parse(raw) as { sessions?: { id: string }[] } | null;
            if (!parsed || !Array.isArray(parsed.sessions)) return [];

            return parsed.sessions
                .map((s: { id: string }) => s.id)
                .filter((id: string): id is string => typeof id === "string" && id.length > 0);
        } catch {
            return [];
        }
    }

    /**
     * Delete edit-log.jsonl files for the given session IDs.
     */
    private async deleteEditLogFiles(sessionIds: string[]): Promise<void> {
        try {
            const adapter = this.app.vault.adapter;
            for (const sid of sessionIds) {
                const jsonlPath = this.editLogPath(sid);
                if (await adapter.exists(jsonlPath)) {
                    try {
                        await adapter.remove(jsonlPath);
                    } catch { /* best-effort per file */ }
                }
            }
        } catch (e) {
            console.error("[vault-edit-log] failed to clear session files", e);
        }
    }
}
