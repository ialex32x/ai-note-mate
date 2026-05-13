import { describe, it, expect, vi } from "vitest";
import { CheckpointStore } from "../src/services/vault/checkpoint-store";
import { GlobalFileLockManager } from "../src/services/vault/file-lock-manager";
import { TFile } from "obsidian";

/**
 * Tests for the per-session checkpoint state machine.
 *
 * Scope:
 *   - openIfNeeded: lazy creation, re-use on same anchor, new on
 *     different anchor.
 *   - registerFile: lock acquire, snapshot capture for modify,
 *     idempotent within a single checkpoint, cross-session
 *     rejection.
 *   - accept: terminates the target + all earlier pending,
 *     releases locks, deletes snapshots.
 *   - discard: terminates the target + all later pending, restores
 *     modify entries from snapshots in latest-first order, releases
 *     locks, deletes snapshots.
 *   - acceptAllPending: silent terminal transition used by
 *     SessionRuntime.dispose.
 *   - hasPending: reflects state correctly across the lifecycle.
 *
 * The SnapshotManager and App.vault are mocked with in-memory shims
 * so tests stay pure / synchronous-flavoured (single microtask
 * await) and don't touch the filesystem.
 */

interface FakeSnapshot { content: string; deleted: boolean }

function makeSnapshotManager() {
    const store = new Map<string, Map<string, FakeSnapshot>>();
    let nextId = 0;
    return {
        store,
        async takeContent(checkpointId: string, content: string): Promise<string> {
            const id = `snap-${++nextId}`;
            let bucket = store.get(checkpointId);
            if (!bucket) { bucket = new Map(); store.set(checkpointId, bucket); }
            bucket.set(id, { content, deleted: false });
            return id;
        },
        async readContent(checkpointId: string, snapshotId: string): Promise<string | null> {
            const bucket = store.get(checkpointId);
            const e = bucket?.get(snapshotId);
            if (!e || e.deleted) return null;
            return e.content;
        },
        async deleteCheckpoint(checkpointId: string): Promise<void> {
            const bucket = store.get(checkpointId);
            if (!bucket) return;
            for (const e of bucket.values()) e.deleted = true;
            store.delete(checkpointId);
        },
        // Test helpers.
        snapshotCount(): number {
            let n = 0;
            for (const bucket of store.values()) {
                for (const e of bucket.values()) if (!e.deleted) n++;
            }
            return n;
        },
    };
}

/**
 * Minimal in-memory App stand-in. `files` is the shared map; `folders`
 * is the set of folder paths the test has explicitly registered.
 * Together they provide enough surface for CheckpointStore to drive
 * its restore paths (modify / create / delete / rename) without
 * touching a real Obsidian runtime.
 */
function makeApp(files: Map<string, string>, folders: Set<string> = new Set([""])) {
    const ensureParentTracked = (path: string) => {
        const parent = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
        folders.add(parent);
    };
    return {
        vault: {
            getAbstractFileByPath: (path: string) => {
                if (folders.has(path)) {
                    // Distinguish folders from files via a `children`
                    // field — checkpoint store only does instanceof TFile
                    // checks, so a non-TFile object suffices.
                    return { path, children: [] };
                }
                if (!files.has(path)) return null;
                return new TFile(path);
            },
            modify: vi.fn(async (file: TFile, content: string) => {
                files.set(file.path, content);
            }),
            create: vi.fn(async (path: string, content: string) => {
                files.set(path, content);
                ensureParentTracked(path);
                return new TFile(path);
            }),
            createFolder: vi.fn(async (path: string) => {
                folders.add(path);
            }),
        },
        fileManager: {
            trashFile: vi.fn(async (file: { path: string }) => {
                files.delete(file.path);
            }),
            renameFile: vi.fn(async (file: { path: string }, newPath: string) => {
                const content = files.get(file.path);
                if (content !== undefined) {
                    files.delete(file.path);
                    files.set(newPath, content);
                }
            }),
        },
    };
}

