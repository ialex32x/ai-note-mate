/**
 * handoff-toolcall.ts
 *
 * Built-in tools that give a sub-agent a small, in-process key/value store
 * shared with its dispatcher (the main agent's orchestrator). The
 * sub-agent uses it to RECEIVE seed inputs from the main agent
 * (`read_handoff` / `list_handoff`) and to RETURN structured data
 * alongside its final text reply (`write_handoff`), so the main agent
 * can consume the result programmatically instead of re-parsing the
 * sub-agent's prose.
 *
 * The store models the BATON in a handoff:
 *   main agent --[delegate_task with seed]--> sub-agent
 *   sub-agent --[write_handoff(key="result", ...)]--> main agent
 *
 * One channel, two directions, per-dispatch lifecycle — created by the
 * orchestrator before `execute()`, snapshotted at completion, then
 * discarded. Nothing is global.
 *
 * Historical note: these three tools used to be a single multiplexed
 * `exchange({op: 'put' | 'get' | 'list', ...})` tool. The `op`-as-
 * parameter design suffered from a stubborn class of LLM mistakes
 * where models would invent OOP-style calls (`exchange.put(...)`) or
 * omit `op` entirely because the tool name itself was a noun ("the
 * exchange"), not an action. Splitting into three verb-named tools
 * aligned with the broader `verb_noun` tool naming used throughout
 * the project (`read_file`, `write_file`, `grep_file`, ...) and
 * eliminated that whole error mode.
 *
 * Convention (documented in prompts, NOT enforced in code):
 * - `result` — the canonical structured return value the main agent
 *   consumes automatically.
 * - any other key — auxiliary payload (`candidates`, `warnings`,
 *   `debug`, ...).
 *
 * Values must be JSON-serializable: string / number / boolean / null /
 * plain array / plain object. Functions, class instances, circular
 * refs, `Date`, `Map`, `Set`, `BigInt` are rejected at `write` time so
 * the model gets an immediate, actionable error.
 *
 * The tools are registered ONLY on sub-agents (the main agent never
 * reads or writes the store directly; the orchestrator handles main-
 * side access).
 */

import type { RegisteredTool, ToolCallResult } from "../chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-dispatch key/value store. Created and owned by the orchestrator. */
export type HandoffStore = Map<string, unknown>;

/**
 * The handoff tools may be registered ONCE on a long-lived ChatStream
 * that is reused across multiple `execute()` calls (each with its own
 * store). To support that, the factory accepts either a direct store
 * or a getter that resolves the *current* store at call-time. When the
 * getter returns `null`, the tools report a clear error to the model
 * instead of crashing.
 */
export type HandoffStoreSource = HandoffStore | (() => HandoffStore | null);

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns `null` if `value` is a safe JSON-serializable structure
 * (string / number / boolean / null / plain array / plain object, transitively).
 * Otherwise returns a short human-readable reason describing the first
 * problematic node. Catches `Date`/`Map`/`Set`/`BigInt`/functions/symbols/
 * class instances/circular references — all of which either throw or quietly
 * lose information when round-tripping through `JSON.stringify`.
 *
 * Exported for unit testing.
 */
export function validateSerializable(value: unknown): string | null {
    const seen = new WeakSet<object>();

    function walk(v: unknown, path: string): string | null {
        // Primitives that are safe.
        if (v === null) return null;
        const t = typeof v;
        if (t === "string" || t === "boolean") return null;
        if (t === "number") {
            // NaN / Infinity stringify to `null` and silently lose info.
            if (!Number.isFinite(v as number)) {
                return `non-finite number at ${path}`;
            }
            return null;
        }

        if (t === "undefined") {
            // `undefined` becomes `null` inside arrays and gets dropped from
            // objects. Either way it loses information; reject it.
            return `undefined at ${path}`;
        }
        if (t === "bigint") return `BigInt at ${path}`;
        if (t === "function") return `function at ${path}`;
        if (t === "symbol") return `symbol at ${path}`;

        // From here on, `v` is an object.
        if (typeof v !== "object" || v === null) {
            return `unsupported value at ${path}`;
        }

        if (seen.has(v)) {
            return `circular reference at ${path}`;
        }
        seen.add(v);

        // Reject non-plain objects whose JSON form would lose information.
        if (v instanceof Date) return `Date at ${path}`;
        if (v instanceof Map) return `Map at ${path}`;
        if (v instanceof Set) return `Set at ${path}`;
        if (v instanceof RegExp) return `RegExp at ${path}`;
        if (v instanceof Error) return `Error at ${path}`;
        if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
            return `binary buffer at ${path}`;
        }

        if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
                const reason = walk(v[i], `${path}[${i}]`);
                if (reason) return reason;
            }
            return null;
        }

        // Plain objects only. Reject anything with a non-trivial prototype
        // (class instances etc.), since their non-enumerable properties /
        // methods will silently disappear after JSON round-trip.
        const proto: object | null = Object.getPrototypeOf(v) as object | null;
        if (proto !== null && proto !== Object.prototype) {
            return `non-plain object at ${path}`;
        }

        for (const key of Object.keys(v as Record<string, unknown>)) {
            const reason = walk(
                (v as Record<string, unknown>)[key],
                path === "" ? key : `${path}.${key}`,
            );
            if (reason) return reason;
        }
        return null;
    }

    return walk(value, "");
}

