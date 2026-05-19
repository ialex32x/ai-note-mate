/**
 * todo-toolcall.ts
 *
 * Built-in `manage_todos` tool that lets the main agent maintain a
 * per-session TODO list across a complex task. The list is stored on
 * the {@link SessionRuntime}, persisted by {@link SessionManager} into
 * `sessions/{id}.json` (schema v4), and surfaced to the user via the
 * `TodoPanel` pinned at the top of the chat view. The model receives
 * the full current state in every tool result so it can keep
 * referring to subtasks even after context compression / reload.
 *
 * Design choices:
 * - Single tool with an `action` discriminator (write / update / list
 *   / clear). One tool name keeps the schema list short and gives the
 *   embedding-based filter a single, semantically tight anchor; weaker
 *   models also cope better with one tool + an enum than with four
 *   visually similar tool names.
 * - "User-facing vs LLM-facing" split: each item carries TWO required
 *   strings with disjoint audiences. `brief` is a short summary
 *   rendered verbatim in the TodoPanel (user-facing, ≤ 80 chars,
 *   user's language). `content` is a long machine-facing task spec
 *   the model re-reads on every list/update — files, operations,
 *   success criteria — acting as a per-item persistent scratchpad
 *   that survives context compression. The UI never reads `content`
 *   and the model never executes against `brief`; the asymmetry
 *   forces the model to think at two abstraction levels at plan
 *   time and gives long-horizon agentic tasks an anti-drift anchor.
 * - Always-on (`ondemand: false`): planning structure should be
 *   available regardless of how the conversation has drifted, and
 *   the schema is small enough that the token cost is negligible.
 * - Registered ONLY on the main agent. Sub-agents are one-shot and
 *   should not maintain cross-call TODO state — they communicate
 *   structured results upward via their own `exchange` store.
 */

import type { RegisteredTool, ToolCallResult } from '../chat-stream';
import {
    emptyTodoState,
    type TodoItem,
    type TodoState,
    type TodoStatus,
} from './todo-state';

// ─────────────────────────────────────────────────────────────────────────────
// Source pattern (same shape as exchange / recall_artifact)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Indirection layer the tool uses to reach the live runtime state.
 * Mirrors {@link createExchangeTool} / {@link createRecallArtifactTool}
 * so the chat agent can be built once at construction time while the
 * actual {@link SessionRuntime} reference is owned by the runtime
 * factory. The closure-supplied source guarantees we always read /
 * write the current runtime's state, even though the IChatAgent is
 * long-lived.
 */
export interface TodoStateSource {
    /** Read the current snapshot. MUST never throw. */
    get(): TodoState;
    /** Replace the whole list. Returns the post-mutation snapshot. */
    replaceAll(items: TodoStateInputItem[]): TodoState;
    /** Patch a single item. Returns `null` when the id is unknown. */
    update(
        id: string,
        patch: Partial<Pick<TodoItem, 'status' | 'brief' | 'content'>>,
    ): TodoState | null;
    /** Drop every item. Returns the (empty) post-mutation snapshot. */
    clear(): TodoState;
}

/** Loose input shape accepted by `write` — both `brief` and `content` are mandatory. */
export interface TodoStateInputItem {
    id: string;
    brief: string;
    content: string;
    status?: TodoStatus;
}

/**
 * Either a direct {@link TodoStateSource} (unit tests) or a getter
 * resolving the *current* source at call time (production: the runtime
 * factory hands the chat agent a closure over its own state).
 *
 * When the getter returns `null` the tool surfaces a clear runtime
 * error to the model rather than crashing — same convention as
 * `exchange` / `recall_artifact`.
 */
export type TodoStateSourceSource = TodoStateSource | (() => TodoStateSource | null);

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_NAME = 'manage_todos';

/** Hard upper bound on the number of items in the list (defensive). */
const MAX_TODO_ITEMS = 100;
/**
 * Hard upper bound on `brief`. Sized to fit a single line at typical
 * sidebar widths (~400-600 px) without ellipsis on most themes — we
 * don't render a tooltip showing the full string, so anything that
 * truncates in the UI is effectively lost to the user. The model is
 * told to aim shorter still (≤ 1 short sentence).
 *
 * If you bump this, keep the duplicate `MAX_BRIEF_LEN` in
 * SessionManager's v4→v5 migration in sync (synthesised brief uses
 * the same upper bound so it never overshoots what the cap allows).
 */