function makeStore(opts?: { sessionId?: string; files?: Map<string, string> }) {
    const files = opts?.files ?? new Map<string, string>();
    const lockManager = new GlobalFileLockManager();
    const snapshotManager = makeSnapshotManager();
    const app = makeApp(files);
    const cs = new CheckpointStore({
        sessionId: opts?.sessionId ?? "A",
        lockManager,
        snapshotManager: snapshotManager as unknown as never,
        app: app as unknown as never,
    });
    return { cs, lockManager, snapshotManager, app, files };
}

describe("CheckpointStore.openIfNeeded", () => {
    it("creates a fresh checkpoint on first call", () => {
        const { cs } = makeStore();
        expect(cs.current).toBeUndefined();
        const cp = cs.openIfNeeded("user-1");
        expect(cp.anchorMessageId).toBe("user-1");
        expect(cp.status).toBe("pending");
        expect(cs.current).toBe(cp);
        expect(cs.checkpoints.length).toBe(1);
    });

    it("re-uses the open checkpoint when the same anchor comes in again", () => {
        const { cs } = makeStore();
        const cp1 = cs.openIfNeeded("user-1");
        const cp2 = cs.openIfNeeded("user-1");
        expect(cp2).toBe(cp1);
        expect(cs.checkpoints.length).toBe(1);
    });

    it("opens a new checkpoint when the anchor changes (new round)", () => {
        const { cs } = makeStore();
        const cp1 = cs.openIfNeeded("user-1");
        const cp2 = cs.openIfNeeded("user-2");
        expect(cp2).not.toBe(cp1);
        expect(cs.checkpoints.length).toBe(2);
        expect(cs.current).toBe(cp2);
    });
});

describe("CheckpointStore.registerFile", () => {
    it("acquires the lock and captures a snapshot for a fresh modify", async () => {
        const files = new Map([["X.md", "original"]]);
        const { cs, lockManager, snapshotManager } = makeStore({ files });
        cs.openIfNeeded("user-1");
        const r = await cs.registerFile({
            path: "X.md",
            kind: "modify",
            preEditContent: "original",
        });
        expect(r).toEqual({ ok: true, alreadyInCheckpoint: false });
        expect(lockManager.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 1 });
        expect(snapshotManager.snapshotCount()).toBe(1);
    });

    it("is idempotent for the same path within one checkpoint (no extra snapshot, no extra ref count)", async () => {
        const { cs, lockManager, snapshotManager } = makeStore();
        cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v1" });
        const r2 = await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v1" });
        expect(r2).toEqual({ ok: true, alreadyInCheckpoint: true });
        expect(lockManager.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 1 });
        expect(snapshotManager.snapshotCount()).toBe(1);
    });

    it("refuses cross-session acquire and surfaces the holder", async () => {
        const sharedLock = new GlobalFileLockManager();
        const snapshotManager = makeSnapshotManager();
        const files = new Map([["X.md", "v"]]);
        const csA = new CheckpointStore({
            sessionId: "A", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(files) as unknown as never,
        });
        const csB = new CheckpointStore({
            sessionId: "B", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(files) as unknown as never,
        });
        csA.openIfNeeded("a-1");
        await csA.registerFile({ path: "X.md", kind: "modify", preEditContent: "v" });

        csB.openIfNeeded("b-1");
        const r = await csB.registerFile({ path: "X.md", kind: "modify", preEditContent: "v" });
        expect(r).toEqual({ ok: false, heldBy: "A" });
    });

    it("acquires a lock without snapshot for non-modify kinds (Phase 1: lock-only)", async () => {
        const { cs, lockManager, snapshotManager } = makeStore();
        cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "create" });
        expect(lockManager.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 1 });
        expect(snapshotManager.snapshotCount()).toBe(0);
    });
});

