/**
 * handoff-toolcall.ts
 *
 * Built-in tools that give a sub-agent access to two in-process key/value
 * stores shared with its dispatcher (the main agent's orchestrator):
 *
 *   SEED store (read_handoff / list_handoff):
 *     The main agent pre-loads data via `delegate_task`'s `handoff` arg.
 *     The sub-agent reads it at the start of its turn. Read-only from the
 *     sub-agent's perspective; the orchestrator owns the seed lifecycle.
 *
 *   RESULT store (write_result / write_result_array / write_result_object):
 *     The sub-agent writes structured output here BEFORE its final text
 *     reply. The orchestrator reads this store after completion and
 *     assembles the delegate envelope. Write-only from the sub-agent's
 *     perspective.
 *
 * Two separate maps — no shared namespace, no key collision between
 * seed and result. The per-dispatch lifecycle is the same: both stores
 * are created by the orchestrator before `execute()`, snapshotted at
 * completion, then discarded. Nothing is global.
 *
 * Why split from the old `write_handoff` (which accepted any JSON value):
 *   Models frequently fail to produce correctly-nested complex JSON
 *   objects inside a function-call argument. Splitting value-type
 *   constraints across three tools (`write_result` for scalars,
 *   `write_result_array` for arrays, `write_result_object` for flat
 *   objects) lets the model build structured returns from small,
 *   independently correct pieces instead of one fragile nested whole.
 *
 * Historical note: these tools used to be a single multiplexed
 * `exchange({op: 'put' | 'get' | 'list', ...})` tool. That was split
 * into three verb-named tools to eliminate LLM mistakes. Now the write
 * side is further split by value type so the schema constraint itself
 * prevents nesting — the model simply cannot put an object into
 * `write_result`, so it must use `write_result_object` instead.
 *
 * All tools are registered ONLY on sub-agents (the main agent never
 * reads or writes either store directly; the orchestrator handles
 * main-side access).
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

/**
 * The RESULT store is semantically identical to `HandoffStore` but
 * carries output data (sub → main direction). Defined as a separate
 * type for clarity — the seed store and result store MUST be distinct
 * `Map` instances with no shared namespace.
 */
export type ResultStore = HandoffStore;
export type ResultStoreSource = HandoffStoreSource;

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
// Tool factories
// ─────────────────────────────────────────────────────────────────────────────

const READ_TOOL_NAME = "read_handoff";
const LIST_TOOL_NAME = "list_handoff";

const WRITE_SCALAR_TOOL_NAME = "write_result";
const WRITE_ARRAY_TOOL_NAME = "write_result_array";
const WRITE_OBJECT_TOOL_NAME = "write_result_object";

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

const READ_TOOL_DESCRIPTION =
    "Read seed values the main agent handed off to you for this dispatch. Your task prose " +
    "names the keys you should expect (e.g. \"the `path` key\", \"the `query` key\"); those " +
    "are the BARE key names, with no `inputs.` / `exchange.` / dotted prefix. " +
    "PREFER a single batch read — read_handoff({keys:['k1','k2',...]}) — over multiple " +
    "single-key calls, because each separate call costs an extra LLM round-trip. Use " +
    "read_handoff({key:'...'}) only when you genuinely need exactly one value.";

const LIST_TOOL_DESCRIPTION =
    "Enumerate the keys currently in the per-dispatch seed store, with approximate sizes. " +
    "Fallback for the rare case where you suspect the main agent has pre-loaded keys not " +
    "in your sub-agent's expected set. In normal operation your workflow's expected key " +
    "set is authoritative — use read_handoff with explicit keys instead.";

const WRITE_SCALAR_DESCRIPTION =
    "Write a scalar result value (string, number, boolean, or null) to the result store. " +
    "After completing your task, call the write_result tools BEFORE producing your final " +
    "text reply — the main agent reads the result store programmatically, not your prose. " +
    "Use write_result for simple scalar values (paths, counts, flags). " +
    "For arrays use write_result_array. For structured objects use write_result_object.";

const WRITE_ARRAY_DESCRIPTION =
    "Write an array to the result store. Use this for list values like warnings, " +
    "candidate paths, or matched items. The array elements must be JSON-serializable. " +
    "For simple scalar values use write_result. For structured objects use write_result_object.";

const WRITE_OBJECT_DESCRIPTION =
    "Write a structured object to the result store. Use this when you need to return " +
    "multiple related fields together (e.g. a diff sample with before_excerpt and " +
    "after_excerpt). The object values must be JSON-serializable. IMPORTANT: prefer " +
    "using multiple write_result calls for individual scalar fields (path, strategy, " +
    "edits_applied) rather than packing everything into one object — the main agent " +
    "assembles all result-store entries into a single structured return. Reserve " +
    "write_result_object for when several fields truly belong together as one unit.";

