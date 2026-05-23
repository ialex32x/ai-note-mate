import { describe, it, expect, vi } from "vitest";
import { ArtifactStore } from "../src/services/artifact-store";
import type { DataAdapter } from "obsidian";

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
        const p = store.put("hello", 5);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        const g = store.get(p.key);
        expect(g).toEqual({ found: true, value: "hello", size: 5 });
    });

    it("round-trips plain objects without cloning", () => {
        const store = new ArtifactStore();
        const obj = { a: 1, b: { c: [1, 2, 3] } };
        const p = store.put(obj, 32);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        const g = store.get(p.key);
        expect(g).toEqual({ found: true, value: obj, size: 32 });
        // Identity preserved — store is in-process, no defensive copy.
        if (g.found) expect(g.value).toBe(obj);
    });

    it("round-trips arrays", () => {
        const store = new ArtifactStore();
        const arr = [1, "two", { three: 3 }];
        const p = store.put(arr, 24);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        const g = store.get(p.key);
        expect(g).toEqual({ found: true, value: arr, size: 24 });
    });

    it("returns a clean miss for unknown keys", () => {
        const store = new ArtifactStore();
        expect(store.get("nope")).toEqual({ found: false, evicted: false });
    });

    it("each put generates a unique key", () => {
        const store = new ArtifactStore();
        const p1 = store.put("v1", 2);
        const p2 = store.put("v2", 2);
        expect(p1.stored).toBe(true);
        expect(p2.stored).toBe(true);
        if (!p1.stored || !p2.stored) throw new Error("unexpected");
        expect(p1.key).not.toBe(p2.key);
        // Both should be live (no overwrite).
        expect(store.stats().liveCount).toBe(2);
        expect(store.get(p1.key)).toMatchObject({ found: true, value: "v1" });
        expect(store.get(p2.key)).toMatchObject({ found: true, value: "v2" });
    });
});

describe("ArtifactStore per-entry cap", () => {
    it("rejects values larger than singleArtifactCap without mutating state", () => {
        const store = new ArtifactStore({ singleArtifactCap: 100, totalBytesCap: 1000 });
        const rSmall = store.put("x", 10);
        expect(rSmall.stored).toBe(true);
        const r = store.put("y".repeat(200), 200);
        expect(r).toEqual({ stored: false, reason: "too_large_for_store", size: 200 });
        // Existing entry untouched.
        if (!rSmall.stored) throw new Error("unexpected");
        expect(store.get(rSmall.key)).toEqual({ found: true, value: "x", size: 10 });
        // No tombstone was created — the rejection is recorded on the
        // envelope by the caller, not in the store.
        expect(store.stats().diskIndexCount).toBe(0);
    });

    it("rejects (without partial state) when size exceeds totalBytesCap even after evicting everything", () => {
        const store = new ArtifactStore({ singleArtifactCap: 10_000, totalBytesCap: 100 });
        const rA = store.put("aa", 50);
        const rB = store.put("bb", 40);
        expect(rA.stored).toBe(true);
        expect(rB.stored).toBe(true);
        // 200 > totalCap and > everything currently held.
        const r = store.put("h".repeat(200), 200);
        expect(r).toEqual({ stored: false, reason: "too_large_for_store", size: 200 });
        // Pre-existing entries must remain — futile evictions are rolled back.
        if (!rA.stored || !rB.stored) throw new Error("unexpected");
        expect(store.get(rA.key)).toMatchObject({ found: true });
        expect(store.get(rB.key)).toMatchObject({ found: true });
        expect(store.stats().diskIndexCount).toBe(0);
    });
});