describe("CheckpointStore.accept", () => {
    it("terminates the checkpoint, releases locks, and deletes snapshots", async () => {
        const { cs, lockManager, snapshotManager } = makeStore();
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v" });
        expect(snapshotManager.snapshotCount()).toBe(1);

        await cs.accept(cp.id);
        expect(cp.status).toBe("accepted");
        expect(typeof cp.terminatedAt).toBe("number");
        expect(lockManager.getHolder("X.md")).toBeUndefined();
        expect(snapshotManager.snapshotCount()).toBe(0);
        expect(cs.hasPending).toBe(false);
    });

    it("auto-accepts every earlier pending checkpoint", async () => {
        const { cs, lockManager } = makeStore();
        const cp1 = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v1" });
        const cp2 = cs.openIfNeeded("user-2");
        await cs.registerFile({ path: "Y.md", kind: "modify", preEditContent: "y" });
        const cp3 = cs.openIfNeeded("user-3");
        await cs.registerFile({ path: "Z.md", kind: "modify", preEditContent: "z" });

        await cs.accept(cp2.id);

        expect(cp1.status).toBe("accepted");
        expect(cp2.status).toBe("accepted");
        expect(cp3.status).toBe("pending");
        expect(lockManager.getHolder("X.md")).toBeUndefined();
        expect(lockManager.getHolder("Y.md")).toBeUndefined();
        expect(lockManager.getHolder("Z.md")).toEqual({ sessionId: "A", refCount: 1 });
    });

    it("is a no-op when the checkpoint is missing or already terminal", async () => {
        const { cs } = makeStore();
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v" });
        await cs.accept(cp.id);
        const prevStatus = cp.status;
        await cs.accept(cp.id); // second call no-op
        await cs.accept("does-not-exist");
        expect(cp.status).toBe(prevStatus);
    });
});

describe("CheckpointStore lazy checkpoint open (anchor mode)", () => {
    it("registerFile with anchor opens a checkpoint only after the lock succeeds", async () => {
        const { cs } = makeStore();
        expect(cs.checkpoints.length).toBe(0);
        const r = await cs.registerFile(
            { path: "X.md", kind: "modify", preEditContent: "v" },
            "user-1",
        );
        expect(r).toEqual({ ok: true, alreadyInCheckpoint: false });
        expect(cs.checkpoints.length).toBe(1);
        expect(cs.checkpoints[0]?.anchorMessageId).toBe("user-1");
        expect(cs.checkpoints[0]?.files.size).toBe(1);
    });

    it("does NOT create a checkpoint when the lock acquire fails", async () => {
        const sharedLock = new GlobalFileLockManager();
        const snapshotManager = makeSnapshotManager();
        const csA = new CheckpointStore({
            sessionId: "A", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map([["X.md", "v"]])) as unknown as never,
        });
        const csB = new CheckpointStore({
            sessionId: "B", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map([["X.md", "v"]])) as unknown as never,
        });

        // A holds X.md.
        const okR = await csA.registerFile(
            { path: "X.md", kind: "modify", preEditContent: "v" },
            "a-1",
        );
        expect(okR.ok).toBe(true);

        // B tries to grab X.md — must fail AND must NOT leave an
        // empty pending checkpoint in B's list.
        expect(csB.checkpoints.length).toBe(0);
        const failR = await csB.registerFile(
            { path: "X.md", kind: "modify", preEditContent: "v" },
            "b-1",
        );
        expect(failR).toEqual({ ok: false, heldBy: "A" });
        expect(csB.checkpoints.length).toBe(0);
        expect(csB.hasPending).toBe(false);
    });

    it("does NOT create a checkpoint when a registerBatch lock conflict aborts the whole batch", async () => {
        const sharedLock = new GlobalFileLockManager();
        const snapshotManager = makeSnapshotManager();
        const csA = new CheckpointStore({
            sessionId: "A", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map()) as unknown as never,
        });
        const csB = new CheckpointStore({
            sessionId: "B", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map()) as unknown as never,
        });

        // A holds B.md.
        await csA.registerFile({ path: "B.md", kind: "delete", preEditContent: "v" }, "a-1");

        // B tries to batch [A.md, B.md] — second one conflicts.
        // Whole batch rolls back. No checkpoint on B's side.
        const failR = await csB.registerBatch(
            [
                { path: "A.md", kind: "delete", preEditContent: "a" },
                { path: "B.md", kind: "delete", preEditContent: "b" },
            ],
            "b-1",
        );
        expect(failR.ok).toBe(false);
        expect(csB.checkpoints.length).toBe(0);
    });

    it("reuses an already-open checkpoint when the anchor matches", async () => {
        const { cs } = makeStore();
        await cs.registerFile({ path: "A.md", kind: "modify", preEditContent: "a" }, "user-1");
        await cs.registerFile({ path: "B.md", kind: "modify", preEditContent: "b" }, "user-1");
        expect(cs.checkpoints.length).toBe(1);
        expect(cs.checkpoints[0]?.files.size).toBe(2);
    });

    it("opens a new checkpoint when the anchor differs (new round)", async () => {
        const { cs } = makeStore();
        await cs.registerFile({ path: "A.md", kind: "modify", preEditContent: "a" }, "user-1");
        await cs.registerFile({ path: "B.md", kind: "modify", preEditContent: "b" }, "user-2");
        expect(cs.checkpoints.length).toBe(2);
        expect(cs.checkpoints[0]?.anchorMessageId).toBe("user-1");
        expect(cs.checkpoints[1]?.anchorMessageId).toBe("user-2");
    });
});

