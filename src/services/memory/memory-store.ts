/**
 * MemoryStore — vault-note-backed CRUD for memory entries.
 *
 * Responsibilities:
 *   - Resolve the configured note path → `TFile` (auto-create + template on
 *     first use, when the user has not pointed at an existing file).
 *   - Read and cache the parsed entry list, keyed by the file's `mtime`,
 *     so the hot path (prompt prefix, settings preview) does not re-read
 *     the file every turn.
 *   - Provide async write operations (`upsert`, `delete`, `rename`,
 *     `setCritical`) that splice the source by line range and persist via
 *     `app.vault.modify`. All writes go through the same low-level
 *     `splice` helper so the file invariants (entry separation, trailing
 *     newline) stay consistent regardless of caller.
 *
 * Concurrency model:
 *   - Writes are serialised with a per-store mutex (single in-flight
 *     promise chain). Reads are not — they read from cache and only fall
 *     back to `vault.read()` when the cache is invalidated.
 *   - The store does not subscribe to vault events itself; instead it
 *     re-reads on cache miss (mtime mismatch). This keeps the surface
 *     area small (no lifecycle to dispose) and avoids racing with our
 *     own writes.
 *
 * Errors:
 *   - "Note path empty / parent missing / not a TFile" surface as
 *     {@link MemoryStoreError} with a stable `kind` so the settings UI
 *     can render a localised message without string-matching messages.
 *   - Writes are idempotent where it makes sense (delete on missing
 *     entry is a no-op, upsert of an existing entry replaces in place).
 */

import { Notice, TFile, TFolder, normalizePath, type App } from 'obsidian';
import type NoteAssistantPlugin from '../../main';
import { CRITICAL_HEADING_SUFFIX, MEMORY_ENTRY_LEVEL } from './constants';
import { formatFileHeading, isValidLogicalHeading } from './heading-format';
import {
    parseMemoryNote,
    renderMemoryEntry,
    trimTrailingBlankLines,
    type MemoryEntry,
    type ParsedMemoryNote,
} from './memory-note-parser';

export type MemoryStoreErrorKind =
    | 'path_empty'
    | 'path_invalid'
    | 'parent_create_failed'
    | 'file_create_failed'
    | 'not_a_file'
    | 'read_failed'
    | 'write_failed'
    | 'heading_invalid'
    | 'not_found';

/** Stable, machine-readable error type so the UI can render a localised message. */
export class MemoryStoreError extends Error {
    constructor(public readonly kind: MemoryStoreErrorKind, message: string) {
        super(message);
        this.name = 'MemoryStoreError';
    }
}

interface CacheSnapshot {
    mtime: number;
    parsed: ParsedMemoryNote;
}

/**
 * Default body of the memory note when we auto-create it. The intent
 * is to teach the user (and any LLM scanning the file's first turn) the
 * file's role and the `[!]` convention without dictating a structure.
 */
const DEFAULT_NOTE_TEMPLATE = `# Memory

This note is the assistant's long-term memory. Each \`##\` section is one entry.

Add \` [!]\` to a heading to mark the entry as critical — it is injected on every turn. Plain headings are injected only when their content is relevant to the current question.

Obsidian callouts (\`> [!note]\`, \`> [!info]\`, …) inside an entry body are treated as your private annotations: they show up here but are stripped before the entry is shown to the assistant or used for similarity ranking. Use them to leave yourself reminders about *why* an entry exists.

`;

export class MemoryStore {
    private readonly app: App;
    private cache: CacheSnapshot | null = null;
    /** Serialises writes; reads are unguarded. */
    private writeChain: Promise<void> = Promise.resolve();

    constructor(private readonly plugin: NoteAssistantPlugin) {
        this.app = plugin.app;
    }

    // ── Config-driven path resolution ────────────────────────────────────

    /** Currently configured note path, normalised. Empty string when unset. */
    private notePath(): string {
        const raw = this.plugin.settings.memoryNotePath?.trim() ?? '';
        if (!raw) return '';
        return normalizePath(raw);
    }

