import { describe, it, expect } from "vitest";
import {
    createHandoffTools,
    createResultTools,
    validateSerializable,
    estimateValueSize,
    type HandoffStore,
} from "../src/services/tools/handoff-toolcall";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../src/services/chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readAndListTools(store: HandoffStore | (() => HandoffStore | null)): {
    read: RegisteredTool;
    list: RegisteredTool;
} {
    const [read, list] = createHandoffTools(store);
    return { read, list };
}

function writeTools(store: HandoffStore | (() => HandoffStore | null)): {
    writeScalar: RegisteredTool;
    writeArray: RegisteredTool;
    writeObject: RegisteredTool;
} {
    const [writeScalar, writeArray, writeObject] = createResultTools(store);
    return { writeScalar, writeArray, writeObject };
}

async function runWriteScalar(
    store: HandoffStore,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    return writeTools(store).writeScalar.exec(undefined as unknown as ChatStream, args);
}

async function runWriteArray(
    store: HandoffStore,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    return writeTools(store).writeArray.exec(undefined as unknown as ChatStream, args);
}

async function runWriteObject(
    store: HandoffStore,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    return writeTools(store).writeObject.exec(undefined as unknown as ChatStream, args);
}

async function runRead(
    store: HandoffStore,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    return readAndListTools(store).read.exec(undefined as unknown as ChatStream, args);
}

async function runList(store: HandoffStore): Promise<ToolCallResult> {
    return readAndListTools(store).list.exec(undefined as unknown as ChatStream, {});
}

