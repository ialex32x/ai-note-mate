/**
 * Per-session edit-log writer.
 *
 * Each session owns its own writer instance.  Mutations are appended as
 * JSONL lines to `sessions/{sessionId}/edit-log.jsonl`.  The writer
 * serialises concurrent appends within a single session via an internal
 * promise chain so two rapid tool calls never interleave their
 * read-then-write operations.
 *
 * @module
 */

import type { App } from "obsidian";
import { EDIT_LOG_FILENAME, type VaultEditLogEntry } from "./vault-edit-log-types";

export class EditLogWriter {
    private _writeChain: Promise<void> = Promise.resolve();
    private _disposed = false;

    constructor(
        private readonly app: App,
        private readonly sessionsDir: string,
        private readonly sessionId: string,
    ) {}

    /** Cancel pending writes and prevent future writes. */
    dispose(): void {
        this._disposed = true;
    }

    /** Whether this writer has been disposed. */
    get disposed(): boolean {
        return this._disposed;
    }

    /**
     * Append a single edit-log entry to this session's JSONL file.
     *
     * Fire-and-forget — errors are logged to the console.  Consecutive
     * appends are serialised through the internal write chain so two
     * rapid tool calls within one turn never race.
     */
    append(entry: VaultEditLogEntry): void {
        if (this._disposed) return;
        const work = () => this._doAppend(entry);
        this._writeChain = this._writeChain.then(work, work);
    }

    /**
     * Wait for all pending appends to settle.
     *
     * Called by {@link VaultEditLogStore.clear} before deleting files so
     * in-flight writes don't resurrect a just-deleted edit-log.jsonl.
     */
    async drain(): Promise<void> {
        await this._writeChain.catch(() => { /* swallow */ });
    }

    // ── Internals ────────────────────────────────────────────────────────

    private editLogPath(): string {
        return `${this.sessionsDir}/${this.sessionId}/${EDIT_LOG_FILENAME}`;
    }

    private sessionDirPath(): string {
        return `${this.sessionsDir}/${this.sessionId}`;
    }

    private async _doAppend(entry: VaultEditLogEntry): Promise<void> {
        if (this._disposed) return;
        try {
            const adapter = this.app.vault.adapter;
            const dirPath = this.sessionDirPath();
            const filePath = this.editLogPath();

            if (!(await adapter.exists(dirPath))) {
                await adapter.mkdir(dirPath);
            }

            const line = `${JSON.stringify(entry)}\n`;
            const existing = (await adapter.exists(filePath))
                ? await adapter.read(filePath)
                : '';
            await adapter.write(filePath, existing + line);
        } catch (e) {
            console.error("[edit-log-writer] failed to append entry", e);
        }
    }

}