    /**
     * Lookup the configured file without creating it. Returns null when
     * the path is unset, points at a folder, or simply does not exist.
     */
    findFile(): TFile | null {
        const path = this.notePath();
        if (!path) return null;
        const af = this.app.vault.getAbstractFileByPath(path);
        return af instanceof TFile ? af : null;
    }

    /**
     * Ensure the memory note exists, creating it (and any missing parent
     * folders) from {@link DEFAULT_NOTE_TEMPLATE} when necessary.
     *
     * Refuses to create when the configured path collides with a folder
     * — the caller should surface a UI-level error.
     */
    async ensureFile(): Promise<TFile> {
        const path = this.notePath();
        if (!path) {
            throw new MemoryStoreError('path_empty', 'Memory note path is empty.');
        }

        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) return existing;
        if (existing) {
            throw new MemoryStoreError(
                'not_a_file',
                `Memory note path ${path} resolves to a folder, not a file.`,
            );
        }

        // Walk parent folders and create any missing segments.
        const parts = path.split('/');
        if (parts.length > 1) {
            const parentPath = parts.slice(0, -1).join('/');
            const parent = this.app.vault.getAbstractFileByPath(parentPath);
            if (!parent) {
                try {
                    await this.app.vault.createFolder(parentPath);
                } catch (err) {
                    throw new MemoryStoreError(
                        'parent_create_failed',
                        `Failed to create memory note parent folder ${parentPath}: ${describeError(err)}`,
                    );
                }
            } else if (!(parent instanceof TFolder)) {
                throw new MemoryStoreError(
                    'path_invalid',
                    `Memory note parent ${parentPath} exists but is not a folder.`,
                );
            }
        }