describe("CheckpointStore rename lock semantics", () => {
    it("acquires locks on BOTH the new path and the previous path", async () => {
        const { cs, lockManager } = makeStore();
        cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "New.md", kind: "rename", previousPath: "Old.md" });
        expect(lockManager.getHolder("New.md")).toEqual({ sessionId: "A", refCount: 1 });
        expect(lockManager.getHolder("Old.md")).toEqual({ sessionId: "A", refCount: 1 });
    });

    it("releases BOTH locks on accept", async () => {
        const { cs, lockManager } = makeStore();
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "New.md", kind: "rename", previousPath: "Old.md" });
        await cs.accept(cp.id);
        expect(lockManager.getHolder("New.md")).toBeUndefined();
        expect(lockManager.getHolder("Old.md")).toBeUndefined();
    });

    it("releases BOTH locks on discard (after rolling the rename back)", async () => {
        const files = new Map([["Old.md", "x"]]);
        const { cs, lockManager, files: liveFiles } = makeStore({ files });
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "New.md", kind: "rename", previousPath: "Old.md" });
        liveFiles.set("New.md", liveFiles.get("Old.md")!);
        liveFiles.delete("Old.md");

        await cs.discard(cp.id);

        expect(liveFiles.has("Old.md")).toBe(true);
        expect(lockManager.getHolder("New.md")).toBeUndefined();
        expect(lockManager.getHolder("Old.md")).toBeUndefined();
    });

    it("fails when the source path is locked by ANOTHER session, and releases the new-path lock taken first", async () => {
        const sharedLock = new GlobalFileLockManager();
        const snapshotManager = makeSnapshotManager();
        const csA = new CheckpointStore({
            sessionId: "A", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map([["Old.md", "v"]])) as unknown as never,
        });
        const csB = new CheckpointStore({
            sessionId: "B", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map([["Old.md", "v"]])) as unknown as never,
        });

        // Session A grabs Old.md first (e.g., from an earlier modify).
        csA.openIfNeeded("a-1");
        await csA.registerFile({ path: "Old.md", kind: "modify", preEditContent: "v" });

        // Session B tries to rename Old.md → New.md.
        csB.openIfNeeded("b-1");
        const r = await csB.registerFile({
            path: "New.md", kind: "rename", previousPath: "Old.md",
        });
        expect(r).toEqual({ ok: false, heldBy: "A" });
        // B did NOT keep a stray lock on New.md.
        expect(sharedLock.getHolder("New.md")).toBeUndefined();
        // A's lock on Old.md is intact.
        expect(sharedLock.getHolder("Old.md")).toEqual({ sessionId: "A", refCount: 1 });
    });

    it("rename inside registerBatch acquires both locks and rolls back cleanly on conflict", async () => {
        const sharedLock = new GlobalFileLockManager();
        const snapshotManager = makeSnapshotManager();
        const csA = new CheckpointStore({
            sessionId: "A", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map()) as unknown as never,
        });
        const csB = new CheckpointStore({
            sessionId: "B", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map()) as unknown as never,
        });

        // A holds OldB.md (e.g., from a prior modify in another round).
        csA.openIfNeeded("a-1");
        await csA.registerFile({ path: "OldB.md", kind: "modify", preEditContent: "v" });

        // B tries to atomically register two renames; the second one's
        // previousPath collides with A's lock. The whole batch must roll
        // back — no stale locks at NewA.md / OldA.md / NewB.md.
        csB.openIfNeeded("b-1");
        const r = await csB.registerBatch([
            { path: "NewA.md", kind: "rename", previousPath: "OldA.md" },
            { path: "NewB.md", kind: "rename", previousPath: "OldB.md" },
        ]);
        expect(r).toEqual({ ok: false, heldBy: "A" });
        expect(sharedLock.getHolder("NewA.md")).toBeUndefined();
        expect(sharedLock.getHolder("OldA.md")).toBeUndefined();
        expect(sharedLock.getHolder("NewB.md")).toBeUndefined();
        expect(sharedLock.getHolder("OldB.md")).toEqual({ sessionId: "A", refCount: 1 });
    });

    it("blocks another session from grabbing the rename SOURCE path while the checkpoint is pending", async () => {
        const sharedLock = new GlobalFileLockManager();
        const snapshotManager = makeSnapshotManager();
        const csA = new CheckpointStore({
            sessionId: "A", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map([["Old.md", "v"]])) as unknown as never,
        });
        const csB = new CheckpointStore({
            sessionId: "B", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(new Map()) as unknown as never,
        });

        // A renames Old.md → New.md (no prior lock at Old.md).
        csA.openIfNeeded("a-1");
        await csA.registerFile({ path: "New.md", kind: "rename", previousPath: "Old.md" });

        // B tries to create a new file at Old.md → must be refused
        // even though there is no physical file there anymore.
        csB.openIfNeeded("b-1");
        const r = await csB.registerFile({ path: "Old.md", kind: "create" });
        expect(r).toEqual({ ok: false, heldBy: "A" });
    });
});

