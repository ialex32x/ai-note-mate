import { describe, it, expect } from "vitest";
import {
    createHandoffTools,
    validateSerializable,
    estimateValueSize,
    type HandoffStore,
} from "../src/services/tools/handoff-toolcall";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../src/services/chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a triple of fresh handoff tools bound to the given store. Sub-
 * agents register all three; tests just need to pick the right one per
 * scenario.
 */
function tools(store: HandoffStore | (() => HandoffStore | null)): {
    write: RegisteredTool;
    read: RegisteredTool;
    list: RegisteredTool;
} {
    const [write, read, list] = createHandoffTools(store);
    return { write, read, list };
}

/**
 * Run the write tool's `exec` with a fresh store. The tool never touches
 * the ChatStream argument, so we pass `undefined` cast to `ChatStream`.
 */
async function runWrite(
    store: HandoffStore,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    return tools(store).write.exec(undefined as unknown as ChatStream, args);
}

async function runRead(
    store: HandoffStore,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    return tools(store).read.exec(undefined as unknown as ChatStream, args);
}

async function runList(store: HandoffStore): Promise<ToolCallResult> {
    return tools(store).list.exec(undefined as unknown as ChatStream, {});
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
// write_handoff
// ─────────────────────────────────────────────────────────────────────────────

describe("write_handoff tool", () => {
    it("stores a value under a key", async () => {
        const store: HandoffStore = new Map();
        const result = await runWrite(store, {
            key: "result",
            value: { a: 1, b: ["x"] },
        });
        expect(result.success).toBe(true);
        expect(result.type).toBe("object");
        expect(result.content).toEqual({ ok: true, key: "result" });
        expect(store.get("result")).toEqual({ a: 1, b: ["x"] });
    });

    it("trims the key", async () => {
        const store: HandoffStore = new Map();
        await runWrite(store, { key: "  result  ", value: 1 });
        expect(store.has("result")).toBe(true);
        expect(store.has("  result  ")).toBe(false);
    });

    it("overwrites silently on duplicate key", async () => {
        const store: HandoffStore = new Map();
        await runWrite(store, { key: "k", value: 1 });
        const second = await runWrite(store, { key: "k", value: 2 });
        expect(second.success).toBe(true);
        expect(store.get("k")).toBe(2);
        expect(store.size).toBe(1);
    });

    it("rejects missing key", async () => {
        const store: HandoffStore = new Map();
        const r = await runWrite(store, { value: 1 });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/key.*required/i);
        expect(store.size).toBe(0);
    });

    it("rejects empty/whitespace key", async () => {
        const store: HandoffStore = new Map();
        const r = await runWrite(store, { key: "   ", value: 1 });
        expect(r.success).toBe(false);
        expect(store.size).toBe(0);
    });

    it("rejects missing value (vs. explicit null which is allowed)", async () => {
        const store: HandoffStore = new Map();
        const missing = await runWrite(store, { key: "k" });
        expect(missing.success).toBe(false);
        expect(String(missing.content)).toMatch(/value.*required/i);
        expect(store.size).toBe(0);

        const explicitNull = await runWrite(store, { key: "k", value: null });
        expect(explicitNull.success).toBe(true);
        expect(store.get("k")).toBeNull();
    });

    it("rejects non-serializable values without polluting the store", async () => {
        const store: HandoffStore = new Map();

        const cases: unknown[] = [
            () => 1,
            new Date(),
            new Map(),
            new Set(),
            BigInt(1),
            NaN,
        ];
        for (const v of cases) {
            const r = await runWrite(store, { key: "bad", value: v });
            expect(r.success).toBe(false);
            expect(String(r.content)).toMatch(/not JSON-serializable/i);
        }

        // Circular ref
        const cyc: Record<string, unknown> = {};
        cyc["self"] = cyc;
        const cycResult = await runWrite(store, { key: "bad", value: cyc });
        expect(cycResult.success).toBe(false);

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
        await runWrite(store, { key: "result", value });
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
        await runWrite(store, { key: "result", value: { a: 1 } });
        await runWrite(store, { key: "candidates", value: [1, 2, 3] });

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
    it("resolves the store dynamically per call", async () => {
        let current: HandoffStore | null = new Map();
        const { write } = tools(() => current);

        await write.exec(undefined as unknown as ChatStream, {
            key: "result",
            value: 1,
        });
        expect(current!.get("result")).toBe(1);

        // Swap stores between calls (simulating a new dispatch on a reused
        // ChatStream).
        const next: HandoffStore = new Map();
        current = next;
        await write.exec(undefined as unknown as ChatStream, {
            key: "result",
            value: 2,
        });
        expect(next.get("result")).toBe(2);
    });

    it("returns a clear error when the getter resolves to null (write)", async () => {
        const { write } = tools(() => null);
        const r = await write.exec(undefined as unknown as ChatStream, {
            key: "result",
            value: 1,
        });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/outside an active task/i);
    });

    it("returns a clear error when the getter resolves to null (read)", async () => {
        const { read } = tools(() => null);
        const r = await read.exec(undefined as unknown as ChatStream, {
            key: "result",
        });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/outside an active task/i);
    });

    it("returns a clear error when the getter resolves to null (list)", async () => {
        const { list } = tools(() => null);
        const r = await list.exec(undefined as unknown as ChatStream, {});
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/outside an active task/i);
    });
});
