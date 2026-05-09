/**
 * Type model for the AI Edit History feature.
 *
 * An "edit task" represents a single AI rewrite request triggered from the
 * editor (right-click menu or command palette). Tasks live in a small,
 * append-only store and surface in the dedicated AI Edit History view.
 *
 * See {@link ../../docs/ai-edit-history-plan.md} for the full design.
 */

/** Action variants exposed in the editor right-click menu. */
export type EditAction = "expand" | "shorten" | "polish";

/** Lifecycle states a task can move through. */
export type EditTaskStatus =
    | "pending"     // queued, runner has not picked it up yet
    | "running"     // streaming from the model
    | "applied"     // rewritten text was successfully written back to the editor
    | "cancelled"   // user aborted before completion
    | "failed"      // provider error / network error / etc.
    | "stale";      // target editor range no longer matches `originalText`

/**
 * Maximum size (in characters) of a selection that can be sent through the
 * rewrite pipeline. Selections beyond this are rejected at enqueue time to
 * keep latency / cost bounded and to avoid hitting provider context limits.
 */
export const MAX_EDIT_SELECTION_SIZE = 16 * 1024; // 16 KB worth of UTF-16 chars

/**
 * Maximum number of characters kept in the cached `previewBefore` /
 * `previewAfter` fields for list rendering. Full text is still kept in
 * `originalText` / `rewrittenText` for retry and diff display.
 */
export const EDIT_HISTORY_PREVIEW_LIMIT = 280;

/** Maximum number of tasks the store keeps in memory and persists. */
export const EDIT_HISTORY_MAX_TASKS = 100;

/**
 * Persistent record of a single AI rewrite request.
 *
 * Fields are deliberately flat so the whole task can be JSON-serialised
 * without a custom encoder.
 */
export interface EditTask {
    /** Stable unique id; doubles as the key in event payloads. */
    id: string;
    /** Which rewrite action was requested. */
    action: EditAction;
    /** Lifecycle state. */
    status: EditTaskStatus;

    // ── Target locator ──────────────────────────────────────────────────
    /**
     * Vault-relative path of the file whose editor was active when the task
     * was created. Empty string for unsaved drafts where we have no path.
     */
    filePath: string;

    /**
     * Selection range in CodeMirror (line / ch) coordinates, captured at
     * enqueue time. Used both to validate that the buffer is still
     * untouched at completion and to perform the actual replaceRange call.
     */
    fromLine: number;
    fromCh: number;
    toLine: number;
    toCh: number;

    // ── Content ─────────────────────────────────────────────────────────
    /** Original selected text — preserved for diff and retry. */
    originalText: string;
    /** Rewritten text accumulated from the stream (may be partial while running). */
    rewrittenText: string;

    /** Cached truncated preview of `originalText` for list rendering. */
    previewBefore: string;
    /** Cached truncated preview of `rewrittenText` for list rendering. */
    previewAfter: string;

    // ── Metadata ────────────────────────────────────────────────────────
    /** Creation timestamp in ms since epoch. */
    createdAt: number;
    /** Last mutation timestamp in ms since epoch. */
    updatedAt: number;

    /** Display name of the profile that ran (or is running) the task. */
    profileName: string;
    /** Model identifier used for the request. */
    modelName: string;

    /**
     * Number of bytes (UTF-16 code units) of `rewrittenText` produced so far.
     * Used by the view to render a lightweight progress indicator without
     * ever computing a percentage (LLM streams have no known total length).
     */
    bytes: number;

    /** Human-readable error message when `status === 'failed'`. */
    error?: string;
}

/**
 * Input accepted by `EditHistoryStore.enqueue`.
 *
 * Caller supplies the selection coordinates, source path and profile info;
 * the store fills in id, timestamps, status and preview caches.
 */
export interface EnqueueEditTaskInput {
    action: EditAction;
    filePath: string;
    fromLine: number;
    fromCh: number;
    toLine: number;
    toCh: number;
    originalText: string;
    profileName: string;
    modelName: string;
}