describe("CheckpointStore.registerBatch", () => {
    it("registers every entry atomically when all locks are free", async () => {
        const { cs, lockManager, snapshotManager } = makeStore();
        cs.openIfNeeded("user-1");
        const r = await cs.registerBatch([
            { path: "A.md", kind: "delete", preEditContent: "a" },
            { path: "B.md", kind: "delete", preEditContent: "b" },
            { path: "C.md", kind: "delete" }, // no snapshot — lock-only
        ]);
        expect(r).toEqual({ ok: true, alreadyInCheckpoint: false });
        expect(lockManager.getHolder("A.md")?.refCount).toBe(1);
        expect(lockManager.getHolder("B.md")?.refCount).toBe(1);
        expect(lockManager.getHolder("C.md")?.refCount).toBe(1);
        expect(snapshotManager.snapshotCount()).toBe(2);
        expect(cs.current?.files.size).toBe(3);
    });

    it("rolls back partial acquires on the first cross-session conflict", async () => {
        const sharedLock = new GlobalFileLockManager();
        const snapshotManager = makeSnapshotManager();
        const files = new Map([["X.md", "v"], ["Y.md", "v"], ["Z.md", "v"]]);
        const csA = new CheckpointStore({
            sessionId: "A", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(files) as unknown as never,
        });
        const csB = new CheckpointStore({
            sessionId: "B", lockManager: sharedLock,
            snapshotManager: snapshotManager as unknown as never,
            app: makeApp(files) as unknown as never,
        });

        // Session A grabs Y.md first.
        csA.openIfNeeded("a-1");
        await csA.registerFile({ path: "Y.md", kind: "delete", preEditContent: "v" });

        // Session B tries to batch-register [X, Y, Z]; Y is the
        // conflict, but the rollback must release any locks B picked
        // up for X before it hit Y.
        csB.openIfNeeded("b-1");
        const r = await csB.registerBatch([
            { path: "X.md", kind: "delete", preEditContent: "v" },
            { path: "Y.md", kind: "delete", preEditContent: "v" },
            { path: "Z.md", kind: "delete", preEditContent: "v" },
        ]);
        expect(r).toEqual({ ok: false, heldBy: "A" });
        expect(sharedLock.getHolder("X.md")).toBeUndefined();
        expect(sharedLock.getHolder("Z.md")).toBeUndefined();
        // Y.md is still A's.
        expect(sharedLock.getHolder("Y.md")?.sessionId).toBe("A");
        // No snapshots written for B.
        expect(csB.current?.files.size).toBe(0);
    });

    it("idempotent for paths already in the checkpoint", async () => {
        const { cs, snapshotManager } = makeStore();
        cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "A.md", kind: "delete", preEditContent: "a" });
        const snapshotsBefore = snapshotManager.snapshotCount();
        await cs.registerBatch([
            { path: "A.md", kind: "delete", preEditContent: "a" }, // already in
            { path: "B.md", kind: "delete", preEditContent: "b" }, // new
        ]);
        expect(snapshotManager.snapshotCount()).toBe(snapshotsBefore + 1);
        expect(cs.current?.files.size).toBe(2);
    });
});