const MAX_TODO_BRIEF_LENGTH = 80;
/**
 * Hard upper bound on `content`. Larger than `brief` because `content`
 * is the model's per-item scratchpad and benefits from concrete
 * detail — files, success criteria, dependencies. 700 leaves comfortable
 * headroom over typical 200-500 char actual usage; items that genuinely
 * need more are a signal the subtask should have been split, and the
 * cap surfaces that signal as a corrective error to the model.
 */
const MAX_TODO_CONTENT_LENGTH = 700;
/**
 * Per-turn call budget. We intentionally OMIT `soft` here: unlike
 * retrieval tools where soft means "you probably have enough data,
 * stop fetching", `manage_todos` is a *task-progression* tool whose
 * call count grows linearly with task size (≥1 update per planned
 * step, plus the initial write and the occasional replan). A soft
 * nudge would trick the model into halting mid-plan and asking the
 * user to say "continue", which is exactly the failure mode we want
 * to avoid. `hard` stays as a safety belt against pathological
 * loops (e.g. the model toggling the same item's status forever):
 * 50 comfortably covers a 30-step plan with replans while still
 * cutting off true runaways well inside a single turn.
 */
const TODO_CALLS_PER_TURN = { hard: 50 } as const;

const TOOL_DESCRIPTION =
    'Maintain a structured TODO list for the current session. Use this when, and ' +
    'ONLY when, the user request is non-trivial: breaks down into 3+ concrete ' +
    'subtasks, spans multiple files/tools, or you need to keep track of progress ' +
    'across many tool calls. Do NOT use it for casual questions, single-step ' +
    'lookups, or short edits — the overhead is not worth it. ' +
    'Workflow: ' +
    '(1) call action="write" once at the start with the full plan, every item ' +
    '`status: "pending"`; ' +
    '(2) before starting each item, call action="update" to set it to ' +
    '"in_progress" (keep AT MOST ONE item in_progress at a time); ' +
    '(3) when an item is done, call action="update" to set "completed"; ' +
    '(4) after every item is completed or cancelled, deliver the final assistant ' +
    `reply summarising what was done. ` +
    'Each item has TWO required strings with disjoint audiences: ' +
    '`brief` is a short user-facing summary (≤ 80 chars, the user\'s language) ' +
    'rendered verbatim in the TODO panel — make it a 1-line headline. ' +
    '`content` is YOUR per-item scratchpad (≤ 700 chars): write the concrete plan ' +
    'for this step — files involved, operations, dependencies, success criteria. ' +
    'You will re-read `content` when you return to this item after intervening ' +
    'tool calls, so include enough detail that "future you" can resume without ' +
    'guessing. The tool returns the full current list on every call, so you do ' +
    'not need to remember state between calls; call action="list" to re-sync ' +
    'after context compression or a session reload.';

