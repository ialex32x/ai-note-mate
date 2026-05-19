/**
 * todo-state.ts
 *
 * Pure data shapes for the per-session TODO list maintained by the
 * `manage_todos` tool. Kept type-only so it can be imported from:
 *   - the tool factory (`todo-toolcall.ts`)
 *   - the runtime (`session-runtime.ts`)
 *   - the persistence layer (`session-manager.ts`)
 *   - the UI panel (`components/session/todo-panel.ts`)
 *
 * Splitting the types out of the tool module keeps `session-manager.ts`
 * independent of any tool implementation, so the persistence layer
 * never accidentally pulls in chat-stream / orchestrator transitively
 * through the tool factory.
 *
 * Semantics:
 * - The state is owned by the LLM (read-only on the UI side). Each
 *   call to the tool's `write` action replaces `items` wholesale; each
 *   `update` action patches a single item by id.
 * - Each item carries TWO independently meaningful strings:
 *     * `brief`   — short user-facing summary rendered verbatim in the
 *                   TodoPanel. The panel never falls back to anything
 *                   else: if `brief` is empty, the row is empty. Keep
 *                   it terse (≤ ~120 chars) and in the user's
 *                   language.
 *     * `content` — long machine-facing task spec the model re-reads
 *                   on every `list` / `update` call. Acts as a
 *                   per-item persistent scratchpad that survives
 *                   context compression: should encode WHAT to do,
 *                   WHERE (files / functions / line ranges if
 *                   applicable), and WHAT DONE LOOKS LIKE (success
 *                   criteria). Up to ~800 chars.
 *   Both are required. The UI never reads `content` and the model
 *   never relies on `brief` for execution — the asymmetry is the
 *   point. See `TodoPanel` and `TODO_USAGE_RULES` for the consumer
 *   sides.
 * - `updatedAt` is a single epoch-ms timestamp covering the whole
 *   state object — kept at the top level so the UI can cheaply
 *   compare snapshots without walking every item.
 */

/** Lifecycle status of a single TODO item. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** A single subtask in the TODO list. */
export interface TodoItem {
    /**
     * Stable identifier chosen by the model. Short, opaque to the user
     * (e.g. `"step-1"`, `"a"`, `"refactor"`). The runtime never mints
     * ids — the model is required to supply them so subsequent
     * `update` calls can reliably target the same row.
     */
    id: string;
    /**
     * Short user-facing summary. Rendered verbatim in the TodoPanel.
     * Should fit on one line (≤ ~120 chars) and be written in the
     * user's language. Required.
     */
    brief: string;
    /**
     * Long machine-facing task description. Encodes what to do, where
     * (files / functions), and what the success criteria look like —
     * the persistent scratchpad the model re-reads when it returns to
     * this item after intervening tool calls or a context
     * compression. Required. Up to ~800 chars.
     */
    content: string;
    status: TodoStatus;
    /** Epoch-ms timestamp when the item was first written. */
    createdAt: number;
    /** Epoch-ms timestamp of the most recent mutation (write or update). */
    updatedAt: number;
}

/** Full TODO snapshot persisted alongside the session messages file. */
export interface TodoState {
    items: TodoItem[];
    /** Epoch-ms timestamp of the most recent state mutation. */
    updatedAt: number;
}

/** Empty (no items) snapshot. Used as the universal default. */
export function emptyTodoState(): TodoState {
    return { items: [], updatedAt: 0 };
}

/** True when the snapshot has no items at all. */
export function isEmptyTodoState(state: TodoState | null | undefined): boolean {
    return !state || state.items.length === 0;
}