/**
 * Cheap byte-length estimate for a stored value, used by `list_handoff`
 * and by the orchestrator's per-key size guard. UTF-8 size is
 * approximated via `JSON.stringify(...).length`, which is good enough
 * for guardrails and cheap enough to run on every write.
 *
 * Exported for unit testing and for the orchestrator to reuse the same
 * accounting it would see in `list_handoff`.
 */
export function estimateValueSize(value: unknown): number {
    try {
        return JSON.stringify(value).length;
    } catch {
        return 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────────

const WRITE_TOOL_NAME = "write_handoff";
const READ_TOOL_NAME = "read_handoff";
const LIST_TOOL_NAME = "list_handoff";

/**
 * Upper bound on `keys.length` for a batch `read_handoff`. The store is
 * sized for a handful of dispatch inputs (paths, focus strings, rule
 * objects); a batch larger than this is almost certainly a model bug
 * and would also inflate the tool_result payload past what a single
 * LLM turn should absorb. 32 is comfortably above the real-world
 * maximum we observe in the prompts (≤ 5 input keys) while still being
 * a recognisable round cap if a model ever brushes against it.
 */
const READ_KEYS_HARD_LIMIT = 32;

const WRITE_TOOL_DESCRIPTION =
    "Hand off a structured value to the main agent through the per-dispatch handoff store. " +
    "After completing your task, call write_handoff({key:'result', value:<your structured result>}) " +
    "BEFORE producing your final text reply — the main agent reads `result` programmatically, " +
    "not your prose. Use other key names for auxiliary payload (warnings, candidates, debug info). " +
    "Values must be JSON-serializable (string, number, boolean, null, plain array, or plain object). " +
    "Functions, Date, Map, Set, BigInt, and class instances are not allowed.";

const READ_TOOL_DESCRIPTION =
    "Read seed values the main agent handed off to you for this dispatch. Your task prose " +
    "names the keys you should expect (e.g. \"the `path` key\", \"the `query` key\"); those " +
    "are the BARE key names, with no `inputs.` / `exchange.` / dotted prefix. " +
    "PREFER a single batch read — read_handoff({keys:['k1','k2',...]}) — over multiple " +
    "single-key calls, because each separate call costs an extra LLM round-trip. Use " +
    "read_handoff({key:'...'}) only when you genuinely need exactly one value.";

const LIST_TOOL_DESCRIPTION =
    "Enumerate the keys currently in the per-dispatch handoff store, with approximate sizes. " +
    "Fallback for the rare case where you suspect the main agent has pre-loaded keys not " +
    "in your sub-agent's expected set. In normal operation your workflow's expected key " +
    "set is authoritative — use read_handoff with explicit keys instead.";

/**
 * Build the three handoff tools (`write_handoff`, `read_handoff`,
 * `list_handoff`) bound to a shared store source.
 *
 * Returned as a tuple so callers can register all three in one
 * destructured statement without depending on a particular field name.
 *
 * @param source either a `HandoffStore` (when the tools are registered
 *   for a single execution) or a getter `() => HandoffStore | null`
 *   (when the tools are registered once on a long-lived ChatStream
 *   that is reused across many executions, each with its own store).
 */
export function createHandoffTools(
    source: HandoffStoreSource,
): readonly [RegisteredTool, RegisteredTool, RegisteredTool] {
    const resolveStore = typeof source === "function"
        ? source
        : () => source;

    // ALWAYS-ON: these are control-plane tools, not content tools.
    //
    // We previously had `ondemand: true` on the multiplexed `exchange`
    // tool, relying on the embedding-based tool filter to surface it
    // only when the model's query was topically similar to the
    // description. That was wrong for two independent reasons that
    // compounded into a hard bug:
    //
    //   1) The description is generic ("read/write a key-value store"),
    //      so its embedding score against typical sub-agent prompts
    //      ("read this file", "search for X") is low — and it kept
    //      being dropped from `filteredTools`.
    //   2) Sub-agents have *no* `onToolCall` fallback wired into their
    //      ChatStream. When the model called the tool from system-
    //      prompt memory after the filter had dropped it, the dispatch
    //      loop in chat-stream.ts threw an "unhandled tool" error
    //      mid-turn, leaving the tool_call bubble visibly stuck at `…`
    //      forever (the `_finalizeStuckToolCallMessages` safety net
    //      now catches this and logs a console.warn, but the
    //      underlying gap is here).
    //
    // The whole point of every sub-agent's `execute()` is to RETURN
    // STRUCTURED DATA via these tools — see `sub-agent-prompts.ts` —
    // so they must be visible on every single turn, regardless of how
    // the conversation has drifted topically. The schemas are small
    // so the token cost of having them always on is negligible
    // compared to the cost of silently dropping the agent's only
    // structured-return channel.
    const writeTool: RegisteredTool = {
        ondemand: false,
        capabilities: [],
        requiresConfirmation: false,
        schema: {
            type: "function",
            function: {
                name: WRITE_TOOL_NAME,
                description: WRITE_TOOL_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "Key name. Use 'result' for the canonical structured return " +
                                "value the main agent consumes automatically; use other names " +
                                "for auxiliary payload (warnings, candidates, debug info).",
                        },
                        value: {
                            description:
                                "Value to hand off. Must be JSON-serializable: string, " +
                                "number (finite), boolean, null, plain array, or plain object. " +
                                "Disallowed: undefined, NaN/Infinity, BigInt, function, symbol, " +
                                "Date, Map, Set, RegExp, Error, binary buffers, class instances, " +
                                "circular references.",
                        },
                    },
                    required: ["key", "value"],
                },
            },
        },
        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const store = resolveStore();
            if (!store) return noStoreError(WRITE_TOOL_NAME);
            return execWrite(store, args);
        },
    };

    const readTool: RegisteredTool = {
        ondemand: false,
        capabilities: [],
        requiresConfirmation: false,
        schema: {
            type: "function",
            function: {
                name: READ_TOOL_NAME,
                description: READ_TOOL_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "Single key name to read. Mutually exclusive with `keys`. " +
                                "Use 'keys: [...]' instead to fetch several values in one call.",
                        },
                        keys: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Multiple keys to fetch in a single call (mutually exclusive " +
                                `with \`key\`). Up to ${READ_KEYS_HARD_LIMIT} keys. ` +
                                "Returns `{values: {k1: v1, ...}, missing: [<keys not in store>]}`. " +
                                "PREFER this over calling read_handoff one key at a time when you " +
                                "need several seeded inputs — each separate tool call costs an " +
                                "extra LLM round-trip.",
                        },
                    },
                    required: [],
                },
            },
        },
        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const store = resolveStore();
            if (!store) return noStoreError(READ_TOOL_NAME);
            return execRead(store, args);
        },
    };

    const listTool: RegisteredTool = {
        ondemand: false,
        capabilities: [],
        requiresConfirmation: false,
        schema: {
            type: "function",
            function: {
                name: LIST_TOOL_NAME,
                description: LIST_TOOL_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {},
                    required: [],
                },
            },
        },
        exec: async (_chatStream, _args): Promise<ToolCallResult> => {
            const store = resolveStore();
            if (!store) return noStoreError(LIST_TOOL_NAME);
            return execList(store);
        },
    };

    return [writeTool, readTool, listTool] as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// Op handlers
