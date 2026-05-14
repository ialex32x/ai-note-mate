import { describe, it, expect } from "vitest";
import { __TEST_ONLY__ } from "../src/services/tools/obsidian/edit/write-file";

const { buildHeadTailExcerpts, countLines, EXCERPT_HEAD_TAIL_CAP } = __TEST_ONLY__;

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers covered here; the full `exec` closure is not, because it
// depends on the Obsidian Vault API. The behaviour we care about for
// end-to-end correctness (excerpt shape, line-count parity with what
// Obsidian reports, size-mismatch diagnostic) is expressed entirely in
// these helpers; the closure is a thin wrapper over them plus I/O.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHeadTailExcerpts", () => {
    it("returns the full content as head (empty tail) when short enough", () => {
        const r = buildHeadTailExcerpts("hello world");
        expect(r.head).toBe("hello world");
        expect(r.tail).toBe("");
        expect(r.truncated).toBe(false);
    });

    it("returns the whole content as head when exactly at the no-split boundary", () => {
        // Up to 2 × cap, we keep head = full content so the caller
        // doesn't have to special-case "tail empty means file is small".
        const s = "a".repeat(EXCERPT_HEAD_TAIL_CAP * 2);
        const r = buildHeadTailExcerpts(s);
        expect(r.head).toBe(s);
        expect(r.tail).toBe("");
        expect(r.truncated).toBe(false);
    });

    it("splits into head + tail once content exceeds 2 × cap", () => {
        const head = "H".repeat(EXCERPT_HEAD_TAIL_CAP);
        const middle = "M".repeat(500);
        const tail = "T".repeat(EXCERPT_HEAD_TAIL_CAP);
        const s = head + middle + tail;

        const r = buildHeadTailExcerpts(s);
        expect(r.head).toBe(head);
        expect(r.tail).toBe(tail);
        expect(r.truncated).toBe(true);
        // Middle must not appear in either excerpt — that's the whole
        // point of head + tail (the middle is the LEAST representative
        // region of a wholesale rewrite).
        expect(r.head).not.toContain("M");
        expect(r.tail).not.toContain("M");
    });

    it("handles empty content", () => {
        const r = buildHeadTailExcerpts("");
        expect(r.head).toBe("");
        expect(r.tail).toBe("");
        expect(r.truncated).toBe(false);
    });

    it("preserves newlines and special characters verbatim", () => {
        const s = "# Heading\n\nSome body text.\n\n- item 1\n- item 2\n";
        const r = buildHeadTailExcerpts(s);
        expect(r.head).toBe(s);
        expect(r.head).toContain("\n");
    });
});

describe("countLines", () => {
    it("returns 0 for empty content", () => {
        expect(countLines("")).toBe(0);
    });

    it("returns 1 for a single line without a trailing newline", () => {
        expect(countLines("hello")).toBe(1);
    });

    it("does not count the trailing newline as an extra line", () => {
        // One real line, terminated. Most editors display this as 1 line.
        expect(countLines("hello\n")).toBe(1);
    });

    it("counts each real line", () => {
        expect(countLines("a\nb\nc")).toBe(3);
        expect(countLines("a\nb\nc\n")).toBe(3);
    });

    it("counts blank lines between content", () => {
        expect(countLines("a\n\nb")).toBe(3);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Parameter shape coverage for `exec` is intentionally kept minimal —
// the `requireFile` / vault I/O path is identical to `replace_text`'s
// (which is covered via the Obsidian mock in its own tests) and the
// diagnostic wording has no logic beyond string interpolation. The
// write path adds three decisions on top:
//
//  1. File not found → suggest `create_file`.
//  2. `expected_pre_edit_mtime` mismatch → refuse with actual vs expected.
//  3. `dry_run: true` → don't call `vault.modify`, still return envelope.
//
// (1) and (2) are pure-string checks that would require setting up an
// Obsidian mock to reach — not worth it for a 2-line branch. (3) is a
// boolean guard around `vault.modify`. If any of these grow beyond
// trivial, migrate those checks out of exec into a pure helper and
// test here, the same way we handled excerpt generation.
// ─────────────────────────────────────────────────────────────────────────────
