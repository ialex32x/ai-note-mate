import { describe, it, expect } from "vitest";
import {
    createExchangeTool,
    validateSerializable,
    estimateValueSize,
    type ExchangeStore,
} from "../src/services/tools/exchange-toolcall";
import type { ChatStream, ToolCallResult } from "../src/services/chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the tool's `exec` with a fresh store. The tool never touches the
 * ChatStream argument, so we pass `undefined` cast to `ChatStream`.
 */
async function runOp(
    store: ExchangeStore,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    const tool = createExchangeTool(store);
    return tool.exec(undefined as unknown as ChatStream, args);
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
// op: put
// ─────────────────────────────────────────────────────────────────────────────

describe("exchange tool — put", () => {
    it("stores a value under a key", async () => {
        const store: ExchangeStore = new Map();
        const result = await runOp(store, {
            op: "put",
            key: "result",
            value: { a: 1, b: ["x"] },
        });
        expect(result.success).toBe(true);
        expect(result.type).toBe("object");
        expect(result.content).toEqual({ ok: true, key: "result" });
        expect(store.get("result")).toEqual({ a: 1, b: ["x"] });
    });

    it("trims the key", async () => {
        const store: ExchangeStore = new Map();
        await runOp(store, { op: "put", key: "  result  ", value: 1 });
        expect(store.has("result")).toBe(true);
        expect(store.has("  result  ")).toBe(false);
    });

    it("overwrites silently on duplicate key", async () => {
        const store: ExchangeStore = new Map();
        await runOp(store, { op: "put", key: "k", value: 1 });
        const second = await runOp(store, { op: "put", key: "k", value: 2 });
        expect(second.success).toBe(true);
        expect(store.get("k")).toBe(2);
        expect(store.size).toBe(1);
    });

    it("rejects missing key", async () => {
        const store: ExchangeStore = new Map();
        const r = await runOp(store, { op: "put", value: 1 });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/key.*required/i);
        expect(store.size).toBe(0);
    });

    it("rejects empty/whitespace key", async () => {
        const store: ExchangeStore = new Map();
        const r = await runOp(store, { op: "put", key: "   ", value: 1 });
        expect(r.success).toBe(false);
        expect(store.size).toBe(0);
    });

    it("rejects missing value (vs. explicit null which is allowed)", async () => {
        const store: ExchangeStore = new Map();
        const missing = await runOp(store, { op: "put", key: "k" });
        expect(missing.success).toBe(false);
        expect(String(missing.content)).toMatch(/value.*required/i);
        expect(store.size).toBe(0);

        const explicitNull = await runOp(store, { op: "put", key: "k", value: null });
        expect(explicitNull.success).toBe(true);
        expect(store.get("k")).toBeNull();
    });

    it("rejects non-serializable values without polluting the store", async () => {
        const store: ExchangeStore = new Map();

        const cases: unknown[] = [
            () => 1,
            new Date(),
            new Map(),
            new Set(),
            BigInt(1),
            NaN,
        ];
        for (const v of cases) {
            const r = await runOp(store, { op: "put", key: "bad", value: v });
            expect(r.success).toBe(false);
            expect(String(r.content)).toMatch(/not JSON-serializable/i);
        }

        // Circular ref
        const cyc: Record<string, unknown> = {};
        cyc["self"] = cyc;
        const cycResult = await runOp(store, { op: "put", key: "bad", value: cyc });
        expect(cycResult.success).toBe(false);

        expect(store.size).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// op: get
// ─────────────────────────────────────────────────────────────────────────────

describe("exchange tool — get", () => {
    it("returns the stored value", async () => {
        const store: ExchangeStore = new Map([["result", { ok: true }]]);
        const r = await runOp(store, { op: "get", key: "result" });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({ value: { ok: true } });
    });

    it("round-trips the same value across put/get", async () => {
        const store: ExchangeStore = new Map();
        const value = {
            paths: ["a/b.md", "c.md"],
            meta: { count: 2, nested: [1, null, "x"] },
        };
        await runOp(store, { op: "put", key: "result", value });
        const got = await runOp(store, { op: "get", key: "result" });
        expect(got.content).toEqual({ value });
    });

    it("returns missing flag and available keys when key is absent", async () => {
        const store: ExchangeStore = new Map([
            ["a", 1],
            ["b", 2],
        ]);
        const r = await runOp(store, { op: "get", key: "c" });
        expect(r.success).toBe(true);
        expect(r.content).toMatchObject({
            value: null,
            missing: true,
        });
        const content = r.content as { available_keys: string[] };
        expect(content.available_keys.sort()).toEqual(["a", "b"]);
    });

    it("rejects missing key argument", async () => {
        const store: ExchangeStore = new Map();
        const r = await runOp(store, { op: "get" });
        expect(r.success).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// op: list
// ─────────────────────────────────────────────────────────────────────────────

describe("exchange tool — list", () => {
    it("returns an empty result for an empty store", async () => {
        const store: ExchangeStore = new Map();
        const r = await runOp(store, { op: "list" });
        expect(r.success).toBe(true);
        expect(r.content).toEqual({ keys: [], sizes: {}, total_size: 0 });
    });

    it("enumerates keys with size estimates", async () => {
        const store: ExchangeStore = new Map();
        await runOp(store, { op: "put", key: "result", value: { a: 1 } });
        await runOp(store, { op: "put", key: "candidates", value: [1, 2, 3] });

        const r = await runOp(store, { op: "list" });
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
// op validation
// ─────────────────────────────────────────────────────────────────────────────

describe("exchange tool — op validation", () => {
    it("rejects missing op", async () => {
        const store: ExchangeStore = new Map();
        const r = await runOp(store, {});
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/op.*required/i);
    });

    it("rejects unknown op", async () => {
        const store: ExchangeStore = new Map();
        const r = await runOp(store, { op: "delete" });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/Unknown op/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store source: getter (long-lived ChatStream pattern)
// ─────────────────────────────────────────────────────────────────────────────

describe("exchange tool — getter-based store source", () => {
    it("resolves the store dynamically per call", async () => {
        let current: ExchangeStore | null = new Map();
        const tool = createExchangeTool(() => current);

        await tool.exec(undefined as unknown as ChatStream, {
            op: "put",
            key: "result",
            value: 1,
        });
        expect(current!.get("result")).toBe(1);

        // Swap stores between calls (simulating a new dispatch on a reused
        // ChatStream).
        const next: ExchangeStore = new Map();
        current = next;
        await tool.exec(undefined as unknown as ChatStream, {
            op: "put",
            key: "result",
            value: 2,
        });
        expect(next.get("result")).toBe(2);
    });

    it("returns a clear error when the getter resolves to null", async () => {
        const tool = createExchangeTool(() => null);
        const r = await tool.exec(undefined as unknown as ChatStream, {
            op: "put",
            key: "result",
            value: 1,
        });
        expect(r.success).toBe(false);
        expect(String(r.content)).toMatch(/outside an active task/i);
    });
});
