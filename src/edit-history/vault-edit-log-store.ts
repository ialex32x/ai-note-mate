/**
 * In-memory + on-disk store for the AI file-changes log.
 *
 * The store owns:
 * - a bounded list of {@link VaultEditLogEntry} records (newest first),
 * - a tiny event bus (`change`) for the view to subscribe to,
 * - throttled JSON persistence to `<plugin-root>/cache/vault-edit-log.json`.
 *
 * Design notes:
 * - Capacity is bounded by {@link VAULT_EDIT_LOG_MAX_ENTRIES}; we trim from
 *   the oldest tail on every `record()` so memory stays O(cap).
 * - Entries are metadata-only (no content); writes are cheap even at
 *   hundreds of entries.
 * - Persistence is throttled so a burst of tool calls inside one chat turn
 *   results in a single disk write.
 */

import type { App } from "obsidian";
import {
    RecordVaultEditInput,
    VAULT_EDIT_LOG_MAX_ENTRIES,
    VaultEditLogEntry,
} from "./vault-edit-log-types";

type ChangeListener = () => void;

/** Throttle window for persistence writes. */
const PERSIST_THROTTLE_MS = 1000;

function generateEntryId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface VaultEditLogStoreOptions {
    /** Vault-relative path to the JSON file used for persistence. */
    persistPath: string;
}

export class VaultEditLogStore {
    /** Entries ordered newest-first. */
    private _entries: VaultEditLogEntry[] = [];
    private readonly _changeListeners = new Set<ChangeListener>();

    private _persistTimer: number | null = null;
    private _disposed = false;
    private _loaded = false;
    /** In-flight load promise so concurrent calls do not race. */
    private _loadPromise: Promise<void> | null = null;

    constructor(
        private readonly app: App,
        private readonly options: VaultEditLogStoreOptions,
    ) {}

    // ── Lifecycle ────────────────────────────────────────────────────────

    /**
     * Load persisted entries from disk. Idempotent — subsequent calls are
     * no-ops. Errors during read / parse are swallowed — the store simply
     * starts empty rather than blocking plugin startup.
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
        try {
            const exists = await this.app.vault.adapter.exists(this.options.persistPath);
            if (!exists) return;
            const raw = await this.app.vault.adapter.read(this.options.persistPath);
            const parsed = JSON.parse(raw) as { entries?: VaultEditLogEntry[] } | null;
            if (!parsed || !Array.isArray(parsed.entries)) return;

            const cleaned: VaultEditLogEntry[] = [];
            for (const e of parsed.entries) {
                if (!e || typeof e !== "object") continue;
                if (typeof e.id !== "string" || typeof e.path !== "string") continue;
                if (typeof e.kind !== "string" || typeof e.toolName !== "string") continue;
                if (typeof e.createdAt !== "number") continue;
                cleaned.push(e);
            }
            this._entries = cleaned.slice(0, VAULT_EDIT_LOG_MAX_ENTRIES);
            this.emit();
        } catch {
            this._entries = [];
        }
    }

    /** Cancel any pending writes. Safe to call multiple times. */
    dispose(): void {
        this._disposed = true;
        if (this._persistTimer !== null) {
            window.clearTimeout(this._persistTimer);
            this._persistTimer = null;
        }
    }

    // ── Read API ─────────────────────────────────────────────────────────

    /** Snapshot of the current entry list (caller must not mutate). */
    get entries(): readonly VaultEditLogEntry[] {
        return this._entries;
    }

    // ── Mutation API ─────────────────────────────────────────────────────

    /**
     * Record a new vault mutation and push it to the front of the list.
     * Excess entries are trimmed from the tail (oldest first).
     */
    record(input: RecordVaultEditInput): VaultEditLogEntry {
        const entry: VaultEditLogEntry = {
            id: generateEntryId(),
            kind: input.kind,
            path: input.path,
            previousPath: input.previousPath,
            isFolder: input.isFolder,
            toolName: input.toolName,
            sessionId: input.sessionId,
            createdAt: Date.now(),
        };
        this._entries.unshift(entry);
        if (this._entries.length > VAULT_EDIT_LOG_MAX_ENTRIES) {
            this._entries.length = VAULT_EDIT_LOG_MAX_ENTRIES;
        }
        this.emit();
        this.schedulePersist();
        return entry;
    }

    /** Drop all entries. */
    clear(): void {
        if (this._entries.length === 0) return;
        this._entries = [];
        this.emit();
        this.schedulePersist();
    }

    // ── Events ───────────────────────────────────────────────────────────

    on(event: "change", cb: ChangeListener): () => void {
        if (event !== "change") return () => { /* no-op */ };
        this._changeListeners.add(cb);
        return () => this._changeListeners.delete(cb);
    }

    private emit(): void {
        for (const cb of this._changeListeners) {
            try { cb(); } catch (e) { console.error("[vault-edit-log] listener failed", e); }
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

    private async persistNow(): Promise<void> {
        if (this._disposed) return;
        try {
            const payload = {
                version: 1 as const,
                entries: this._entries,
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
            console.error("[vault-edit-log] failed to persist", e);
        }
    }
}