describe("CheckpointStore.discard", () => {
    it("restores modify entries from snapshots and releases locks", async () => {
        const files = new Map([["X.md", "v1"]]);
        const { cs, lockManager, app, snapshotManager } = makeStore({ files });
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v1" });

        // Simulate the perform: file now has "v2"
        files.set("X.md", "v2");

        await cs.discard(cp.id);

        expect(cp.status).toBe("discarded");
        expect(typeof cp.terminatedAt).toBe("number");
        expect(app.vault.modify).toHaveBeenCalledTimes(1);
        // Restored to original
        expect(files.get("X.md")).toBe("v1");
        expect(lockManager.getHolder("X.md")).toBeUndefined();
        expect(snapshotManager.snapshotCount()).toBe(0);
    });

    it("auto-discards every later pending checkpoint, latest-first", async () => {
        const files = new Map([["X.md", "v1"]]);
        const { cs, lockManager, app } = makeStore({ files });
        const cp1 = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v1" });
        files.set("X.md", "v2");

        const cp2 = cs.openIfNeeded("user-2");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v2" });
        files.set("X.md", "v3");

        const cp3 = cs.openIfNeeded("user-3");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v3" });
        files.set("X.md", "v4");

        await cs.discard(cp1.id);

        expect(cp1.status).toBe("discarded");
        expect(cp2.status).toBe("discarded");
        expect(cp3.status).toBe("discarded");

        // Restored back to v1 by chained restores (v3 → v2 → v1).
        expect(files.get("X.md")).toBe("v1");

        // modify called for each checkpoint's restore (3 total)
        expect(app.vault.modify).toHaveBeenCalledTimes(3);

        // First restore call was for cp3's snapshot (latest first).
        const calls = app.vault.modify.mock.calls;
        expect(calls[0]?.[1]).toBe("v3");
        expect(calls[1]?.[1]).toBe("v2");
        expect(calls[2]?.[1]).toBe("v1");

        // Both files at v1 lock entries cleared.
        expect(lockManager.getHolder("X.md")).toBeUndefined();
    });

    it("rolls back create entries by trashing the file we created", async () => {
        const files = new Map<string, string>();
        const { cs, app } = makeStore({ files });
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "New.md", kind: "create" });
        // Simulate the create's perform.
        files.set("New.md", "fresh content");

        await cs.discard(cp.id);

        expect(cp.status).toBe("discarded");
        expect(app.fileManager.trashFile).toHaveBeenCalledTimes(1);
        expect(files.has("New.md")).toBe(false);
    });

    it("rolls back delete entries by re-creating the file with its snapshot content", async () => {
        const files = new Map([["A.md", "original-a"]]);
        const { cs, app } = makeStore({ files });
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "A.md", kind: "delete", preEditContent: "original-a" });
        // Simulate the delete's perform.
        files.delete("A.md");

        await cs.discard(cp.id);

        expect(cp.status).toBe("discarded");
        expect(app.vault.create).toHaveBeenCalledTimes(1);
        expect(files.get("A.md")).toBe("original-a");
    });

    it("rolls back rename entries by reversing the rename", async () => {
        const files = new Map([["Old.md", "x"]]);
        const { cs, app, files: liveFiles } = makeStore({ files });
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "New.md", kind: "rename", previousPath: "Old.md" });
        // Simulate the rename's perform.
        liveFiles.set("New.md", liveFiles.get("Old.md")!);
        liveFiles.delete("Old.md");

        await cs.discard(cp.id);

        expect(cp.status).toBe("discarded");
        expect(app.fileManager.renameFile).toHaveBeenCalledTimes(1);
        expect(liveFiles.has("Old.md")).toBe(true);
        expect(liveFiles.has("New.md")).toBe(false);
    });

    it("within one checkpoint, restores rename → modify → create → delete", async () => {
        // Build a mix of all four kinds in a single round and confirm
        // the rollback order is correct end-to-end:
        //   - Renamed.md → renamed back to Old.md
        //   - Modified.md → content restored
        //   - Created.md → trashed
        //   - Deleted.md → re-created
        const files = new Map<string, string>([
            ["Renamed.md", "renamed-content"],   // result of rename
            ["Modified.md", "after-modify"],     // result of modify
            ["Created.md", "fresh-content"],     // result of create
            // Deleted.md is absent (deleted)
        ]);
        const { cs, app } = makeStore({ files });
        const cp = cs.openIfNeeded("user-1");

        await cs.registerBatch([
            { path: "Renamed.md", kind: "rename", previousPath: "Old.md" },
            { path: "Modified.md", kind: "modify", preEditContent: "before-modify" },
            { path: "Created.md", kind: "create" },
            { path: "Deleted.md", kind: "delete", preEditContent: "original-deleted" },
        ]);

        await cs.discard(cp.id);

        // Rename rolled back
        expect(files.has("Renamed.md")).toBe(false);
        expect(files.get("Old.md")).toBe("renamed-content");
        // Modify rolled back
        expect(files.get("Modified.md")).toBe("before-modify");
        // Create rolled back (trashed)
        expect(files.has("Created.md")).toBe(false);
        expect(app.fileManager.trashFile).toHaveBeenCalled();
        // Delete rolled back (re-created)
        expect(files.get("Deleted.md")).toBe("original-deleted");
    });

    it("create-then-rename-onto-that-path inside one checkpoint rolls back cleanly", async () => {
        // Tricky scenario: round creates Tmp.md, then renames an
        // earlier file Other.md → Tmp.md... actually rename target
        // must not exist at register time, so we test the inverse:
        // create P, then rename P → Q. Both in one round.
        const files = new Map<string, string>();
        const { cs } = makeStore({ files });
        const cp = cs.openIfNeeded("user-1");

        // Simulate the sequence: create P → file at P; rename P→Q → file at Q.
        await cs.registerFile({ path: "P.md", kind: "create" });
        files.set("P.md", "from-create");
        await cs.registerFile({ path: "Q.md", kind: "rename", previousPath: "P.md" });
        files.set("Q.md", files.get("P.md")!);
        files.delete("P.md");

        await cs.discard(cp.id);

        // Rename runs first → Q renamed back to P. Then create
        // entry trashes P. Net: both gone.
        expect(files.has("P.md")).toBe(false);
        expect(files.has("Q.md")).toBe(false);
    });
});