/**
 * Build the two READ-SIDE handoff tools (`read_handoff`, `list_handoff`)
 * bound to a seed store source.
 *
 * These give the sub-agent access to data the main agent pre-loaded via
 * `delegate_task`'s `handoff` argument. The tools are always-on
 * (`ondemand: false`) because the whole point of a sub-agent is to
 * consume structured inputs and return structured outputs — they must
 * be visible on every turn regardless of topical drift.
 *
 * @param source either a `HandoffStore` or a getter `() => HandoffStore | null`
 *   (when the tools are registered once on a long-lived ChatStream).
 */
export function createHandoffTools(
    source: HandoffStoreSource,
): readonly [RegisteredTool, RegisteredTool] {
    const resolveStore = typeof source === "function"
        ? source
        : () => source;

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

    return [readTool, listTool] as const;
}

/**
 * Build the three WRITE-SIDE result tools (`write_result`,
 * `write_result_array`, `write_result_object`) bound to a result
 * store source.
 *
 * The sub-agent writes structured output into the result store BEFORE
 * its final text reply. The orchestrator reads this store after
 * completion to assemble the delegate envelope. The three tools differ
 * ONLY in what value type they accept:
 *
 *   - `write_result`: scalar (string / number / boolean / null)
 *   - `write_result_array`: array
 *   - `write_result_object`: plain object
 *
 * This split is intentional: by constraining the value type at the
 * schema level, we prevent the model from constructing deeply nested
 * JSON inside a single function-call argument — the primary failure
 * mode of the old `write_handoff`. Instead the model builds structured
 * returns from small, independently correct pieces.
 *
 * @param source either a `HandoffStore` or a getter `() => HandoffStore | null`.
 */
export function createResultTools(
    source: ResultStoreSource,
): readonly [RegisteredTool, RegisteredTool, RegisteredTool] {
    const resolveStore = typeof source === "function"
        ? source
        : () => source;

    // ALWAYS-ON: these are control-plane tools. See rationale in
    // `createHandoffTools` — the same logic applies: every sub-agent
    // must return structured data.
    const writeScalarTool: RegisteredTool = {
        ondemand: false,
        capabilities: [],
        requiresConfirmation: false,
        schema: {
            type: "function",
            function: {
                name: WRITE_SCALAR_TOOL_NAME,
                description: WRITE_SCALAR_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "Key name for this result entry. Use descriptive names " +
                                "(path, strategy, edits_applied, focus, count, etc.). " +
                                "The main agent receives all result-store entries as a " +
                                "single assembled object.",
                        },
                        value: {
                            type: ["string", "number", "boolean", "null"],
                            description:
                                "Scalar value. Accepts only string, number (finite), " +
                                "boolean, or null. For arrays use write_result_array. " +
                                "For objects use write_result_object.",
                        },
                    },
                    required: ["key", "value"],
                },
            },
        },
        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const store = resolveStore();
            if (!store) return noStoreError(WRITE_SCALAR_TOOL_NAME);
            return execWriteScalar(store, args);
        },
    };

    const writeArrayTool: RegisteredTool = {
        ondemand: false,
        capabilities: [],
        requiresConfirmation: false,
        schema: {
            type: "function",
            function: {
                name: WRITE_ARRAY_TOOL_NAME,
                description: WRITE_ARRAY_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description: "Key name for this result entry.",
                        },
                        value: {
                            type: "array",
                            description:
                                "Array value. Elements must be JSON-serializable. " +
                                "For scalar values use write_result. " +
                                "For objects use write_result_object.",
                        },
                    },
                    required: ["key", "value"],
                },
            },
        },
        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const store = resolveStore();
            if (!store) return noStoreError(WRITE_ARRAY_TOOL_NAME);
            return execWriteArray(store, args);
        },
    };

    const writeObjectTool: RegisteredTool = {
        ondemand: false,
        capabilities: [],
        requiresConfirmation: false,
        schema: {
            type: "function",
            function: {
                name: WRITE_OBJECT_TOOL_NAME,
                description: WRITE_OBJECT_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description: "Key name for this result entry.",
                        },
                        value: {
                            type: "object",
                            description:
                                "Structured object value (plain object, values must be " +
                                "JSON-serializable). PREFER using multiple write_result " +
                                "calls for individual scalar fields instead of packing " +
                                "everything into one object. Reserve this tool for when " +
                                "several fields truly belong together as one unit (e.g. " +
                                "a diff sample containing before_excerpt and after_excerpt).",
                        },
                    },
                    required: ["key", "value"],
                },
            },
        },
        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const store = resolveStore();
            if (!store) return noStoreError(WRITE_OBJECT_TOOL_NAME);
            return execWriteObject(store, args);
        },
    };

    return [writeScalarTool, writeArrayTool, writeObjectTool] as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// Op handlers — result (write) side