describe("ArtifactStore LRU eviction at total-byte cap", () => {
    it("evicts the least-recently-accessed entry when a new put would overflow", () => {
        const store = new ArtifactStore({ totalBytesCap: 100, singleArtifactCap: 100, ttlMs: 0 });
        const rA = store.put("A", 40);
        const rB = store.put("B", 40);
        expect(rA.stored).toBe(true);
        expect(rB.stored).toBe(true);
        if (!rA.stored || !rB.stored) throw new Error("unexpected");
        // Touch 'a' so 'b' becomes the LRU victim.
        expect(store.get(rA.key)).toMatchObject({ found: true });
        const r = store.put("C", 40); // 40+40+40=120 > 100, must evict 'b'
        expect(r.stored).toBe(true);
        if (r.stored) {
            expect(r.evicted).toEqual([{ key: rB.key, reason: "lru", size: 40 }]);
        }
        expect(store.get(rB.key)).toEqual({ found: false, evicted: true, reason: "lru", size: 40 });
        expect(store.get(rA.key)).toMatchObject({ found: true });
        if (r.stored) expect(store.get(r.key)).toMatchObject({ found: true });
    });

    it("can evict multiple entries in a single put to make room", () => {
        const store = new ArtifactStore({ totalBytesCap: 100, singleArtifactCap: 100, ttlMs: 0 });
        const rA = store.put("A", 30);
        const rB = store.put("B", 30);
        const rC = store.put("C", 30);
        expect(rA.stored && rB.stored && rC.stored).toBe(true);
        if (!rA.stored || !rB.stored || !rC.stored) throw new Error("unexpected");
        // Insert a 90-byte entry; only one of the existing 30s can stay (30+90=120>100,
        // so all three must go).
        const r = store.put("X", 90);
        expect(r.stored).toBe(true);
        if (r.stored) {
            // Eldest-first eviction order.
            expect(r.evicted.map((e) => e.key)).toEqual([rA.key, rB.key, rC.key]);
        }
        expect(store.stats().liveCount).toBe(1);
        expect(store.stats().liveBytes).toBe(90);
    });

    it("records a tombstone for every LRU-evicted entry", () => {
        const store = new ArtifactStore({ totalBytesCap: 50, singleArtifactCap: 50, ttlMs: 0 });
        const rA = store.put("A", 30);
        expect(rA.stored).toBe(true);
        if (!rA.stored) throw new Error("unexpected");
        const rB = store.put("B", 30); // forces 'a' out
        expect(rB.stored).toBe(true);
        const recall = store.get(rA.key);
        expect(recall).toEqual({ found: false, evicted: true, reason: "lru", size: 30 });
    });
});

describe("ArtifactStore TTL eviction", () => {
    it("expires entries whose lastAccess is older than ttlMs", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 1000, now: clock.now });
        const p = store.put("v", 4);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        clock.advance(500);
        expect(store.get(p.key)).toMatchObject({ found: true });
        clock.advance(1500); // 500 + 1500 = 2000 since last access > 1000
        expect(store.get(p.key)).toEqual({ found: false, evicted: true, reason: "ttl", size: 4 });
    });

    it("get() refreshes lastAccess (sliding TTL)", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 1000, now: clock.now });
        const p = store.put("v", 4);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        // Walk forward in 800ms steps and read each time — entry should never expire.
        for (let i = 0; i < 5; i++) {
            clock.advance(800);
            expect(store.get(p.key)).toMatchObject({ found: true });
        }
    });

    it("ttlMs = 0 disables TTL entirely", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 0, now: clock.now });
        const p = store.put("v", 4);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        clock.advance(10 * 365 * 24 * 60 * 60 * 1000); // 10 years
        expect(store.get(p.key)).toMatchObject({ found: true });
    });

    it("liveKeys() does not advertise expired entries", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 100, now: clock.now });
        const rA = store.put("A", 1);
        const rB = store.put("B", 1);
        expect(rA.stored && rB.stored).toBe(true);
        if (!rA.stored || !rB.stored) throw new Error("unexpected");
        clock.advance(50);
        store.put("C", 1); // refreshes nothing for a/b but sweeps (none yet)
        clock.advance(80); // a,b: 130 since access > 100; c: 80 < 100
        const keys = store.liveKeys();
        expect(keys).toHaveLength(1);
        // The sweep also produced tombstones for a and b.
        expect(store.get(rA.key)).toMatchObject({ found: false, evicted: true, reason: "ttl" });
        expect(store.get(rB.key)).toMatchObject({ found: false, evicted: true, reason: "ttl" });
    });
});