        try {
            const file = await this.app.vault.create(path, DEFAULT_NOTE_TEMPLATE);
            return file;
        } catch (err) {
            throw new MemoryStoreError(
                'file_create_failed',
                `Failed to create memory note ${path}: ${describeError(err)}`,
            );
        }
    }

    // ── Reads ────────────────────────────────────────────────────────────

    /**
     * Synchronous accessor used by the prompt-prefix hot path. Returns
     * the most recent parsed snapshot, or null when no read has happened
     * yet / the configured file is missing. Call {@link refreshEntries}
     * (or any write) to populate the cache.
     */
    cachedEntries(): MemoryEntry[] | null {
        return this.cache ? this.cache.parsed.entries : null;
    }

    /**
     * Force a re-read of the configured file and return the parsed
     * entry list. Does NOT create the file when missing — returns `[]`
     * for that case so settings UI / prompt prefix don't trigger a
     * silent vault write on first read.
     */
    async refreshEntries(): Promise<MemoryEntry[]> {
        const file = this.findFile();
        if (!file) {
            this.cache = null;
            return [];
        }
        const parsed = await this.readAndCache(file);
        return parsed.entries;
    }

    private async readAndCache(file: TFile): Promise<ParsedMemoryNote> {
        const mtime = file.stat.mtime;
        if (this.cache && this.cache.mtime === mtime) {
            return this.cache.parsed;
        }
        let raw: string;
        try {
            raw = await this.app.vault.read(file);
        } catch (err) {
            throw new MemoryStoreError(
                'read_failed',
                `Failed to read memory note ${file.path}: ${describeError(err)}`,
            );
        }
        const parsed = parseMemoryNote(raw);
        this.cache = { mtime, parsed };
        return parsed;
    }

    // ── Writes ───────────────────────────────────────────────────────────

    /**
     * Create or replace the entry whose logical heading matches
     * `logical`. Both critical and non-critical variants share the same
     * logical-name slot — re-upserting flips the criticality if needed.
     *
     * Returns the resulting entry.
     */
    async upsert(logical: string, critical: boolean, body: string): Promise<MemoryEntry> {
        const cleanLogical = logical.trim();
        if (!isValidLogicalHeading(cleanLogical)) {
            throw new MemoryStoreError(
                'heading_invalid',
                `Memory heading is empty after trimming/stripping the critical marker.`,
            );
        }
        return this.serialise(async () => {
            const file = await this.ensureFile();
            const parsed = await this.readAndCache(file);
            const entry = findEntryByLogical(parsed.entries, cleanLogical);
            const renderedSection = renderMemoryEntry(cleanLogical, critical, body);
            const newRaw = entry
                ? replaceRange(parsed, entry, ensureTrailingNewline(renderedSection))
                : appendSection(parsed, renderedSection);
            await this.writeFile(file, newRaw);
            const refreshed = await this.refreshAfterWrite();
            const created = findEntryByLogical(refreshed, cleanLogical);
            if (!created) {
                // Highly unexpected — the write succeeded but the entry
                // didn't round-trip. Surface as a generic write error so
                // the caller can show a notice.
                throw new MemoryStoreError(
                    'write_failed',
                    `Memory upsert succeeded but the entry did not round-trip from disk.`,
                );
            }
            return created;
        });
    }

    /**
     * Remove the entry whose logical heading matches. No-op (returns
     * `false`) when the entry does not exist.
     */
    async delete(logical: string): Promise<boolean> {
        const cleanLogical = logical.trim();
        if (!isValidLogicalHeading(cleanLogical)) return false;
        return this.serialise(async () => {
            const file = this.findFile();
            if (!file) return false;
            const parsed = await this.readAndCache(file);
            const entry = findEntryByLogical(parsed.entries, cleanLogical);
            if (!entry) return false;
            const newRaw = removeRange(parsed, entry);
            await this.writeFile(file, newRaw);
            await this.refreshAfterWrite();
            return true;
        });
    }

    /**
     * Promote / demote an entry's critical flag without touching its body.
     * Returns the updated entry; throws `not_found` if the entry is
     * absent (callers should `upsert` instead in that case).
     */
    async setCritical(logical: string, critical: boolean): Promise<MemoryEntry> {
        const cleanLogical = logical.trim();
        if (!isValidLogicalHeading(cleanLogical)) {
            throw new MemoryStoreError('heading_invalid', 'Memory heading is empty.');
        }
        return this.serialise(async () => {
            const file = await this.ensureFile();
            const parsed = await this.readAndCache(file);
            const entry = findEntryByLogical(parsed.entries, cleanLogical);
            if (!entry) {
                throw new MemoryStoreError('not_found', `Memory entry "${cleanLogical}" not found.`);
            }
            if (entry.critical === critical) return entry;
            const newHeading = formatFileHeading(cleanLogical, critical);
            const newHeadingLine = `${'#'.repeat(MEMORY_ENTRY_LEVEL)} ${newHeading}`;
            const newLines = parsed.lines.slice();
            newLines[entry.startLine - 1] = newHeadingLine;
            await this.writeFile(file, newLines.join('\n'));
            const refreshed = await this.refreshAfterWrite();
            const updated = findEntryByLogical(refreshed, cleanLogical);
            return updated ?? entry;
        });
    }

    private async writeFile(file: TFile, content: string): Promise<void> {
        try {
            await this.app.vault.modify(file, content);
        } catch (err) {
            throw new MemoryStoreError(
                'write_failed',
                `Failed to write memory note ${file.path}: ${describeError(err)}`,
            );
        }
    }

    private async refreshAfterWrite(): Promise<MemoryEntry[]> {
        // Bust the cache so the next read picks up the new mtime.
        this.cache = null;
        return await this.refreshEntries();
    }

    /**
     * Serialise mutating operations onto a single in-flight chain so two
     * concurrent `upsert`s on the same store cannot stomp each other's
     * line numbers.
     */
    private serialise<T>(task: () => Promise<T>): Promise<T> {
        const run = this.writeChain.then(task, task);
        this.writeChain = run.then(() => undefined, () => undefined);
        return run;
    }
}