// ─────────────────────────────────────────────────────────────────────────────
// validateSerializable
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSerializable", () => {
    it("accepts primitives and null", () => {
        expect(validateSerializable("hello")).toBeNull();
        expect(validateSerializable(42)).toBeNull();
        expect(validateSerializable(0)).toBeNull();
        expect(validateSerializable(-1.5)).toBeNull();
        expect(validateSerializable(true)).toBeNull();
        expect(validateSerializable(false)).toBeNull();
        expect(validateSerializable(null)).toBeNull();
    });

    it("accepts plain arrays and objects, including nested", () => {
        expect(validateSerializable([])).toBeNull();
        expect(validateSerializable({})).toBeNull();
        expect(validateSerializable([1, "two", true, null])).toBeNull();
        expect(validateSerializable({ a: 1, b: { c: [2, 3] } })).toBeNull();
    });

    it("rejects undefined (loses info on JSON round-trip)", () => {
        expect(validateSerializable(undefined)).toMatch(/undefined/);
        expect(validateSerializable([1, undefined, 2])).toMatch(/undefined/);
        expect(validateSerializable({ a: undefined })).toMatch(/undefined/);
    });

    it("rejects non-finite numbers", () => {
        expect(validateSerializable(NaN)).toMatch(/non-finite/);
        expect(validateSerializable(Infinity)).toMatch(/non-finite/);
        expect(validateSerializable(-Infinity)).toMatch(/non-finite/);
    });

    it("rejects functions, symbols, and BigInt", () => {
        expect(validateSerializable(() => 1)).toMatch(/function/);
        expect(validateSerializable(Symbol("x"))).toMatch(/symbol/);
        expect(validateSerializable(BigInt(1))).toMatch(/BigInt/);
    });

    it("rejects Date / Map / Set / RegExp / Error", () => {
        expect(validateSerializable(new Date())).toMatch(/Date/);
        expect(validateSerializable(new Map())).toMatch(/Map/);
        expect(validateSerializable(new Set())).toMatch(/Set/);
        expect(validateSerializable(/x/)).toMatch(/RegExp/);
        expect(validateSerializable(new Error("oops"))).toMatch(/Error/);
    });

    it("rejects binary buffers", () => {
        expect(validateSerializable(new ArrayBuffer(8))).toMatch(/binary/);
        expect(validateSerializable(new Uint8Array(4))).toMatch(/binary/);
    });

    it("rejects class instances (non-plain prototype)", () => {
        class Foo {
            x = 1;
        }
        expect(validateSerializable(new Foo())).toMatch(/non-plain/);
    });

    it("rejects circular references", () => {
        const a: Record<string, unknown> = { name: "a" };
        a["self"] = a;
        expect(validateSerializable(a)).toMatch(/circular/);
    });

    it("identifies the path of the offending node", () => {
        const reason = validateSerializable({ a: { b: [1, undefined] } });
        expect(reason).toMatch(/a\.b\[1\]/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateValueSize
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateValueSize", () => {
    it("returns the JSON length for serializable values", () => {
        expect(estimateValueSize("hi")).toBe(JSON.stringify("hi").length);
        expect(estimateValueSize({ a: 1 })).toBe(JSON.stringify({ a: 1 }).length);
        expect(estimateValueSize([1, 2, 3])).toBe(JSON.stringify([1, 2, 3]).length);
    });

    it("returns 0 for values that cannot be stringified", () => {
        const a: Record<string, unknown> = {};
        a["self"] = a;
        expect(estimateValueSize(a)).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// write_result (scalar)
// ─────────────────────────────────────────────────────────────────────────────

describe("write_result tool (scalar)", () => {
    it("stores a string", async () => {
        const store: HandoffStore = new Map();
        const result = await runWriteScalar(store, { key: "path", value: "/docs/a.md" });
        expect(result.success).toBe(true);
        expect(result.content).toEqual({ ok: true, key: "path" });
        expect(store.get("path")).toBe("/docs/a.md");
    });

    it("stores a number", async () => {
        const store: HandoffStore = new Map();
        await runWriteScalar(store, { key: "count", value: 5 });
        expect(store.get("count")).toBe(5);
    });

    it("stores a boolean", async () => {
        const store: HandoffStore = new Map();
        await runWriteScalar(store, { key: "flag", value: true });
        expect(store.get("flag")).toBe(true);
    });

    it("stores explicit null", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteScalar(store, { key: "k", value: null });
        expect(r.success).toBe(true);
        expect(store.get("k")).toBeNull();
    });

    it("rejects objects (must use write_result_object)", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteScalar(store, { key: "k", value: { a: 1 } });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/write_result_object/i);
        expect(store.size).toBe(0);
    });

    it("rejects arrays (must use write_result_array)", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteScalar(store, { key: "k", value: [1, 2] });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/write_result_array/i);
        expect(store.size).toBe(0);
    });

    it("rejects NaN/Infinity", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteScalar(store, { key: "k", value: NaN });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/NaN|Infinity/i);
        expect(store.size).toBe(0);
    });

    it("trims the key", async () => {
        const store: HandoffStore = new Map();
        await runWriteScalar(store, { key: "  path  ", value: "x" });
        expect(store.has("path")).toBe(true);
        expect(store.has("  path  ")).toBe(false);
    });

    it("overwrites silently on duplicate key", async () => {
        const store: HandoffStore = new Map();
        await runWriteScalar(store, { key: "k", value: "a" });
        const second = await runWriteScalar(store, { key: "k", value: "b" });
        expect(second.success).toBe(true);
        expect(store.get("k")).toBe("b");
        expect(store.size).toBe(1);
    });

    it("rejects missing key", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteScalar(store, { value: "x" });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/key.*required/i);
        expect(store.size).toBe(0);
    });

    it("rejects missing value", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteScalar(store, { key: "k" });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/value.*required/i);
        expect(store.size).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// write_result_array
// ─────────────────────────────────────────────────────────────────────────────

describe("write_result_array tool", () => {
    it("stores an array", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteArray(store, { key: "paths", value: ["a.md", "b.md"] });
        expect(r.success).toBe(true);
        expect(store.get("paths")).toEqual(["a.md", "b.md"]);
    });

    it("rejects non-array values", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteArray(store, { key: "paths", value: "not-an-array" });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/array/i);
        expect(store.size).toBe(0);
    });

    it("rejects arrays with non-serializable elements", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteArray(store, { key: "bad", value: [new Date()] });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/not JSON-serializable/i);
        expect(store.size).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// write_result_object
// ─────────────────────────────────────────────────────────────────────────────