describe("ArtifactStore diskIndex (formerly tombstones)", () => {
    it("diskIndex is unbounded (no FIFO cap)", () => {
        const store = new ArtifactStore({
            totalBytesCap: 100,
            singleArtifactCap: 100,
            ttlMs: 0,
        });
        // Force many sequential LRU evictions by inserting entries
        // that overflow a 100-byte cap. Each new put evicts one entry.
        const keys: string[] = [];
        for (let i = 0; i < 10; i++) {
            const r = store.put(i, 51);
            if (r.stored) keys.push(r.key);
        }
        // After 10 puts into a 100-byte cap with 51-byte entries,
        // only the last entry is live. All 9 previous entries are in
        // diskIndex — no FIFO cap, so none are dropped.
        expect(store.stats().liveCount).toBe(1);
        expect(store.stats().diskIndexCount).toBe(9);
        // The first entry is still in diskIndex.
        expect(store.get(keys[0]!)).toMatchObject({ found: false, evicted: true, reason: "lru" });
    });

    it("tombstone reason is 'session_end' after clear()", () => {
        const store = new ArtifactStore();
        const p = store.put("v", 4);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        store.clear();
        expect(store.get(p.key)).toEqual({ found: false, evicted: true, reason: "session_end", size: 4 });
        expect(store.stats().liveCount).toBe(0);
        expect(store.stats().liveBytes).toBe(0);
    });

    it("tombstone reason updates if a tombstoned key gets re-tombstoned with a newer reason", () => {
        const clock = makeClock();
        const store = new ArtifactStore({ ttlMs: 100, now: clock.now });
        const p = store.put("v", 4);
        expect(p.stored).toBe(true);
        if (!p.stored) throw new Error("unexpected");
        clock.advance(200);
        // First observation: ttl tombstone.
        expect(store.get(p.key)).toMatchObject({ reason: "ttl" });
        // session_end on a key that's already tombstoned: only live
        // entries get session_end reasons, so this is a no-op. Verify
        // the original ttl reason survives.
        store.clear();
        expect(store.get(p.key)).toMatchObject({ reason: "ttl" });
    });
});

describe("ArtifactStore.stats", () => {
    it("tracks liveBytes and liveCount across put/get", () => {
        const store = new ArtifactStore({ totalBytesCap: 1000, singleArtifactCap: 1000, ttlMs: 0 });
        expect(store.stats()).toEqual({ liveCount: 0, liveBytes: 0, diskIndexCount: 0 });
        const rA = store.put("A", 100);
        const rB = store.put("B", 200);
        expect(rA.stored && rB.stored).toBe(true);
        expect(store.stats()).toEqual({ liveCount: 2, liveBytes: 300, diskIndexCount: 0 });
    });
});

// ─────────────────────────────────────────────
// Persistence tests (disk I/O via mock DataAdapter)
// ─────────────────────────────────────────────

