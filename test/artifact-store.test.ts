import { describe, it, expect } from "vitest";
import { ArtifactStore } from "../src/services/artifact-store";

/**
 * Tests for the per-session ArtifactStore. Scope (matches plan §5.1):
 *   - put/get round-trips primitives, plain objects, arrays.
 *   - LRU eviction at total-byte cap (smallest victim, oldest access).
 *   - TTL eviction with mocked clock.
 *   - Tombstone produced on every eviction, retrievable via the recall path.
 *   - Tombstone GC respects its own cap.
 *   - Per-entry cap rejects oversized puts without polluting the store.
 *
 * The store has no I/O and no async surface, so these tests are
 * deterministic and do not need fake timers / vi.useFakeTimers.
 * A mock clock is injected via the `now` constructor option instead.
 */

/** Minimal manual clock so individual tests can advance time in ms. */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => { t += ms; },
        set: (ms) => { t = ms; },
    };
}

describe("ArtifactStore.put / get", () => {
    it("round-trips primitive values", () => {
        const store = new ArtifactStore();
        const p = store.put("k:str", "hello", 5);
        expect(p.stored).toBe(true);
        const g = store.get("k:str");
        expect(g).toEqual({ found: true, value: "hello", size: 5 });
    });

    it("round-trips plain objects without cloning", () => {
        const store = new ArtifactStore();
        const obj = { a: 1, b: { c: [1, 2, 3] } };
        store.put("k:obj", obj, 32);
        const g = store.get("k:obj");
        expect(g).toEqual({ found: true, value: obj, size: 32 });
        // Identity preserved — store is in-process, no defensive copy.
        if (g.found) expect(g.value).toBe(obj);
    });

    it("round-trips arrays", () => {
        const store = new ArtifactStore();
        const arr = [1, "two", { three: 3 }];
        store.put("k:arr", arr, 24);
        const g = store.get("k:arr");
        expect(g).toEqual({ found: true, value: arr, size: 24 });
    });

    it("returns a clean miss for unknown keys", () => {
        const store = new ArtifactStore();
        expect(store.get("nope")).toEqual({ found: false, evicted: false });
    });

    it("overwrites without producing a tombstone for the prior value", () => {
        const store = new ArtifactStore();
        store.put("k", "v1", 2);
        store.put("k", "v2", 2);
        expect(store.get("k")).toEqual({ found: true, value: "v2", size: 2 });
        expect(store.stats().tombstoneCount).toBe(0);
    });

    it("overwrite refreshes a previously-tombstoned key (cleans the gravestone)", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 100, now: clock.now });
        store.put("k", "v1", 2);
        clock.advance(200); // expire
        // Trigger tombstone via a get
        const expired = store.get("k");
        expect(expired).toMatchObject({ found: false, evicted: true, reason: "ttl" });
        expect(store.stats().tombstoneCount).toBe(1);
        // Re-put the key — the tombstone must be cleared so the next
        // recall sees the live value, not "still gone".
        store.put("k", "v2", 2);
        expect(store.get("k")).toEqual({ found: true, value: "v2", size: 2 });
        expect(store.stats().tombstoneCount).toBe(0);
    });
});

describe("ArtifactStore per-entry cap", () => {
    it("rejects values larger than singleArtifactCap without mutating state", () => {
        const store = new ArtifactStore({ singleArtifactCap: 100, totalBytesCap: 1000 });
        store.put("small", "x", 10);
        const r = store.put("big", "y".repeat(200), 200);
        expect(r).toEqual({ stored: false, reason: "too_large_for_store", size: 200 });
        // Existing entry untouched.
        expect(store.get("small")).toEqual({ found: true, value: "x", size: 10 });
        // No tombstone was created — the rejection is recorded on the
        // envelope by the caller, not in the store.
        expect(store.stats().tombstoneCount).toBe(0);
    });

    it("rejects (without partial state) when size exceeds totalBytesCap even after evicting everything", () => {
        const store = new ArtifactStore({ singleArtifactCap: 10_000, totalBytesCap: 100 });
        store.put("a", "aa", 50);
        store.put("b", "bb", 40);
        // 200 > totalCap and > everything currently held.
        const r = store.put("huge", "h".repeat(200), 200);
        expect(r).toEqual({ stored: false, reason: "too_large_for_store", size: 200 });
        // Pre-existing entries must remain — futile evictions are rolled back.
        expect(store.get("a")).toMatchObject({ found: true });
        expect(store.get("b")).toMatchObject({ found: true });
        expect(store.stats().tombstoneCount).toBe(0);
    });
});