// ─── helpers ────────────────────────────────────────────────────────────

/**
 * Convenience: case-insensitive logical-heading lookup. We deliberately
 * normalise via `.trim().toLowerCase()` here so callers don't have to
 * remember the comparison rule — the store is the source of truth.
 */
export function findEntryByLogical(entries: readonly MemoryEntry[], logical: string): MemoryEntry | undefined {
    const needle = logical.trim().toLowerCase();
    if (!needle) return undefined;
    return entries.find(e => e.logicalHeading.trim().toLowerCase() === needle);
}

/**
 * Replace the `[startLine, endLine]` range (1-based inclusive) with
 * `replacement`. Trailing newline normalisation lives here so callers
 * don't have to think about whether their snippet ends in `\n`.
 */
function replaceRange(parsed: ParsedMemoryNote, entry: MemoryEntry, replacement: string): string {
    const before = parsed.lines.slice(0, entry.startLine - 1);
    const after = parsed.lines.slice(entry.endLine);
    const lead = before.length > 0 ? before.join('\n') + '\n' : '';
    const trail = after.length > 0 ? '\n' + after.join('\n') : '';
    const middle = stripTrailingNewline(replacement);
    return lead + middle + trail;
}

/**
 * Delete the `[startLine, endLine]` range. Also drops a single trailing
 * blank line that would otherwise be left orphaned between the previous
 * and following entries.
 */
function removeRange(parsed: ParsedMemoryNote, entry: MemoryEntry): string {
    const before = parsed.lines.slice(0, entry.startLine - 1);
    const after = parsed.lines.slice(entry.endLine);
    // Drop a single trailing blank line on `before` so we don't end up
    // with a double blank between siblings after the deletion.
    while (before.length > 0 && before[before.length - 1]!.trim() === '') {
        before.pop();
        // Only collapse ONE blank line; users may have authored extra
        // padding intentionally.
        break;
    }
    const lead = before.length > 0 ? before.join('\n') : '';
    if (after.length === 0) return lead + (lead ? '\n' : '');
    const sep = lead ? '\n\n' : '';
    return lead + sep + after.join('\n');
}

/**
 * Append a new section to the end of the file, leaving one blank line
 * between the last existing entry (or the front matter / title) and
 * the new one.
 */
function appendSection(parsed: ParsedMemoryNote, section: string): string {
    const tail = ensureTrailingNewline(section);
    if (parsed.lines.length === 0) return tail;
    // Strip trailing blanks on the existing content first, then add
    // exactly one blank line as separator.
    const existing = trimTrailingBlankLines(parsed.lines.join('\n'));
    if (!existing) return tail;
    return existing + '\n\n' + tail;
}

function ensureTrailingNewline(s: string): string {
    return s.endsWith('\n') ? s : s + '\n';
}

function stripTrailingNewline(s: string): string {
    return s.endsWith('\n') ? s.slice(0, -1) : s;
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

/**
 * Lightweight helper for callers that want to know if a feature should
 * run at all (gated by both the master switch and a non-empty path).
 */
export function isMemoryConfigured(plugin: NoteAssistantPlugin): boolean {
    if (!plugin.settings.memoryEnabled) return false;
    return (plugin.settings.memoryNotePath?.trim().length ?? 0) > 0;
}

/** Re-export so external callers can pull this constant from one module. */
export { CRITICAL_HEADING_SUFFIX };

/**
 * One-shot helper used by the settings "Notice on save failure" wiring.
 * Surfaces a localised-ish notice for write errors without forcing every
 * call site to thread an i18n function in. The message text is short and
 * uses the store's stable `kind` so users can grep this codebase to find
 * the meaning.
 */
export function showMemoryStoreErrorNotice(err: unknown): void {
    if (err instanceof MemoryStoreError) {
        new Notice(`Memory: ${err.message}`);
    } else if (err instanceof Error) {
        new Notice(`Memory: ${err.message}`);
    }
}
