/**
 * exchange-toolcall.ts
 *
 * Built-in tool that gives a sub-agent a small, in-process key/value store
 * shared with its dispatcher (the main agent's orchestrator). The sub-agent
 * uses it to return STRUCTURED data alongside its final text reply, so the
 * main agent can consume the result programmatically instead of re-parsing
 * the sub-agent's prose.
 *
 * Storage model: a single `Map<string, unknown>` per `delegate_task`
 * invocation. The dispatcher creates the map, hands it to the sub-agent,
 * snapshots it on completion, and discards it. Nothing is global.
 *
 * Convention (documented in prompts, NOT enforced in code):
 * - `result` — the canonical structured return value.
 * - any other key — auxiliary payload (`candidates`, `warnings`, `debug`, ...).
 *
 * Values must be JSON-serializable: string / number / boolean / null /
 * plain array / plain object. Functions, class instances, circular refs,
 * `Date`, `Map`, `Set`, `BigInt` are rejected at `put` time so the model
 * gets an immediate, actionable error.
 *
 * The tool is registered ONLY on sub-agents (the main agent never reads
 * or writes the store directly; the orchestrator handles main-side access).
 */

import type { RegisteredTool, ToolCallResult } from "../chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Per-dispatch key/value store. Created and owned by the orchestrator. */
export type ExchangeStore = Map<string, unknown>;

/**
 * The exchange tool may be registered ONCE on a long-lived ChatStream that is
 * reused across multiple `execute()` calls (each with its own store). To
 * support that, the factory accepts either a direct store or a getter that
 * resolves the *current* store at call-time. When the getter returns `null`,
 * the tool reports a clear error to the model instead of crashing.
 */
export type ExchangeStoreSource = ExchangeStore | (() => ExchangeStore | null);

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
        const proto = Object.getPrototypeOf(v);
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
 * Cheap byte-length estimate for a stored value, used by `list` and by the
 * orchestrator's per-key size guard. UTF-8 size is approximated via
 * `JSON.stringify(...).length`, which is good enough for guardrails and
 * cheap enough to run on every put.
 *
 * Exported for unit testing and for the orchestrator to reuse the same
 * accounting it would see in `list`.
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

const TOOL_NAME = "exchange";

const TOOL_DESCRIPTION =
    "Read or write a small structured key/value store shared with the calling main agent. " +
    "Use this to RETURN STRUCTURED DATA: after completing your task, call " +
    "exchange({op:'put', key:'result', value:<your structured result>}) BEFORE producing " +
    "your final text reply. The main agent will receive both your text reply and the " +
    "value(s) you stored here, so it can act on them programmatically without re-parsing " +
    "your prose. Values must be JSON-serializable (string, number, boolean, null, plain " +
    "array, or plain object). Functions, Date, Map, Set, BigInt, and class instances are " +
    "not allowed.";

/**
 * Build the `exchange` tool bound to the given store source.
 *
 * @param source either an `ExchangeStore` (when the tool is registered for a
 *   single execution) or a getter `() => ExchangeStore | null` (when the tool
 *   is registered once on a long-lived ChatStream that is reused across many
 *   executions, each with its own store).
 */
export function createExchangeTool(source: ExchangeStoreSource): RegisteredTool {
    const resolveStore = typeof source === "function"
        ? source
        : () => source;

    return {
        // Only invoked when the model decides it needs to read/write structured
        // payload. Not relevant to every turn.
        ondemand: true,

        // Purely in-memory data routing — no vault, no network, no execution.
        capabilities: [],
        requiresConfirmation: false,

        schema: {
            type: "function",
            function: {
                name: TOOL_NAME,
                description: TOOL_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        op: {
                            type: "string",
                            enum: ["put", "get", "list"],
                            description:
                                "Operation: 'put' stores a value under a key, " +
                                "'get' retrieves a value by key, " +
                                "'list' enumerates all keys with their approximate sizes.",
                        },
                        key: {
                            type: "string",
                            description:
                                "Key name. Required for 'put' and 'get'. " +
                                "Use 'result' for the canonical structured return value.",
                        },
                        value: {
                            description:
                                "Value to store. Required for 'put'. " +
                                "Must be JSON-serializable (string, number, boolean, " +
                                "null, plain array, or plain object).",
                        },
                    },
                    required: ["op"],
                },
            },
        },

        exec: async (_chatStream, args): Promise<ToolCallResult> => {
            const op = args["op"];

            if (typeof op !== "string") {
                return errorResult("`op` is required and must be one of 'put', 'get', 'list'.");
            }

            const store = resolveStore();
            if (!store) {
                // Should never happen in practice; means the tool was kept
                // registered after the dispatch ended. Fail loudly so the bug
                // is visible.
                return errorResult(
                    "exchange tool called outside an active task. " +
                    "This is an internal bug; the structured payload channel is not available right now.",
                );
            }

            switch (op) {
                case "put":
                    return execPut(store, args);
                case "get":
                    return execGet(store, args);
                case "list":
                    return execList(store);
                default:
                    return errorResult(
                        `Unknown op "${op}". Supported ops are: 'put', 'get', 'list'.`,
                    );
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Op handlers
// ─────────────────────────────────────────────────────────────────────────────

function execPut(store: ExchangeStore, args: Record<string, unknown>): ToolCallResult {
    const key = args["key"];
    if (typeof key !== "string" || !key.trim()) {
        return errorResult("`key` is required for op='put' and must be a non-empty string.");
    }
    if (!("value" in args)) {
        return errorResult(
            "`value` is required for op='put'. " +
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

function execGet(store: ExchangeStore, args: Record<string, unknown>): ToolCallResult {
    const key = args["key"];
    if (typeof key !== "string" || !key.trim()) {
        return errorResult("`key` is required for op='get' and must be a non-empty string.");
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

function execList(store: ExchangeStore): ToolCallResult {
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

function errorResult(message: string): ToolCallResult {
    return {
        success: false,
        type: "text",
        content: `Error: ${message}`,
    };
}