/** Build a mock DataAdapter backed by an in-memory filesystem. */
function mockAdapter(): {
    adapter: DataAdapter;
    /** In-memory filesystem for pre-population / inspection. */
    files: Map<string, string>;
    /** Tracked call logs for assertions. */
    calls: {
        write: Array<{ path: string; data: string }>;
        read: string[];
        remove: string[];
        rmdir: Array<{ path: string; recursive: boolean }>;
        exists: string[];
        list: string[];
        mkdir: string[];
    };
} {
    const files = new Map<string, string>();
    const calls = {
        write: [] as Array<{ path: string; data: string }>,
        read: [] as string[],
        remove: [] as string[],
        rmdir: [] as Array<{ path: string; recursive: boolean }>,
        exists: [] as string[],
        list: [] as string[],
        mkdir: [] as string[],
    };

    const adapter = {
        getName: () => "mock",
        exists: vi.fn(async (path: string) => {
            calls.exists.push(path);
            // Check if this path is a known file.
            if (files.has(path)) return true;
            // Check if this path is a directory (any file has it as prefix).
            const dirPrefix = path.endsWith('/') ? path : path + '/';
            for (const [fp] of files) {
                if (fp.startsWith(dirPrefix)) return true;
            }
            return false;
        }),
        stat: vi.fn(async () => null),
        list: vi.fn(async (path: string) => {
            calls.list.push(path);
            const prefix = path.endsWith('/') ? path : path + '/';
            const result: string[] = [];
            for (const [fp] of files) {
                if (fp.startsWith(prefix)) {
                    const rest = fp.slice(prefix.length);
                    if (!rest.includes('/')) result.push(rest);
                }
            }
            return { files: result, folders: [] };
        }),
        read: vi.fn(async (path: string) => {
            calls.read.push(path);
            const content = files.get(path);
            if (content === undefined) throw new Error(`ENOENT: ${path}`);
            return content;
        }),
        readBinary: vi.fn(async () => new ArrayBuffer(0)),
        write: vi.fn(async (path: string, data: string) => {
            calls.write.push({ path, data });
            files.set(path, data);
        }),
        writeBinary: vi.fn(async () => {}),
        append: vi.fn(async () => {}),
        process: vi.fn(async (_path: string, fn: (data: string) => string) => {
            const content = files.get(_path) ?? "";
            const result = fn(content);
            files.set(_path, result);
            return result;
        }),
        getResourcePath: vi.fn((path: string) => path),
        mkdir: vi.fn(async (path: string) => {
            calls.mkdir.push(path);
        }),
        trashSystem: vi.fn(async () => true),
        trashLocal: vi.fn(async () => {}),
        rmdir: vi.fn(async (path: string, recursive: boolean) => {
            calls.rmdir.push({ path, recursive });
        }),
        remove: vi.fn(async (path: string) => {
            calls.remove.push(path);
            files.delete(path);
        }),
        rename: vi.fn(async () => {}),
        copy: vi.fn(async () => {}),
    } satisfies Partial<DataAdapter>;

    return { adapter: adapter as unknown as DataAdapter, files, calls };
}

/** Flush the microtask queue so fire-and-forget async work completes. */
async function flushMicrotasks(): Promise<void> {
    // Drain enough rounds for the full async chain:
    // exists → list → (per-file) read → JSON.parse → restoreEntry (sync)
    // Each await adds one microtask tick; we over-provision to be safe.
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
    }
}

describe("ArtifactStore persistence – put / write", () => {
    it("persists new entries to disk via adapter.write (fire-and-forget)", async () => {
        const { adapter, calls } = mockAdapter();
        const store = new ArtifactStore({
            totalBytesCap: 1000,
            singleArtifactCap: 1000,
            adapter,
            artifactsDir: "sessions/test/artifacts",
        });
        const r = store.put({ a: 1 }, 50);
        // Fire-and-forget — wait for the async write to settle.
        await flushMicrotasks();
        expect(calls.write.length).toBe(1);
        // File path uses the auto-generated key.
        expect(r.stored).toBe(true);
        if (!r.stored) throw new Error("unexpected");
        expect(calls.write[0].path).toBe(`sessions/test/artifacts/${r.key}.json`);
        const payload = JSON.parse(calls.write[0].data);
        expect(payload.v).toBe(1);
        expect(payload.key).toBe(r.key);
        expect(payload.size).toBe(50);
        expect(payload.value).toEqual({ a: 1 });
    });

    it("writes each put as separate file (no overwrite with unique keys)", async () => {
        const { adapter, calls } = mockAdapter();
        const store = new ArtifactStore({
            adapter,
            artifactsDir: "sessions/test/artifacts",
        });
        const r1 = store.put("v1", 10);
        await flushMicrotasks();
        const r2 = store.put("v2", 10);
        await flushMicrotasks();
        // Two writes: each with a unique key.
        expect(calls.write.length).toBe(2);
        expect(r1.stored && r2.stored).toBe(true);
        if (!r1.stored || !r2.stored) throw new Error("unexpected");
        const paths = calls.write.map(c => c.path);
        expect(paths[0]).toBe(`sessions/test/artifacts/${r1.key}.json`);
        expect(paths[1]).toBe(`sessions/test/artifacts/${r2.key}.json`);
        expect(paths[0]).not.toBe(paths[1]);
    });
});