describe("write_result_object tool", () => {
    it("stores a plain object", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteObject(store, { key: "diff", value: { before: "old", after: "new" } });
        expect(r.success).toBe(true);
        expect(store.get("diff")).toEqual({ before: "old", after: "new" });
    });

    it("rejects null", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteObject(store, { key: "k", value: null });
        expect(r.success).toBe(false);
    });

    it("rejects arrays (must use write_result_array)", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteObject(store, { key: "k", value: [1, 2] });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/write_result_array/i);
    });

    it("rejects non-serializable values", async () => {
        const store: HandoffStore = new Map();
        const r = await runWriteObject(store, { key: "bad", value: { fn: () => 1 } });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/not JSON-serializable/i);
        expect(store.size).toBe(0);
    });

    it("rejects Date, Map, Set, BigInt inside objects", async () => {
        const store: HandoffStore = new Map();
        const cases: unknown[] = [new Date(), new Map(), new Set(), BigInt(1)];
        for (const v of cases) {
            const r = await runWriteObject(store, { key: "bad", value: { inner: v } });
            expect(r.success).toBe(false);
        }
        expect(store.size).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// read_handoff — single
// ─────────────────────────────────────────────────────────────────────────────

describe("read_handoff tool — single", () => {
    it("returns the stored value", async () => {
        const store: HandoffStore = new Map([["result", { ok: true }]]);
        const r = await runRead(store, { key: "result" });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({ value: { ok: true } });
    });

    it("round-trips the same value across write/read", async () => {
        const store: HandoffStore = new Map();
        const value = {
            paths: ["a/b.md", "c.md"],
            meta: { count: 2, nested: [1, null, "x"] },
        };
        await runWriteObject(store, { key: "result", value });
        const got = await runRead(store, { key: "result" });
        expect(got.content).toEqual({ value });
    });

    it("returns missing flag and available keys when key is absent", async () => {
        const store: HandoffStore = new Map([
            ["a", 1],
            ["b", 2],
        ]);
        const r = await runRead(store, { key: "c" });
        expect(r.success).toBe(true);
        expect(r.content).toMatchObject({
            value: null,
            missing: true,
        });
        const content = r.content as { available_keys: string[] };
        expect(content.available_keys.sort()).toEqual(["a", "b"]);
    });

    it("rejects missing key/keys arguments", async () => {
        const store: HandoffStore = new Map();
        const r = await runRead(store, {});
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/key.*keys/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// read_handoff — batch via `keys` array
// ─────────────────────────────────────────────────────────────────────────────

describe("read_handoff tool — batch", () => {
    it("returns all found values keyed by the requested key", async () => {
        const store: HandoffStore = new Map([
            ["source", ["a.md", "b.md"]],
            ["user_focus", "fix typos"],
            ["target_language", "en"],
        ]);
        const r = await runRead(store, {
            keys: ["source", "user_focus"],
        });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({
            values: {
                source: ["a.md", "b.md"],
                user_focus: "fix typos",
            },
            missing: [],
        });
    });

    it("partitions hits and misses into `values` and `missing`", async () => {
        const store: HandoffStore = new Map([
            ["path", "Notes/a.md"],
            ["style_rules", { tone: "formal" }],
        ]);
        const r = await runRead(store, {
            keys: ["path", "style_rules", "target_language"],
        });
        expect(r.success).toBe(true);
        const content = r.content as {
            values: Record<string, unknown>;
            missing: string[];
            available_keys?: string[];
        };
        expect(content.values).toEqual({
            path: "Notes/a.md",
            style_rules: { tone: "formal" },
        });
        expect(content.missing).toEqual(["target_language"]);
        expect(content.available_keys?.sort()).toEqual(["path", "style_rules"]);
    });

    it("omits `available_keys` when every requested key is found", async () => {
        const store: HandoffStore = new Map([["k", 1]]);
        const r = await runRead(store, { keys: ["k"] });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({ values: { k: 1 }, missing: [] });
    });

    it("reports every requested key in `missing` when store is empty", async () => {
        const store: HandoffStore = new Map();
        const r = await runRead(store, { keys: ["a", "b"] });
        expect(r.success).toBe(true);
        const content = r.content as {
            values: Record<string, unknown>;
            missing: string[];
            available_keys?: string[];
        };
        expect(content.values).toEqual({});
        expect(content.missing.sort()).toEqual(["a", "b"]);
        expect(content.available_keys).toEqual([]);
    });

    it("trims and deduplicates requested keys", async () => {
        const store: HandoffStore = new Map([
            ["result", { ok: true }],
            ["candidates", [1, 2]],
        ]);
        const r = await runRead(store, {
            keys: ["  result  ", "result", "candidates"],
        });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({
            values: { result: { ok: true }, candidates: [1, 2] },
            missing: [],
        });
    });

    it("preserves explicit null values (not collapsed into `missing`)", async () => {
        // The write path accepts `null`; batch read must treat it as a
        // real present value rather than reporting the key as missing.
        const store: HandoffStore = new Map([["maybe", null]]);
        const r = await runRead(store, { keys: ["maybe"] });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({ values: { maybe: null }, missing: [] });
    });

    it("rejects when both `key` and `keys` are provided", async () => {
        const store: HandoffStore = new Map([["k", 1]]);
        const r = await runRead(store, { key: "k", keys: ["k"] });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/either.*key.*or.*keys/i);
    });

    it("rejects a non-array `keys` argument", async () => {
        const store: HandoffStore = new Map();
        const r = await runRead(store, { keys: "result" });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/array/i);
    });

    it("rejects an empty `keys` array (with hint to use list_handoff)", async () => {
        const store: HandoffStore = new Map();
        const r = await runRead(store, { keys: [] });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/at least one/i);
    });

    it("rejects non-string entries in `keys`", async () => {
        const store: HandoffStore = new Map();
        const r = await runRead(store, { keys: ["a", 42] });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/keys\[1\].*string/i);
    });

    it("rejects empty / whitespace-only entries in `keys`", async () => {
        const store: HandoffStore = new Map();
        const r = await runRead(store, { keys: ["a", "   "] });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/keys\[1\].*empty/i);
    });

    it("rejects `keys` exceeding the hard limit", async () => {
        const store: HandoffStore = new Map();
        const tooMany = Array.from({ length: 33 }, (_, i) => `k${i}`);
        const r = await runRead(store, { keys: tooMany });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/Too many keys/i);
    });

    it("the existing single-key path is unaffected by adding `keys`", async () => {
        // Regression guard: callers using only `key` should see the
        // exact same response shape as before (no `values` / `missing`
        // batch envelope mixed in).
        const store: HandoffStore = new Map([["result", { ok: true }]]);
        const r = await runRead(store, { key: "result" });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({ value: { ok: true } });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// list_handoff
// ─────────────────────────────────────────────────────────────────────────────

describe("list_handoff tool", () => {
    it("returns an empty result for an empty store", async () => {
        const store: HandoffStore = new Map();
        const r = await runList(store);
        expect(r.success).toBe(true);
        expect(r.content).toEqual({ keys: [], sizes: {}, total_size: 0 });
    });

    it("enumerates keys with size estimates", async () => {
        const store: HandoffStore = new Map();
        await runWriteObject(store, { key: "result", value: { a: 1 } });
        await runWriteArray(store, { key: "candidates", value: [1, 2, 3] });

        const r = await runList(store);
        expect(r.success).toBe(true);
        const content = r.content as {
            keys: string[];
            sizes: Record<string, number>;
            total_size: number;
        };
        expect(content.keys.sort()).toEqual(["candidates", "result"]);
        expect(content.sizes["result"]).toBe(JSON.stringify({ a: 1 }).length);
        expect(content.sizes["candidates"]).toBe(JSON.stringify([1, 2, 3]).length);
        expect(content.total_size).toBe(
            content.sizes["result"]! + content.sizes["candidates"]!,
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store source: getter (long-lived ChatStream pattern)
// ─────────────────────────────────────────────────────────────────────────────

describe("handoff tools — getter-based store source", () => {
    it("resolves the store dynamically per call (write_result)", async () => {
        let current: HandoffStore | null = new Map();
        const { writeScalar } = writeTools(() => current);

        await writeScalar.exec(undefined as unknown as ChatStream, {
            key: "path",
            value: "a.md",
        });
        expect(current!.get("path")).toBe("a.md");

        // Swap stores between calls (simulating a new dispatch on a reused
        // ChatStream).
        const next: HandoffStore = new Map();
        current = next;
        await writeScalar.exec(undefined as unknown as ChatStream, {
            key: "path",
            value: "b.md",
        });
        expect(next.get("path")).toBe("b.md");
    });

    it("returns a clear error when the getter resolves to null (write)", async () => {
        const { writeScalar } = writeTools(() => null);
        const r = await writeScalar.exec(undefined as unknown as ChatStream, {
            key: "path",
            value: "x",
        });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/outside an active task/i);
    });

    it("returns a clear error when the getter resolves to null (read)", async () => {
        const { read } = readAndListTools(() => null);
        const r = await read.exec(undefined as unknown as ChatStream, {
            key: "path",
        });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/outside an active task/i);
    });

    it("returns a clear error when the getter resolves to null (list)", async () => {
        const { list } = readAndListTools(() => null);
        const r = await list.exec(undefined as unknown as ChatStream, {});
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/outside an active task/i);
    });
});