//
// Auto-dispatch: each handler silently delegates to the correct variant when
// the LLM passes a value whose runtime type doesn't match the tool's declared
// schema. This makes the type-split transparent — the model can call ANY
// write_result* tool with ANY value and it will just work. Rationale: LLMs
// are bad at pre-call type-checking (they think "store items=[1,2,3]" not
// "is [1,2,3] an array? then call write_result_array"), and a rejected call
// costs a full API round-trip for the model to read the error and retry.
// ─────────────────────────────────────────────────────────────────────────────

function execWriteScalar(store: HandoffStore, args: Record<string, unknown>): ToolCallResult {
    const key = args["key"];
    if (typeof key !== "string" || !key.trim()) {
        return errorResult("`key` is required for write_result and must be a non-empty string.");
    }
    if (!("value" in args)) {
        return errorResult("`value` is required for write_result.");
    }

    const value = args["value"];

    // Auto-dispatch: route to the correct handler based on runtime type.
    if (Array.isArray(value)) {
        return execWriteArray(store, args);
    }
    if (value !== null && typeof value === "object") {
        return execWriteObject(store, args);
    }

    const t = typeof value;
    if (t === "string" || t === "boolean") {
        store.set(key.trim(), value);
        return { success: true, type: "object", content: { ok: true, key: key.trim() } };
    }
    if (t === "number") {
        if (!Number.isFinite(value as number)) {
            return errorResult("write_result does not accept NaN or Infinity.");
        }
        store.set(key.trim(), value);
        return { success: true, type: "object", content: { ok: true, key: key.trim() } };
    }
    if (value === null) {
        store.set(key.trim(), null);
        return { success: true, type: "object", content: { ok: true, key: key.trim() } };
    }

    return errorResult(
        `write_result cannot store values of type ${t}. ` +
        `Allowed: string, number (finite), boolean, null, plain array, plain object.`,
    );
}

function execWriteArray(store: HandoffStore, args: Record<string, unknown>): ToolCallResult {
    const key = args["key"];
    if (typeof key !== "string" || !key.trim()) {
        return errorResult("`key` is required for write_result_array and must be a non-empty string.");
    }
    if (!("value" in args)) {
        return errorResult("`value` is required for write_result_array.");
    }

    const value = args["value"];

    // Auto-dispatch: route to the correct handler based on runtime type.
    if (!Array.isArray(value)) {
        // Best-effort JSON string deserialization: LLMs sometimes pass
        // serialized JSON strings instead of native objects/arrays in
        // function-call arguments (e.g. write_result_array({ value: "[1,2]" })).
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
                try {
                    const parsed: unknown = JSON.parse(trimmed) as unknown;
                    if (Array.isArray(parsed)) {
                        return execWriteArray(store, { ...args, value: parsed });
                    }
                } catch { /* not valid JSON — fall through to type dispatch */ }
            }
        }
        if (value !== null && typeof value === "object") {
            return execWriteObject(store, args);
        }
        return execWriteScalar(store, args);
    }

    const reason = validateSerializable(value);
    if (reason) {
        return errorResult(
            `Array is not JSON-serializable: ${reason}. ` +
            "Allowed: string, number (finite), boolean, null, plain array, plain object. " +
            "Disallowed: undefined, NaN/Infinity, BigInt, function, symbol, Date, Map, Set, " +
            "RegExp, Error, binary buffers, class instances, circular references.",
        );
    }

    store.set(key.trim(), value);
    return { success: true, type: "object", content: { ok: true, key: key.trim() } };
}

function execWriteObject(store: HandoffStore, args: Record<string, unknown>): ToolCallResult {
    const key = args["key"];
    if (typeof key !== "string" || !key.trim()) {
        return errorResult("`key` is required for write_result_object and must be a non-empty string.");
    }
    if (!("value" in args)) {
        return errorResult("`value` is required for write_result_object.");
    }

    const value = args["value"];

    // Auto-dispatch: route to the correct handler based on runtime type.
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        // Best-effort JSON string deserialization: LLMs sometimes pass
        // serialized JSON strings (e.g. write_result_object({ value: "{\"a\":1}" })).
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                try {
                    const parsed: unknown = JSON.parse(trimmed) as unknown;
                    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                        return execWriteObject(store, { ...args, value: parsed });
                    }
                } catch { /* not valid JSON — fall through to type dispatch */ }
            }
        }
        if (Array.isArray(value)) {
            return execWriteArray(store, args);
        }
        return execWriteScalar(store, args);
    }

    const reason = validateSerializable(value);
    if (reason) {
        return errorResult(
            `Object is not JSON-serializable: ${reason}. ` +
            "Allowed: string, number (finite), boolean, null, plain array, plain object. " +
            "Disallowed: undefined, NaN/Infinity, BigInt, function, symbol, Date, Map, Set, " +
            "RegExp, Error, binary buffers, class instances, circular references.",
        );
    }

    store.set(key.trim(), value);
    return { success: true, type: "object", content: { ok: true, key: key.trim() } };
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