// ─────────────────────────────────────────────────────────────────────────────

function execWrite(store: HandoffStore, args: Record<string, unknown>): ToolCallResult {
    const key = args["key"];
    if (typeof key !== "string" || !key.trim()) {
        return errorResult("`key` is required for write_handoff and must be a non-empty string.");
    }
    if (!("value" in args)) {
        return errorResult(
            "`value` is required for write_handoff. " +
            "Pass the structured value you want the main agent to receive.",
        );
    }

    const value = args["value"];
    const reason = validateSerializable(value);
    if (reason) {
        return errorResult(
            `\`value\` is not JSON-serializable: ${reason}. ` +
            "Allowed: string, number (finite), boolean, null, plain array, plain object. " +
            "Disallowed: undefined, NaN/Infinity, BigInt, function, symbol, Date, Map, Set, " +
            "RegExp, Error, binary buffers, class instances, circular references.",
        );
    }

    store.set(key.trim(), value);
    return {
        success: true,
        type: "object",
        content: { ok: true, key: key.trim() },
    };
}

/**
 * Dispatch entry for read_handoff. Accepts either a single `key` or a
 * `keys` array (mutually exclusive). The branch is selected by which
 * argument is present; this keeps the JSON schema flat (no `oneOf`
 * polymorphism that weaker models struggle to parse) and the response
 * shape diverges by branch so the model never has to guess what came
 * back.
 */