describe("CheckpointStore.acceptAllPending", () => {
    it("silently terminates every pending checkpoint", async () => {
        const { cs, lockManager, snapshotManager } = makeStore();
        const cp1 = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v" });
        const cp2 = cs.openIfNeeded("user-2");
        await cs.registerFile({ path: "Y.md", kind: "modify", preEditContent: "y" });

        await cs.acceptAllPending();

        expect(cp1.status).toBe("accepted");
        expect(cp2.status).toBe("accepted");
        expect(lockManager.size).toBe(0);
        expect(snapshotManager.snapshotCount()).toBe(0);
        expect(cs.hasPending).toBe(false);
    });

    it("is safe to call when there are no checkpoints", async () => {
        const { cs } = makeStore();
        await cs.acceptAllPending();
        expect(cs.hasPending).toBe(false);
    });
});

describe("CheckpointStore.hasPending", () => {
    it("reflects state transitions correctly", async () => {
        const { cs } = makeStore();
        expect(cs.hasPending).toBe(false);
        const cp = cs.openIfNeeded("user-1");
        await cs.registerFile({ path: "X.md", kind: "modify", preEditContent: "v" });
        expect(cs.hasPending).toBe(true);
        await cs.accept(cp.id);
        expect(cs.hasPending).toBe(false);
    });
});
