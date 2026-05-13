import { describe, it, expect } from "vitest";
import { GlobalFileLockManager } from "../src/services/vault/file-lock-manager";

/**
 * Tests for the cross-session file lock table.
 *
 * The lock table is pure synchronous in-memory state; no I/O, no
 * timers, no async. These tests cover the invariants the rest of
 * the checkpoint system relies on:
 *
 *   - same-session re-acquire bumps refCount and never fails,
 *   - cross-session acquire fails with the holder's session id,
 *   - release drops refCount and removes the entry at zero,
 *   - isHeldByOther distinguishes self / other / unheld,
 *   - rename transfer succeeds in the easy cases and rejects
 *     conflicting cross-session targets.
 */

describe("GlobalFileLockManager", () => {
    it("acquires a free path for a session", () => {
        const lm = new GlobalFileLockManager();
        expect(lm.tryAcquire("X.md", "A")).toEqual({ ok: true });
        expect(lm.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 1 });
        expect(lm.size).toBe(1);
    });

    it("nests same-session re-acquires by bumping refCount", () => {
        const lm = new GlobalFileLockManager();
        lm.tryAcquire("X.md", "A");
        expect(lm.tryAcquire("X.md", "A")).toEqual({ ok: true });
        expect(lm.tryAcquire("X.md", "A")).toEqual({ ok: true });
        expect(lm.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 3 });
    });

    it("refuses cross-session acquire with holder's session id", () => {
        const lm = new GlobalFileLockManager();
        lm.tryAcquire("X.md", "A");
        const r = lm.tryAcquire("X.md", "B");
        expect(r).toEqual({ ok: false, heldBy: "A" });
        expect(lm.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 1 });
    });

    it("releases by ref count and removes entry at zero", () => {
        const lm = new GlobalFileLockManager();
        lm.tryAcquire("X.md", "A");
        lm.tryAcquire("X.md", "A");
        lm.release("X.md", "A");
        expect(lm.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 1 });
        lm.release("X.md", "A");
        expect(lm.getHolder("X.md")).toBeUndefined();
        expect(lm.size).toBe(0);
    });

    it("ignores release calls from non-owners (defensive)", () => {
        const lm = new GlobalFileLockManager();
        lm.tryAcquire("X.md", "A");
        // Intentionally wrong owner — must not corrupt state.
        lm.release("X.md", "B");
        expect(lm.getHolder("X.md")).toEqual({ sessionId: "A", refCount: 1 });
    });

    it("isHeldByOther distinguishes self / other / unheld", () => {
        const lm = new GlobalFileLockManager();
        expect(lm.isHeldByOther("X.md", "A")).toBe(false);
        lm.tryAcquire("X.md", "A");
        expect(lm.isHeldByOther("X.md", "A")).toBe(false);
        expect(lm.isHeldByOther("X.md", "B")).toBe(true);
        expect(lm.isHeldByOther("X.md", undefined)).toBe(true);
    });

    it("transfers a single entry on rename", () => {
        const lm = new GlobalFileLockManager();
        lm.tryAcquire("Old.md", "A");
        lm.tryAcquire("Old.md", "A"); // refCount 2
        const r = lm.transferOnRename("Old.md", "New.md");
        expect(r).toEqual({ ok: true });
        expect(lm.getHolder("Old.md")).toBeUndefined();
        expect(lm.getHolder("New.md")).toEqual({ sessionId: "A", refCount: 2 });
    });

    it("rename onto an unlocked target is a no-op when source is unlocked", () => {
        const lm = new GlobalFileLockManager();
        expect(lm.transferOnRename("Old.md", "New.md")).toEqual({ ok: true });
        expect(lm.size).toBe(0);
    });

    it("rename merges ref counts when target is owned by the same session", () => {
        const lm = new GlobalFileLockManager();
        lm.tryAcquire("Old.md", "A");           // refCount 1 at Old
        lm.tryAcquire("New.md", "A");           // refCount 1 at New
        lm.tryAcquire("New.md", "A");           // refCount 2 at New
        expect(lm.transferOnRename("Old.md", "New.md")).toEqual({ ok: true });
        expect(lm.getHolder("Old.md")).toBeUndefined();
        expect(lm.getHolder("New.md")).toEqual({ sessionId: "A", refCount: 3 });
    });

    it("rename fails when target is held by a different session", () => {
        const lm = new GlobalFileLockManager();
        lm.tryAcquire("Old.md", "A");
        lm.tryAcquire("New.md", "B");
        const r = lm.transferOnRename("Old.md", "New.md");
        expect(r).toEqual({ ok: false, heldBy: "B" });
        // Both entries unchanged
        expect(lm.getHolder("Old.md")).toEqual({ sessionId: "A", refCount: 1 });
        expect(lm.getHolder("New.md")).toEqual({ sessionId: "B", refCount: 1 });
    });
});