function execRead(store: HandoffStore, args: Record<string, unknown>): ToolCallResult {
    const hasKey = "key" in args && args["key"] !== undefined;
    const hasKeys = "keys" in args && args["keys"] !== undefined;

    if (hasKey && hasKeys) {
        return errorResult(
            "Provide either `key` (single lookup) OR `keys` (batch lookup) for read_handoff, not both.",
        );
    }
    if (!hasKey && !hasKeys) {
        return errorResult(
            "read_handoff requires either `key` (single lookup) or `keys` (batch lookup). " +
            "For a no-arg discovery, use list_handoff instead.",
        );
    }

    if (hasKeys) {
        return execReadBatch(store, args["keys"]);
    }

    return execReadSingle(store, args);
}

function execReadSingle(store: HandoffStore, args: Record<string, unknown>): ToolCallResult {
    const key = args["key"];
    if (typeof key !== "string" || !key.trim()) {
        return errorResult(
            "`key` must be a non-empty string. " +
            "Use `keys: [...]` instead to fetch several values in one call.",
        );
    }

    const trimmed = key.trim();
    if (!store.has(trimmed)) {
        return {
            success: true,
            type: "object",
            content: {
                value: null,
                missing: true,
                available_keys: Array.from(store.keys()),
            },
        };
    }

    return {
        success: true,
        type: "object",
        content: { value: store.get(trimmed) },
    };
}

/**
 * Batch lookup. Returns the values for every requested key that exists,
 * plus a `missing` array listing keys that were not in the store (empty
 * when every requested key was found). `available_keys` is attached
 * ONLY when at least one key is missing, mirroring the single-key path
 * so the model gets a corrective hint exactly when it would help.
 *
 * Keys are trimmed and deduplicated; the response uses the trimmed form
 * so the caller can reliably index into `values`.
 */
function execReadBatch(store: HandoffStore, rawKeys: unknown): ToolCallResult {
    if (!Array.isArray(rawKeys)) {
        return errorResult("`keys` must be an array of non-empty strings.");
    }
    if (rawKeys.length === 0) {
        return errorResult(
            "`keys` must contain at least one entry. " +
            "For a no-arg discovery, use list_handoff instead.",
        );
    }
    if (rawKeys.length > READ_KEYS_HARD_LIMIT) {
        return errorResult(
            `Too many keys (${rawKeys.length}); maximum is ${READ_KEYS_HARD_LIMIT}. ` +
            "Split into multiple calls or narrow the request.",
        );
    }

    const seen = new Set<string>();
    const requested: string[] = [];
    // Treat the narrowed array as `unknown[]` rather than `any[]`
    // (Array.isArray narrows to `any[]`, which would let non-string
    // entries through the `typeof` guard at compile time).
    const items: readonly unknown[] = rawKeys as readonly unknown[];
    for (let i = 0; i < items.length; i++) {
        const raw: unknown = items[i];
        if (typeof raw !== "string") {
            return errorResult(`keys[${i}] must be a string; got ${typeof raw}.`);
        }
        const trimmed = raw.trim();
        if (!trimmed) {
            return errorResult(`keys[${i}] is empty or whitespace-only.`);
        }
        if (!seen.has(trimmed)) {
            seen.add(trimmed);
            requested.push(trimmed);
        }
    }

    const values: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const k of requested) {
        if (store.has(k)) {
            values[k] = store.get(k);
        } else {
            missing.push(k);
        }
    }

    const content: Record<string, unknown> = { values, missing };
    if (missing.length > 0) {
        content["available_keys"] = Array.from(store.keys());
    }
    return {
        success: true,
        type: "object",
        content,
    };
}

function execList(store: HandoffStore): ToolCallResult {
    const keys: string[] = [];
    const sizes: Record<string, number> = {};
    let total = 0;
    for (const [k, v] of store.entries()) {
        keys.push(k);
        const size = estimateValueSize(v);
        sizes[k] = size;
        total += size;
    }
    return {
        success: true,
        type: "object",
        content: {
            keys,
            sizes,
            total_size: total,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function noStoreError(toolName: string): ToolCallResult {
    // Should never happen in practice; means the tool was kept
    // registered after the dispatch ended. Fail loudly so the bug
    // is visible.
    return errorResult(
        `${toolName} called outside an active task. ` +
        "This is an internal bug; the handoff channel is not available right now.",
    );
}

function errorResult(message: string): ToolCallResult {
    return {
        success: false,
        type: "text",
        content: `Error: ${message}`,
    };
}