describe("ArtifactStore persistence – recoverFromDisk", () => {
    it("restores artifacts from pre-existing disk files into live", async () => {
        const { adapter, files } = mockAdapter();
        const artifactsDir = "sessions/test/artifacts";

        // Pre-populate the virtual filesystem with two valid artifact files.
        const entry1 = { v: 1, key: "k1", size: 30, value: "hello" };
        const entry2 = { v: 1, key: "k2", size: 40, value: [1, 2, 3] };
        files.set(`${artifactsDir}/k1.json`, JSON.stringify(entry1));
        files.set(`${artifactsDir}/k2.json`, JSON.stringify(entry2));

        // Construct store — recoverFromDisk runs fire-and-forget.
        const store = new ArtifactStore({
            totalBytesCap: 1000,
            adapter,
            artifactsDir,
        });
        await flushMicrotasks();

        // Both entries should be live after recovery.
        expect(store.get("k1")).toEqual({ found: true, value: "hello", size: 30 });
        expect(store.get("k2")).toEqual({ found: true, value: [1, 2, 3], size: 40 });
        expect(store.stats().liveCount).toBe(2);
    });

    it("skips corrupt files during recovery (bad JSON)", async () => {
        const { adapter, files, calls } = mockAdapter();
        const artifactsDir = "sessions/test/artifacts";

        const good = { v: 1, key: "good", size: 10, value: "ok" };
        files.set(`${artifactsDir}/good.json`, JSON.stringify(good));
        files.set(`${artifactsDir}/bad.json`, "not valid json {{{");

        const store = new ArtifactStore({
            adapter,
            artifactsDir,
        });
        await flushMicrotasks();

        // Good entry restored; bad entry skipped.
        expect(store.get("good")).toMatchObject({ found: true });
        expect(store.get("bad")).toEqual({ found: false, evicted: false });
        // The corrupt file should have been removed (best-effort cleanup).
        expect(calls.remove).toContain(`${artifactsDir}/bad.json`);
    });

    it("skips files with missing/invalid shape during recovery", async () => {
        const { adapter, files } = mockAdapter();
        const artifactsDir = "sessions/test/artifacts";

        // Missing key field.
        files.set(`${artifactsDir}/no_key.json`, JSON.stringify({ v: 1, size: 10, value: "x" }));
        // Wrong version.
        files.set(`${artifactsDir}/wrong_v.json`, JSON.stringify({ v: 2, key: "w", size: 10, value: "x" }));
        // Empty key.
        files.set(`${artifactsDir}/empty_key.json`, JSON.stringify({ v: 1, key: "", size: 10, value: "x" }));

        const store = new ArtifactStore({ adapter, artifactsDir });
        await flushMicrotasks();

        expect(store.stats().liveCount).toBe(0);
    });

    it("honours totalBytesCap during recovery (LRU-evicts excess)", async () => {
        const { adapter, files } = mockAdapter();
        const artifactsDir = "sessions/test/artifacts";

        // Three 40-byte entries → 120 total, but cap is 100.
        files.set(`${artifactsDir}/a.json`, JSON.stringify({ v: 1, key: "a", size: 40, value: "A" }));
        files.set(`${artifactsDir}/b.json`, JSON.stringify({ v: 1, key: "b", size: 40, value: "B" }));
        files.set(`${artifactsDir}/c.json`, JSON.stringify({ v: 1, key: "c", size: 40, value: "C" }));

        const store = new ArtifactStore({
            totalBytesCap: 100,
            adapter,
            artifactsDir,
        });
        await flushMicrotasks();

        // Only two can fit (80 ≤ 100).
        expect(store.stats().liveCount).toBe(2);
        expect(store.stats().liveBytes).toBe(80);
        // The evicted one should be in diskIndex.
        expect(store.stats().diskIndexCount).toBe(1);
    });

    it("no-ops when artifacts directory does not exist", async () => {
        const { adapter } = mockAdapter();
        // No files pre-populated; exists() returns false.
        const store = new ArtifactStore({
            adapter,
            artifactsDir: "sessions/test/nonexistent",
        });
        await flushMicrotasks();
        expect(store.stats().liveCount).toBe(0);
        expect(store.stats().diskIndexCount).toBe(0);
    });
});