export function createTodoTool(source: TodoStateSourceSource): RegisteredTool {
    const resolveSource: () => TodoStateSource | null = typeof source === 'function'
        ? source
        : () => source;

    return {
        // Always visible to the model — planning structure must not
        // depend on whether the user's wording happens to be close to
        // the tool description's embedding. The schema is small.
        ondemand: false,
        capabilities: [],
        requiresConfirmation: false,
        maxCallsPerTurn: TODO_CALLS_PER_TURN,

        schema: {
            type: 'function',
            function: {
                name: TOOL_NAME,
                description: TOOL_DESCRIPTION,
                parameters: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['write', 'update', 'list', 'clear'],
                            description:
                                "'write' replaces the whole list (use for the initial plan); " +
                                "'update' patches one item by id (typical use: mark in_progress / completed); " +
                                "'list' returns the current snapshot without mutating; " +
                                "'clear' removes every item.",
                        },
                        items: {
                            type: 'array',
                            description:
                                "Used only with action='write'. The full new list. Each entry needs " +
                                '`id` (short stable string you choose), `brief` (one-line user-facing ' +
                                'summary, ≤ 80 chars), and `content` (longer machine-facing task spec, ' +
                                "≤ 700 chars). `status` defaults to 'pending' when omitted.",
                            items: {
                                type: 'object',
                                properties: {
                                    id: {
                                        type: 'string',
                                        description:
                                            'Short stable identifier you pick (e.g. "step-1", "refactor"). ' +
                                            'Must be unique within the list.',
                                    },
                                    brief: {
                                        type: 'string',
                                        description:
                                            'Short user-facing summary (≤ 80 chars). Rendered verbatim in ' +
                                            "the TODO panel — keep it to a single line in the user's " +
                                            'language. Required.',
                                    },
                                    content: {
                                        type: 'string',
                                        description:
                                            'Your per-item scratchpad (≤ 700 chars). Write the concrete plan ' +
                                            'for this step: files involved, operations, dependencies, success ' +
                                            'criteria. You will re-read this when you return to the item after ' +
                                            'intervening tool calls or context compression. Required.',
                                    },
                                    status: {
                                        type: 'string',
                                        enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                                        description: 'Initial status. Defaults to "pending" when omitted.',
                                    },
                                },
                                required: ['id', 'brief', 'content'],
                            },
                        },
                        id: {
                            type: 'string',
                            description:
                                "Required for action='update'. The id of the item to patch.",
                        },
                        status: {
                            type: 'string',
                            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                            description:
                                "Used with action='update'. New status for the item.",
                        },
                        brief: {
                            type: 'string',
                            description:
                                "Used with action='update'. New user-facing `brief` for the item " +
                                '(≤ 80 chars). Provide when the user-visible summary needs revision; ' +
                                'omit to keep the existing one.',
                        },
                        content: {
                            type: 'string',
                            description:
                                "Used with action='update'. New machine-facing `content` for the item " +
                                '(≤ 700 chars). Use this when the plan for this step has been refined ' +
                                '(e.g. you learnt new files are involved, the success criterion shifted). ' +
                                'Omit to keep the existing `content`.',
                        },
                    },
                    required: ['action'],
                },
            },
        },

        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const action = args['action'];
            if (typeof action !== 'string') {
                return errorResult("`action` is required and must be one of 'write', 'update', 'list', 'clear'.");
            }

            const src = resolveSource();
            if (!src) {
                return errorResult(
                    'manage_todos called outside an active session. ' +
                    'This is an internal bug; the TODO state channel is not available right now.',
                );
            }

            switch (action) {
                case 'write':
                    return execWrite(src, args);
                case 'update':
                    return execUpdate(src, args);
                case 'list':
                    return execList(src);
                case 'clear':
                    return execClear(src);
                default:
                    return errorResult(
                        `Unknown action "${action}". Supported actions: 'write', 'update', 'list', 'clear'.`,
                    );
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action handlers
// ─────────────────────────────────────────────────────────────────────────────

function execWrite(src: TodoStateSource, args: Record<string, unknown>): ToolCallResult {
    const rawItems = args['items'];
    if (!Array.isArray(rawItems)) {
        return errorResult("`items` must be an array of TODO entries for action='write'.");
    }
    if (rawItems.length === 0) {
        // An empty `write` is semantically identical to `clear`, but the
        // model may have meant to pass items and accidentally dropped
        // them — error loudly rather than silently nuke the list.
        return errorResult(
            "`items` must contain at least one entry. To remove every item, call action='clear' instead.",
        );
    }
    if (rawItems.length > MAX_TODO_ITEMS) {
        return errorResult(
            `Too many items (${rawItems.length}); maximum is ${MAX_TODO_ITEMS}. ` +
            'Split the plan into a more compact list — long flat plans are usually a sign that ' +
            'the work should be grouped into higher-level milestones.',
        );
    }

    const seenIds = new Set<string>();
    const normalised: TodoStateInputItem[] = [];

    const items = rawItems as readonly unknown[];
    for (let i = 0; i < items.length; i++) {
        const raw = items[i];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return errorResult(`items[${i}] must be an object.`);
        }
        const entry = raw as Record<string, unknown>;

        const id = entry['id'];
        if (typeof id !== 'string' || !id.trim()) {
            return errorResult(`items[${i}].id must be a non-empty string.`);
        }
        const trimmedId = id.trim();
        if (seenIds.has(trimmedId)) {
            return errorResult(
                `Duplicate id "${trimmedId}" at items[${i}]. Each id must be unique within the list.`,
            );
        }
        seenIds.add(trimmedId);

        const brief = entry['brief'];
        if (typeof brief !== 'string' || !brief.trim()) {
            return errorResult(
                `items[${i}].brief must be a non-empty string. ` +
                "It's the short summary the user sees in the TODO panel.",
            );
        }
        if (brief.length > MAX_TODO_BRIEF_LENGTH) {
            return errorResult(
                `items[${i}].brief exceeds ${MAX_TODO_BRIEF_LENGTH} characters; ` +
                'shorten it to a single-line headline. Put the detail in `content` instead.',
            );
        }

        const content = entry['content'];
        if (typeof content !== 'string' || !content.trim()) {
            return errorResult(
                `items[${i}].content must be a non-empty string. ` +
                "It's the machine-facing task spec you'll re-read when working on this item " +
                '(what to do, where, success criteria).',
            );
        }
        if (content.length > MAX_TODO_CONTENT_LENGTH) {
            return errorResult(
                `items[${i}].content exceeds ${MAX_TODO_CONTENT_LENGTH} characters; ` +
                'shorten the description or split the subtask.',
            );
        }

        let status: TodoStatus = 'pending';
        if (entry['status'] !== undefined) {
            const s = entry['status'];
            if (!isTodoStatus(s)) {
                return errorResult(
                    `items[${i}].status must be one of 'pending', 'in_progress', 'completed', 'cancelled'.`,
                );
            }
            status = s;
        }

        normalised.push({
            id: trimmedId,
            brief: brief.trim(),
            content: content.trim(),
            status,
        });
    }

    const inProgress = normalised.filter(i => i.status === 'in_progress').length;
    const state = src.replaceAll(normalised);

    let summary = `Wrote ${normalised.length} todo${normalised.length === 1 ? '' : 's'}.`;
    if (inProgress > 1) {
        // Not a hard error — the next `update` can fix it — but flag so
        // the model self-corrects on the next turn.
        summary += ` Warning: ${inProgress} items are marked in_progress; keep at most one.`;
    }

    return okResult('write', summary, state);
}