describe("ArtifactStore LRU eviction at total-byte cap", () => {
    it("evicts the least-recently-accessed entry when a new put would overflow", () => {
        const store = new ArtifactStore({ totalBytesCap: 100, singleArtifactCap: 100, ttlMs: 0 });
        store.put("a", "A", 40);
        store.put("b", "B", 40);
        // Touch 'a' so 'b' becomes the LRU victim.
        expect(store.get("a")).toMatchObject({ found: true });
        const r = store.put("c", "C", 40); // 40+40+40=120 > 100, must evict 'b'
        expect(r.stored).toBe(true);
        if (r.stored) {
            expect(r.evicted).toEqual([{ key: "b", reason: "lru", size: 40 }]);
        }
        expect(store.get("b")).toEqual({ found: false, evicted: true, reason: "lru", size: 40 });
        expect(store.get("a")).toMatchObject({ found: true });
        expect(store.get("c")).toMatchObject({ found: true });
    });

    it("can evict multiple entries in a single put to make room", () => {
        const store = new ArtifactStore({ totalBytesCap: 100, singleArtifactCap: 100, ttlMs: 0 });
        store.put("a", "A", 30);
        store.put("b", "B", 30);
        store.put("c", "C", 30);
        // Insert a 90-byte entry; only one of the existing 30s can stay (30+90=120>100,
        // so all three must go).
        const r = store.put("big", "X", 90);
        expect(r.stored).toBe(true);
        if (r.stored) {
            // Eldest-first eviction order.
            expect(r.evicted.map((e) => e.key)).toEqual(["a", "b", "c"]);
        }
        expect(store.stats().liveCount).toBe(1);
        expect(store.stats().liveBytes).toBe(90);
    });

    it("records a tombstone for every LRU-evicted entry", () => {
        const store = new ArtifactStore({ totalBytesCap: 50, singleArtifactCap: 50, ttlMs: 0 });
        store.put("a", "A", 30);
        store.put("b", "B", 30); // forces 'a' out
        const recall = store.get("a");
        expect(recall).toEqual({ found: false, evicted: true, reason: "lru", size: 30 });
    });
});

describe("ArtifactStore TTL eviction", () => {
    it("expires entries whose lastAccess is older than ttlMs", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 1000, now: clock.now });
        store.put("k", "v", 4);
        clock.advance(500);
        expect(store.get("k")).toMatchObject({ found: true });
        clock.advance(1500); // 500 + 1500 = 2000 since last access > 1000
        expect(store.get("k")).toEqual({ found: false, evicted: true, reason: "ttl", size: 4 });
    });

    it("get() refreshes lastAccess (sliding TTL)", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 1000, now: clock.now });
        store.put("k", "v", 4);
        // Walk forward in 800ms steps and read each time — entry should never expire.
        for (let i = 0; i < 5; i++) {
            clock.advance(800);
            expect(store.get("k")).toMatchObject({ found: true });
        }
    });

    it("ttlMs = 0 disables TTL entirely", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 0, now: clock.now });
        store.put("k", "v", 4);
        clock.advance(10 * 365 * 24 * 60 * 60 * 1000); // 10 years
        expect(store.get("k")).toMatchObject({ found: true });
    });

    it("liveKeys() does not advertise expired entries", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 100, now: clock.now });
        store.put("a", "A", 1);
        store.put("b", "B", 1);
        clock.advance(50);
        store.put("c", "C", 1); // refreshes nothing for a/b but sweeps (none yet)
        clock.advance(80); // a,b: 130 since access > 100; c: 80 < 100
        const keys = store.liveKeys();
        expect(keys).toEqual(["c"]);
        // The sweep also produced tombstones for a and b.
        expect(store.get("a")).toMatchObject({ found: false, evicted: true, reason: "ttl" });
        expect(store.get("b")).toMatchObject({ found: false, evicted: true, reason: "ttl" });
    });
});

describe("ArtifactStore tombstones", () => {
    it("tombstone GC respects tombstoneCap (FIFO)", () => {
        const store = new ArtifactStore({
            totalBytesCap: 100,
            singleArtifactCap: 100,
            ttlMs: 0,
            tombstoneCap: 2,
        });
        // Force three sequential LRU evictions by inserting 4 entries of 40 bytes
        // into a 100-byte cap.
        store.put("a", 1, 40);
        store.put("b", 2, 40); // ok: 80
        store.put("c", 3, 40); // 80+40=120>100, evicts a → tombstone a
        store.put("d", 4, 40); // evicts b → tombstone b
        store.put("e", 5, 40); // evicts c → tombstone c, but cap=2 so 'a' drops
        // 'a' tombstone has been GC'd: recall now reports a pure miss.
        expect(store.get("a")).toEqual({ found: false, evicted: false });
        // 'b' and 'c' tombstones survive.
        expect(store.get("b")).toMatchObject({ found: false, evicted: true, reason: "lru" });
        expect(store.get("c")).toMatchObject({ found: false, evicted: true, reason: "lru" });
    });

    it("tombstone reason is 'session_end' after clear()", () => {
        const store = new ArtifactStore();
        store.put("k", "v", 4);
        store.clear();
        expect(store.get("k")).toEqual({ found: false, evicted: true, reason: "session_end", size: 4 });
        expect(store.stats().liveCount).toBe(0);
        expect(store.stats().liveBytes).toBe(0);
    });

    it("tombstone reason updates if a tombstoned key gets re-tombstoned with a newer reason", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 100, now: clock.now });
        store.put("k", "v", 4);
        clock.advance(200);
        // First observation: ttl tombstone.
        expect(store.get("k")).toMatchObject({ reason: "ttl" });
        // session_end on a key that's already tombstoned: only live
        // entries get session_end reasons, so this is a no-op. Verify
        // the original ttl reason survives.
        store.clear();
        expect(store.get("k")).toMatchObject({ reason: "ttl" });
    });
});

describe("ArtifactStore.stats", () => {
    it("tracks liveBytes and liveCount across put/get/overwrite", () => {
        const store = new ArtifactStore({ totalBytesCap: 1000, singleArtifactCap: 1000, ttlMs: 0 });
        expect(store.stats()).toEqual({ liveCount: 0, liveBytes: 0, tombstoneCount: 0 });
        store.put("a", "A", 100);
        store.put("b", "B", 200);
        expect(store.stats()).toEqual({ liveCount: 2, liveBytes: 300, tombstoneCount: 0 });
        // Overwrite: liveBytes adjusts.
        store.put("a", "A2", 50);
        expect(store.stats()).toEqual({ liveCount: 2, liveBytes: 250, tombstoneCount: 0 });
    });
});