describe("ArtifactStore persistence – clear / delete", () => {
    it("clear() deletes artifact files and directory", async () => {
        const { adapter, calls, files } = mockAdapter();
        const artifactsDir = "sessions/test/artifacts";

        // Pre-populate disk with two files.
        files.set(`${artifactsDir}/k1.json`, JSON.stringify({ v: 1, key: "k1", size: 10, value: "a" }));
        files.set(`${artifactsDir}/k2.json`, JSON.stringify({ v: 1, key: "k2", size: 10, value: "b" }));

        const store = new ArtifactStore({ adapter, artifactsDir });
        const r = store.put("c", 10);
        await flushMicrotasks();

        store.clear();
        await flushMicrotasks();

        // Each file should have a remove call.
        expect(calls.remove).toContain(`${artifactsDir}/k1.json`);
        expect(calls.remove).toContain(`${artifactsDir}/k2.json`);
        if (r.stored) {
            expect(calls.remove).toContain(`${artifactsDir}/${r.key}.json`);
        }
        // rmdir should have been called.
        expect(calls.rmdir.some(c => c.path === artifactsDir && c.recursive === false)).toBe(true);
        // diskIndex cleared.
        expect(store.stats().diskIndexCount).toBe(0);
    });
});

describe("ArtifactStore persistence – get / diskIndex routing", () => {
    it("pure miss (never-put key) does NOT trigger adapter.read (zero I/O)", async () => {
        const { adapter, calls } = mockAdapter();
        const store = new ArtifactStore({
            adapter,
            artifactsDir: "sessions/test/artifacts",
        });
        // No put() calls — key is completely unknown.
        const result = store.get("never-seen");
        expect(result).toEqual({ found: false, evicted: false });
        // Zero I/O: adapter.read must not have been called.
        expect(calls.read.length).toBe(0);
    });

    it("diskIndex entry survives failed sync recovery (tombstone preserved)", async () => {
        const { adapter, files } = mockAdapter();
        const artifactsDir = "sessions/test/artifacts";

        // Put an entry, trigger LRU eviction by filling the cap.
        const store = new ArtifactStore({
            totalBytesCap: 100,
            singleArtifactCap: 100,
            adapter,
            artifactsDir,
        });
        const rKeep = store.put("K", 40);
        const rVictim = store.put("V", 40);
        expect(rKeep.stored && rVictim.stored).toBe(true);
        if (!rKeep.stored || !rVictim.stored) throw new Error("unexpected");
        // Touch 'keep' so 'victim' becomes LRU.
        store.get(rKeep.key);
        // This put (40+40+40=120 > 100) evicts 'victim'.
        store.put("N", 40);
        await flushMicrotasks(); // ensure persist completed

        // 'victim' should be in diskIndex (evicted, file on disk).
        expect(store.stats().diskIndexCount).toBe(1);

        // get('victim') — tryRestoreFromDisk returns null (sync limitation),
        // but the diskIndex entry MUST survive for future lookups.
        const firstGet = store.get(rVictim.key);
        expect(firstGet).toMatchObject({ found: false, evicted: true });
        expect(store.stats().diskIndexCount).toBe(1); // still there!

        // Second get — same result, diskIndex intact.
        const secondGet = store.get(rVictim.key);
        expect(secondGet).toMatchObject({ found: false, evicted: true });
        expect(store.stats().diskIndexCount).toBe(1);
    });
});