function execUpdate(src: TodoStateSource, args: Record<string, unknown>): ToolCallResult {
    const rawId = args['id'];
    if (typeof rawId !== 'string' || !rawId.trim()) {
        return errorResult("`id` is required for action='update' and must be a non-empty string.");
    }
    const id = rawId.trim();

    const patch: Partial<Pick<TodoItem, 'status' | 'brief' | 'content'>> = {};
    let hasPatch = false;

    if (args['status'] !== undefined) {
        if (!isTodoStatus(args['status'])) {
            return errorResult(
                "`status` must be one of 'pending', 'in_progress', 'completed', 'cancelled'.",
            );
        }
        patch.status = args['status'];
        hasPatch = true;
    }

    if (args['brief'] !== undefined) {
        const b = args['brief'];
        if (typeof b !== 'string' || !b.trim()) {
            return errorResult(
                '`brief` must be a non-empty string when provided. ' +
                "To stop showing a custom summary, you can't — `brief` is required. " +
                'Pass a refreshed summary instead.',
            );
        }
        if (b.length > MAX_TODO_BRIEF_LENGTH) {
            return errorResult(
                `\`brief\` exceeds ${MAX_TODO_BRIEF_LENGTH} characters; ` +
                'keep it to a single-line headline (put detail in `content`).',
            );
        }
        patch.brief = b.trim();
        hasPatch = true;
    }

    if (args['content'] !== undefined) {
        const c = args['content'];
        if (typeof c !== 'string' || !c.trim()) {
            return errorResult('`content` must be a non-empty string when provided.');
        }
        if (c.length > MAX_TODO_CONTENT_LENGTH) {
            return errorResult(
                `\`content\` exceeds ${MAX_TODO_CONTENT_LENGTH} characters; shorten or split.`,
            );
        }
        patch.content = c.trim();
        hasPatch = true;
    }

    if (!hasPatch) {
        return errorResult(
            "action='update' needs at least one of `status`, `brief`, `content`.",
        );
    }

    const state = src.update(id, patch);
    if (state === null) {
        const current = src.get();
        return errorResult(
            `No TODO item with id "${id}". Existing ids: ${JSON.stringify(current.items.map(i => i.id))}.`,
        );
    }

    const target = state.items.find(i => i.id === id)!;
    const summary = `Updated "${id}" to status "${target.status}".`;
    return okResult('update', summary, state);
}

