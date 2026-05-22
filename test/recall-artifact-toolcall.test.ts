import { describe, it, expect } from "vitest";
import { ArtifactStore } from "../src/services/artifact-store";
import {
    createRecallArtifactTool,
    type ArtifactStoreSource,
} from "../src/services/tools/recall-artifact-toolcall";
import type { ChatStream, ToolCallResult } from "../src/services/chat-stream";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the tool's `exec` with the given store source. The tool never
 * touches the ChatStream argument — same convention as the handoff
 * tool tests.
 */
async function run(
    source: ArtifactStoreSource,
    args: Record<string, unknown>,
): Promise<ToolCallResult> {
    const tool = createRecallArtifactTool(source);
    return tool.exec(undefined as unknown as ChatStream, args);
}

/** Mock clock helper, mirrors the artifact-store tests' style. */
function makeClock(start = 1_000_000) {
    let t = start;
    return {
        now: () => t,
        advance: (ms: number) => { t += ms; },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument validation
// ─────────────────────────────────────────────────────────────────────────────

describe("recall_artifact – argument validation", () => {
    it("rejects missing key", async () => {
        const store = new ArtifactStore();
        const res = await run(store, {});
        expect(res.success).toBe(false);
        expect(res.type).toBe("text");
        expect(String(res.content)).toMatch(/key.*required/i);
    });

    it("rejects non-string key", async () => {
        const store = new ArtifactStore();
        const res = await run(store, { key: 42 });
        expect(res.success).toBe(false);
        expect(String(res.content)).toMatch(/key.*required/i);
    });

    it("rejects empty / whitespace-only key", async () => {
        const store = new ArtifactStore();
        const res1 = await run(store, { key: "" });
        const res2 = await run(store, { key: "   " });
        expect(res1.success).toBe(false);
        expect(res2.success).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store-source resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("recall_artifact – store source", () => {
    it("supports a direct ArtifactStore as source", async () => {
        const store = new ArtifactStore();
        store.put("k", { hello: "world" }, 20);
        const res = await run(store, { key: "k" });
        expect(res.success).toBe(true);
        expect(res.type).toBe("object");
        expect(res.content).toEqual({
            found: true,
            value: { hello: "world" },
            size: 20,
        });
    });

    it("supports a getter as source (long-lived ChatStream pattern)", async () => {
        let activeStore: ArtifactStore | null = new ArtifactStore();
        activeStore.put("k", "v", 1);

        const tool = createRecallArtifactTool(() => activeStore);

        const res1 = await tool.exec(
            undefined as unknown as ChatStream,
            { key: "k" },
        );
        expect(res1.success).toBe(true);
        expect((res1.content as { found: boolean }).found).toBe(true);

        // Swap the store mid-life: same tool registration must reach the new one.
        activeStore = new ArtifactStore();
        const res2 = await tool.exec(
            undefined as unknown as ChatStream,
            { key: "k" },
        );
        expect(res2.success).toBe(true);
        // Different (empty) store → pure miss.
        expect(res2.content).toMatchObject({
            found: false,
            evicted: false,
            available_keys: [],
        });
    });

    it("reports an internal error when getter returns null", async () => {
        const tool = createRecallArtifactTool(() => null);
        const res = await tool.exec(
            undefined as unknown as ChatStream,
            { key: "k" },
        );
        expect(res.success).toBe(false);
        expect(res.type).toBe("text");
        expect(String(res.content)).toMatch(/internal bug|no artifacts/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Live hit
// ─────────────────────────────────────────────────────────────────────────────

describe("recall_artifact – live hit", () => {
    it("returns value verbatim including complex shapes", async () => {
        const store = new ArtifactStore();
        const value = {
            digests: [
                { path: "a.md", summary: "...", anchors: [{ heading_path: "H1" }] },
                { path: "b.md", summary: "...", anchors: [] },
            ],
            warnings: [],
        };
        store.put("auto:call-1:result", value, 500);

        const res = await run(store, { key: "auto:call-1:result" });
        expect(res.success).toBe(true);
        expect(res.content).toEqual({
            found: true,
            value,
            size: 500,
        });
    });

    it("trims whitespace around the key before lookup", async () => {
        const store = new ArtifactStore();
        store.put("k", "v", 1);
        const res = await run(store, { key: "  k  " });
        expect((res.content as { found: boolean }).found).toBe(true);
    });

    it("refreshes lastAccess on live hit (sliding TTL)", async () => {
        // Verify the tool's get-through actually drives the store's
        // LRU/TTL refresh: a key recalled just before TTL stays alive
        // for another full TTL window.
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 1000, now: clock.now });
        store.put("k", "v", 1);

        clock.advance(800);
        const r1 = await run(store, { key: "k" });
        expect((r1.content as { found: boolean }).found).toBe(true);

        clock.advance(800); // 1600 since put, but only 800 since recall
        const r2 = await run(store, { key: "k" });
        expect((r2.content as { found: boolean }).found).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tombstone hit
// ─────────────────────────────────────────────────────────────────────────────

describe("recall_artifact – tombstone hit", () => {
    it("reports LRU eviction with size and available_keys", async () => {
        // Force an LRU eviction by overfilling the store.
        const store = new ArtifactStore({ totalBytesCap: 100 });
        store.put("a", "x", 60);
        store.put("b", "y", 50); // evicts a (60+50 > 100)

        const res = await run(store, { key: "a" });
        expect(res.success).toBe(true);
        expect(res.content).toMatchObject({
            found: false,
            evicted: true,
            reason: "lru",
            size: 60,
            available_keys: ["b"],
        });
    });

    it("reports TTL eviction", async () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 100, now: clock.now });
        store.put("k", "v", 10);

        clock.advance(200); // way past TTL

        const res = await run(store, { key: "k" });
        expect(res.content).toMatchObject({
            found: false,
            evicted: true,
            reason: "ttl",
            size: 10,
            available_keys: [],
        });
    });

    it("reports session_end eviction after clear()", async () => {
        const store = new ArtifactStore();
        store.put("k", "v", 5);
        store.clear();

        const res = await run(store, { key: "k" });
        expect(res.content).toMatchObject({
            found: false,
            evicted: true,
            reason: "session_end",
            size: 5,
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure miss
// ─────────────────────────────────────────────────────────────────────────────

describe("recall_artifact – pure miss", () => {
    it("returns found:false, evicted:false, and lists live keys", async () => {
        const store = new ArtifactStore();
        store.put("alpha", 1, 1);
        store.put("beta", 2, 1);

        const res = await run(store, { key: "never-existed" });
        expect(res.success).toBe(true);
        expect(res.content).toEqual({
            found: false,
            evicted: false,
            available_keys: ["alpha", "beta"],
        });
    });

    it("does not advertise expired keys in available_keys", async () => {
        // available_keys should always reflect the post-sweep live set.
        // If a key has expired but not been recalled yet, it must not
        // appear in available_keys (the store handles that via
        // liveKeys() → sweepExpired). This test pins the contract.
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 100, now: clock.now });
        store.put("old", "v", 1);
        clock.advance(50);
        store.put("fresh", "v", 1);
        clock.advance(80); // old: 130 since put → expired; fresh: 80 → alive

        const res = await run(store, { key: "nope" });
        expect((res.content as { available_keys: string[] }).available_keys)
            .toEqual(["fresh"]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool schema
// ─────────────────────────────────────────────────────────────────────────────

describe("recall_artifact – tool schema", () => {
    it("exposes the documented name and required key parameter", () => {
        const store = new ArtifactStore();
        const tool = createRecallArtifactTool(store);
        expect(tool.schema.type).toBe("function");
        expect(tool.schema.function.name).toBe("recall_artifact");
        expect(tool.schema.function.parameters?.required).toEqual(["key"]);
        expect(tool.ondemand).toBe(true);
        expect(tool.requiresConfirmation).toBe(false);
        expect(tool.capabilities).toEqual([]);
    });
});
