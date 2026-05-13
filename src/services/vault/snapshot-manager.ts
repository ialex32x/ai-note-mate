/**
 * SnapshotManager — on-disk blob store for checkpoint snapshots.
 *
 * The store is intentionally a thin blob layer: it knows how to write
 * a byte sequence under `(checkpointId, snapshotId)`, read it back,
 * and wipe everything for a checkpoint (or the entire dir). Semantics
 * — "this snapshot represents the pre-modify content of file X" /
 * "this snapshot marks 'file should not exist'" — live in the
 * {@link CheckpointStore} that owns the metadata; the manager only
 * stores bytes.
 *
 * Layout on disk:
 *
 *   <plugin>/cache/snapshots/<checkpointId>/<snapshotId>.bin
 *
 * Lifecycle:
 *   - All state is runtime-only. The plugin clears the snapshots
 *     directory at startup so leftover blobs from a previous crash do
 *     not consume disk forever.
 *   - On accept/discard the {@link CheckpointStore} calls
 *     {@link deleteCheckpoint} so blobs are reclaimed immediately
 *     rather than waiting for the next startup.
 *   - Plugin unload is best-effort: `onunload()` is synchronous, so we
 *     kick off a fire-and-forget clear that may or may not complete
 *     before Obsidian tears the process down — the next-launch
 *     cleanup is the reliable guarantee.
 */

import type { App } from "obsidian";

/** Generate a short locally-unique id for a snapshot. */
function generateSnapshotId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface SnapshotManagerOptions {
    /**
     * Vault-relative path of the snapshots root directory.
     * Resolved by the caller (typically `plugin.paths.cache() + '/snapshots'`)
     * so the manager stays agnostic of the plugin's path layout.
     */
    rootDir: string;
}

export class SnapshotManager {
    private readonly app: App;
    private readonly rootDir: string;

    constructor(app: App, options: SnapshotManagerOptions) {
        this.app = app;
        this.rootDir = options.rootDir;
    }

    /**
     * Store `content` under the given checkpoint and return the
     * generated snapshot id. The id is filesystem-safe and unique
     * within the snapshots dir.
     */
    async takeContent(checkpointId: string, content: string): Promise<string> {
        const id = generateSnapshotId();
        const dir = this.checkpointDir(checkpointId);
        await this.ensureDir(dir);
        await this.app.vault.adapter.write(`${dir}/${id}.bin`, content);
        return id;
    }

    /**
     * Read back the content previously stored under
     * `(checkpointId, snapshotId)`. Returns `null` when the file is
     * missing (e.g. it was already deleted, or the checkpoint was
     * cleaned up between calls).
     */
    async readContent(checkpointId: string, snapshotId: string): Promise<string | null> {
        const path = `${this.checkpointDir(checkpointId)}/${snapshotId}.bin`;
        try {
            if (!(await this.app.vault.adapter.exists(path))) return null;
            return await this.app.vault.adapter.read(path);
        } catch (e) {
            console.warn("[snapshot] read failed", { path, error: e });
            return null;
        }
    }

    /**
     * Delete every blob under `checkpointId`, then the directory
     * itself. Safe to call when nothing was ever written there.
     * Errors are logged and swallowed — a failed cleanup leaves stale
     * blobs that the next startup will reap.
     */
    async deleteCheckpoint(checkpointId: string): Promise<void> {
        const dir = this.checkpointDir(checkpointId);
        try {
            if (!(await this.app.vault.adapter.exists(dir))) return;
            await this.app.vault.adapter.rmdir(dir, true);
        } catch (e) {
            console.warn("[snapshot] deleteCheckpoint failed", { dir, error: e });
        }
    }

    /**
     * Remove every snapshot blob on disk. Called at plugin startup so
     * that leftover dirs from a previous (possibly crashed) session
     * do not accumulate. The directory itself is recreated lazily on
     * the next {@link takeContent} call.
     */
    async clearAll(): Promise<void> {
        try {
            if (!(await this.app.vault.adapter.exists(this.rootDir))) return;
            await this.app.vault.adapter.rmdir(this.rootDir, true);
        } catch (e) {
            console.warn("[snapshot] clearAll failed", { rootDir: this.rootDir, error: e });
        }
    }

    private checkpointDir(checkpointId: string): string {
        return `${this.rootDir}/${checkpointId}`;
    }

    /**
     * Create `dir` and any missing ancestors. Obsidian's
     * `adapter.mkdir` does not guarantee parent creation across
     * platforms, so we walk from the top and create each missing
     * segment individually. Existing dirs are skipped silently.
     */
    private async ensureDir(dir: string): Promise<void> {
        const segments = dir.split("/").filter(s => s.length > 0);
        let current = "";
        for (const seg of segments) {
            current = current ? `${current}/${seg}` : seg;
            if (await this.app.vault.adapter.exists(current)) continue;
            await this.app.vault.adapter.mkdir(current);
        }
    }
}