function execList(src: TodoStateSource): ToolCallResult {
    const state = src.get();
    const summary = state.items.length === 0
        ? 'TODO list is empty.'
        : `${state.items.length} todo${state.items.length === 1 ? '' : 's'} on file.`;
    return okResult('list', summary, state);
}

function execClear(src: TodoStateSource): ToolCallResult {
    const had = src.get().items.length;
    const state = src.clear();
    const summary = had === 0
        ? 'TODO list was already empty.'
        : `Cleared ${had} todo${had === 1 ? '' : 's'}.`;
    return okResult('clear', summary, state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isTodoStatus(value: unknown): value is TodoStatus {
    return value === 'pending'
        || value === 'in_progress'
        || value === 'completed'
        || value === 'cancelled';
}

/**
 * Build the standard structured response: a compact summary line for
 * the model's own narration plus a projection of the current list.
 *
 * Projection rules — designed to keep the per-call payload bounded
 * even on long, mature plans where many items are already done:
 *
 * - `write`  → ALWAYS returns every item in full. The model just
 *              authored these and wants confirmation that what
 *              landed matches what it sent (sanity check, especially
 *              for trimming / normalisation).
 * - `update` → tiered by per-item status (see below). The model just
 *              touched ONE item; the rest are read for orientation,
 *              not re-execution.
 * - `list`   → tiered by per-item status. Same rationale as update —
 *              this is a re-sync, not a "give me everything".
 * - `clear`  → empty payload (no items).
 *
 * Tiering rule (used by both `update` and `list`):
 * - `pending` / `in_progress`: full `{id, brief, content, status}`.
 *   These are the only items the model still has work to do on; it
 *   needs `content` to execute.
 * - `completed` / `cancelled`: lean `{id, brief, status}` only.
 *   Their `content` is historical — the original `write` /
 *   `update` tool result still carries it in the conversation
 *   history, and the model has already moved on. Re-injecting it on
 *   every subsequent call is pure noise that grows linearly with
 *   completed count.
 *
 * Net effect: a 30-step plan that's 25 done shrinks from ~15 KB to
 * ~5 KB per `update` / `list` call (~67 % reduction). At task start
 * (all pending) the payload is unchanged. The optimisation kicks in
 * exactly when long-task context pressure starts to bite.
 */
function okResult(action: 'write' | 'update' | 'list' | 'clear', summary: string, state: TodoState): ToolCallResult {
    const verbose = action === 'write';
    return {
        success: true,
        type: 'object',
        content: {
            ok: true,
            action,
            summary,
            todos: state.items.map(item => projectItem(item, verbose)),
        },
    };
}

/**
 * Project a single TODO item into its tool-result shape. When
 * `forceFull` is true (e.g. `write` action) every field is included
 * regardless of status; otherwise the status-based tiering rule from
 * {@link okResult} applies.
 */
function projectItem(
    item: TodoItem,
    forceFull: boolean,
): { id: string; brief: string; status: TodoStatus; content?: string } {
    const isActive = item.status === 'pending' || item.status === 'in_progress';
    const base = { id: item.id, brief: item.brief, status: item.status };
    if (forceFull || isActive) {
        return { ...base, content: item.content };
    }
    return base;
}

function errorResult(message: string): ToolCallResult {
    return {
        success: false,
        type: 'text',
        content: `Error: ${message}`,
    };
}

// Re-export for the test surface and consumers that build a source
// without going through the runtime (e.g. the runtime factory).
export { emptyTodoState };
