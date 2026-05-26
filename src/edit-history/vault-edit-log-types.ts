/**
 * Type model for the "AI file changes" log.
 *
 * An entry represents a single vault mutation that was performed by an AI
 * tool call (create / modify / rename / delete). The log is a lightweight
 * audit trail — it stores ONLY metadata (paths, tool name, timestamp,
 * optional sessionId), never the pre/post file content.
 */

/** Kind of vault mutation that produced a log entry. */
export type VaultEditKind =
    | "create"   // new file created
    | "modify"   // existing file content changed (append / prepend / replace / edit / write)
    | "rename"   // renamed or moved (file or folder)
    | "delete";  // moved to trash (file or folder)

/** Maximum number of entries kept in memory and persisted to disk. */
export const VAULT_EDIT_LOG_MAX_ENTRIES = 500;

/**
 * A single recorded vault mutation.
 *
 * Fields are flat so the whole entry can be JSON-serialised without a custom
 * encoder. Deliberately does NOT include any file content — auditors who
 * need the actual diff can open the file and consult version control.
 */
export interface VaultEditLogEntry {
    /** Stable unique id; doubles as the key in event payloads. */
    id: string;
    /** Mutation kind. See {@link VaultEditKind}. */
    kind: VaultEditKind;
    /**
     * Target path after the mutation.
     *   - create / modify:  the path of the affected file.
     *   - rename:           the new path (file / folder may still be opened).
     *   - delete:           the path at the time of deletion; no longer
     *                       resolvable in the vault (unreachable for jump).
     */
    path: string;
    /** For `rename` only: the original path. Undefined for other kinds. */
    previousPath?: string;
    /**
     * True when `path` refers to a folder (only possible for `rename` /
     * `delete`). Used by the view to pick an appropriate icon and to decide
     * whether "jump" should open a file or reveal a folder.
     */
    isFolder?: boolean;
    /** Name of the AI tool that performed the mutation (e.g. "create_file"). */
    toolName: string;
    /**
     * Logical session this mutation belongs to. Used by the view to group
     * consecutive edits that happened in the same chat turn. Absent for
     * mutations triggered outside a SessionRuntime (none today, but kept
     * optional for safety).
     */
    sessionId?: string;
    /** Creation timestamp in ms since epoch. */
    createdAt: number;
}

/**
 * Input accepted by `VaultEditLogStore.record`. The store fills in `id` and
 * `createdAt`; callers supply the mutation metadata.
 */
export interface RecordVaultEditInput {
    kind: VaultEditKind;
    path: string;
    previousPath?: string;
    isFolder?: boolean;
    toolName: string;
    sessionId?: string;
}
