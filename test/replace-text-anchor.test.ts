import { describe, it, expect } from "vitest";
import { __TEST_ONLY__ } from "../src/services/tools/obsidian/edit/replace-text";
import type { HeadingNode } from "../src/services/tools/obsidian/heading-section";
import type { AnchorEntry, AnchorWhere } from "../src/services/tools/obsidian/edit/replace-text";

const {
    buildLineStarts,
    resolveAnchorEntry,
    padForGap,
    sectionLinesToOffsets,
    buildSpanExcerpts,
    EXCERPT_HARD_CAP,
    EXCERPT_CONTEXT_CHARS,
} = __TEST_ONLY__;

// ─────────────────────────────────────────────────────────────────────────────
// Sample fixture: a small markdown file with a couple of nested sections.
//
//   line 1: # Chapter 1
//   line 2: (blank)
//   line 3: intro line A
//   line 4: ## Body
//   line 5: body line 1
//   line 6: body line 2
//   line 7: ### Background
//   line 8: bg line 1
//   line 9: bg line 2
//   line 10: # Chapter 2
//   line 11: c2 line
//
// We construct it inline (rather than computing) so the offsets in
// assertions are easy to read against the source text.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURE = [
    "# Chapter 1",       // 0
    "",                  // 1
    "intro line A",      // 2
    "## Body",           // 3
    "body line 1",       // 4
    "body line 2",       // 5
    "### Background",    // 6
    "bg line 1",         // 7
    "bg line 2",         // 8
    "# Chapter 2",       // 9
    "c2 line",           // 10
].join("\n");

// Headings as MetadataCache would expose them (0-based line indices).
const FIXTURE_HEADINGS: HeadingNode[] = [
    { level: 1, heading: "Chapter 1", line: 0 },
    { level: 2, heading: "Body", line: 3 },
    { level: 3, heading: "Background", line: 6 },
    { level: 1, heading: "Chapter 2", line: 9 },
];

function fixtureContext() {
    const original = FIXTURE;
    const lineStarts = buildLineStarts(original);
    const totalLines = lineStarts.length - 1;
    return { original, lineStarts, totalLines };
}

function makeEntry(headingPath: string[], where: AnchorWhere, replace: string): AnchorEntry {
    return { kind: "anchor", headingPath, where, replace, force: false };
}

// Apply a resolved (from, to, replace) to the original. This is what the
// tool would do at write time.
function applySpan(
    original: string,
    span: { from: number; to: number; replace: string },
): string {
    return original.substring(0, span.from) + span.replace + original.substring(span.to);
}

// ─────────────────────────────────────────────────────────────────────────────
// buildLineStarts / sectionLinesToOffsets
// ─────────────────────────────────────────────────────────────────────────────

describe("buildLineStarts", () => {
    it("indexes every line plus a sentinel at EOF", () => {
        const t = "ab\ncd\nef";
        const ls = buildLineStarts(t);
        // line 1 starts at 0 ("a"), line 2 at 3 ("c"), line 3 at 6 ("e")
        // sentinel at text.length
        expect(ls).toEqual([0, 3, 6, 8]);
    });

    it("places a sentinel even when text ends with a newline", () => {
        const t = "ab\n";
        const ls = buildLineStarts(t);
        expect(ls).toEqual([0, 3, 3]);
    });

    it("handles the empty string", () => {
        const ls = buildLineStarts("");
        expect(ls).toEqual([0, 0]);
    });
});

describe("sectionLinesToOffsets", () => {
    it("converts a multi-line section to half-open byte offsets", () => {
        const t = "AAA\nBBB\nCCC\nDDD";
        const ls = buildLineStarts(t);
        // Section spanning lines 2..3 (1-based inclusive of last content line,
        // i.e. endLine=3 means "next heading is at 1-based line 4 / 0-based 3"):
        // start_line=2, end_line=3 → from=lineStarts[1]=4, to=lineStarts[3]=12
        const r = sectionLinesToOffsets(ls, 2, 3);
        expect(r.from).toBe(4);
        expect(r.to).toBe(12);
        expect(t.substring(r.from, r.to)).toBe("BBB\nCCC\n");
    });

    it("captures everything to EOF when endLine equals totalLines", () => {
        const t = "AAA\nBBB"; // 2 lines, no trailing newline
        const ls = buildLineStarts(t);
        // lineStarts = [0, 4, 7]; totalLines = 2
        const r = sectionLinesToOffsets(ls, 2, 2);
        expect(r.from).toBe(4);
        expect(r.to).toBe(7);
        expect(t.substring(r.from, r.to)).toBe("BBB");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAnchorEntry — one test per `where` mode, plus error paths.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAnchorEntry: replace_section", () => {
    it("replaces the entire section including its heading line", () => {
        const ctx = fixtureContext();
        const entry = makeEntry(["Chapter 1", "Body", "Background"], "replace_section", "REPLACED");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        if (typeof r === "string") throw new Error(r);

        const out = applySpan(ctx.original, r);
        expect(out).toContain("REPLACED");
        // Heading line is gone:
        expect(out).not.toContain("### Background");
        // Section body is gone:
        expect(out).not.toContain("bg line 1");
        // Surrounding sections are intact:
        expect(out).toContain("body line 2");
        expect(out).toContain("# Chapter 2");
    });

    it("preserves the trailing structure (next heading is not glued)", () => {
        const ctx = fixtureContext();
        // Replace the whole 'Body' subsection (which includes Background).
        const entry = makeEntry(["Chapter 1", "Body"], "replace_section", "PASTED");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        if (typeof r === "string") throw new Error(r);
        const out = applySpan(ctx.original, r);
        // The next heading must still start on its own line.
        expect(out).toMatch(/PASTED\n# Chapter 2/);
    });
});

describe("resolveAnchorEntry: replace_body", () => {
    it("keeps the heading line; replaces only the body", () => {
        const ctx = fixtureContext();
        const entry = makeEntry(["Chapter 1", "Body", "Background"], "replace_body", "NEW BODY");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        if (typeof r === "string") throw new Error(r);
        const out = applySpan(ctx.original, r);
        expect(out).toContain("### Background");
        expect(out).toContain("NEW BODY");
        expect(out).not.toContain("bg line 1");
        // Heading must remain on its own line followed by the new body.
        expect(out).toMatch(/### Background\nNEW BODY/);
    });
});

describe("resolveAnchorEntry: append_to_section", () => {
    it("appends content at the section's end with newline padding", () => {
        const ctx = fixtureContext();
        const entry = makeEntry(["Chapter 1", "Body", "Background"], "append_to_section", "APPENDED");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        if (typeof r === "string") throw new Error(r);
        const out = applySpan(ctx.original, r);
        // Existing body content is preserved
        expect(out).toContain("bg line 2");
        // New text appears after it but before Chapter 2
        const bgIdx = out.indexOf("bg line 2");
        const apIdx = out.indexOf("APPENDED");
        const c2Idx = out.indexOf("# Chapter 2");
        expect(apIdx).toBeGreaterThan(bgIdx);
        expect(c2Idx).toBeGreaterThan(apIdx);
        // No glued-to-next-heading bug
        expect(out).toMatch(/APPENDED\n# Chapter 2/);
    });

    it("includes nested subsections — appends AFTER the deepest descendant", () => {
        // Append to Body should land AFTER Background (its child), not
        // between Body's prose and Background.
        const ctx = fixtureContext();
        const entry = makeEntry(["Chapter 1", "Body"], "append_to_section", "AFTER ALL CHILDREN");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        if (typeof r === "string") throw new Error(r);
        const out = applySpan(ctx.original, r);
        const bgIdx = out.indexOf("bg line 2");
        const apIdx = out.indexOf("AFTER ALL CHILDREN");
        const c2Idx = out.indexOf("# Chapter 2");
        expect(apIdx).toBeGreaterThan(bgIdx);
        expect(c2Idx).toBeGreaterThan(apIdx);
    });
});

describe("resolveAnchorEntry: prepend_to_body", () => {
    it("inserts immediately after the heading line, before existing body", () => {
        const ctx = fixtureContext();
        const entry = makeEntry(["Chapter 1", "Body"], "prepend_to_body", "PREPENDED");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        if (typeof r === "string") throw new Error(r);
        const out = applySpan(ctx.original, r);
        const headIdx = out.indexOf("## Body");
        const prepIdx = out.indexOf("PREPENDED");
        const bodyIdx = out.indexOf("body line 1");
        expect(prepIdx).toBeGreaterThan(headIdx);
        expect(bodyIdx).toBeGreaterThan(prepIdx);
        // Heading still on its own line; prepended text follows
        expect(out).toMatch(/## Body\nPREPENDED/);
    });
});

describe("resolveAnchorEntry: insert_before_section", () => {
    it("inserts content immediately before the heading line", () => {
        const ctx = fixtureContext();
        const entry = makeEntry(["Chapter 1", "Body"], "insert_before_section", "BEFORE BODY");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        if (typeof r === "string") throw new Error(r);
        const out = applySpan(ctx.original, r);
        const introIdx = out.indexOf("intro line A");
        const insIdx = out.indexOf("BEFORE BODY");
        const headIdx = out.indexOf("## Body");
        expect(insIdx).toBeGreaterThan(introIdx);
        expect(headIdx).toBeGreaterThan(insIdx);
        // Heading must remain heading-shaped (own line) after insertion.
        expect(out).toMatch(/BEFORE BODY\n## Body/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAnchorEntry — error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAnchorEntry error paths", () => {
    it("returns a not_found message when the heading path is bogus", () => {
        const ctx = fixtureContext();
        const entry = makeEntry(["Nope"], "replace_section", "X");
        const r = resolveAnchorEntry(entry, ctx.original, FIXTURE_HEADINGS, ctx.lineStarts, ctx.totalLines);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("not found");
    });

    it("returns an ambiguous message when two headings share the chain", () => {
        const dupes: HeadingNode[] = [
            { level: 1, heading: "X", line: 0 },
            { level: 1, heading: "X", line: 5 },
        ];
        const text = ["# X", "p1", "p2", "p3", "p4", "# X", "p5"].join("\n");
        const ls = buildLineStarts(text);
        const total = ls.length - 1;
        const entry = makeEntry(["X"], "replace_section", "Y");
        const r = resolveAnchorEntry(entry, text, dupes, ls, total);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("ambiguous");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// padForGap / padForInsertion — the edge cases that decide whether
// markdown structure survives a write.
// ─────────────────────────────────────────────────────────────────────────────

describe("padForGap", () => {
    it("does not pad when both sides are already newlines", () => {
        const host = "AAA\n\nBBB";
        // gap between the two newlines (positions 4..4 — pure insertion at 4)
        const r = padForGap(host, 4, 4, "X");
        expect(r).toBe("X");
    });

    it("adds a leading newline when the preceding char is non-newline", () => {
        const host = "AAA";
        const r = padForGap(host, 3, 3, "X");
        expect(r).toBe("\nX");
    });

    it("adds a trailing newline when the following char is non-newline", () => {
        const host = "AAA";
        const r = padForGap(host, 0, 0, "X");
        expect(r).toBe("X\n");
    });

    it("pads both sides for an in-line insertion", () => {
        const host = "AAA";
        const r = padForGap(host, 1, 1, "X");
        expect(r).toBe("\nX\n");
    });

    it("does not double-pad when the text already starts/ends with newlines", () => {
        const host = "AAA";
        const r = padForGap(host, 1, 1, "\nX\n");
        expect(r).toBe("\nX\n");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildSpanExcerpts — the pair of before/after excerpts that the
// `vault_editor` sub-agent will feed to `result.sample_diff` without
// paraphrasing. These tests pin the geometry (context window, hard cap,
// truncation flag) against the plan's stated limits.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildSpanExcerpts", () => {
    it("centres the span on EXCERPT_CONTEXT_CHARS of pre/post context", () => {
        // Build a host large enough that the span isn't near either end.
        const prefix = "p".repeat(100);
        const needle = "SPAN";
        const suffix = "s".repeat(100);
        const original = prefix + needle + suffix;

        const from = prefix.length;
        const to = from + needle.length;
        // Pretend the rewrite replaced SPAN with GONE at the same offset
        // (length changed from 4 → 4, so newFrom/newTo match).
        const modified = prefix + "GONE" + suffix;

        const r = buildSpanExcerpts(original, modified, from, to, from, to);

        // Before excerpt: context_chars of p + needle + context_chars of s
        expect(r.before).toBe(
            "p".repeat(EXCERPT_CONTEXT_CHARS) + needle + "s".repeat(EXCERPT_CONTEXT_CHARS),
        );
        // After excerpt: same layout with the replacement
        expect(r.after).toBe(
            "p".repeat(EXCERPT_CONTEXT_CHARS) + "GONE" + "s".repeat(EXCERPT_CONTEXT_CHARS),
        );
        expect(r.truncated).toBe(false);
    });

    it("clips to the hard cap and flags truncation when the span itself is large", () => {
        // Huge span — emulates anchor-mode `replace_section` on a big section.
        const huge = "x".repeat(500);
        const original = `PREFIX ${huge} SUFFIX`;
        const from = "PREFIX ".length;
        const to = from + huge.length;

        const modified = "PREFIX REPLACED SUFFIX";
        const newFrom = "PREFIX ".length;
        const newTo = newFrom + "REPLACED".length;

        const r = buildSpanExcerpts(original, modified, from, to, newFrom, newTo);
        expect(r.before.length).toBe(EXCERPT_HARD_CAP);
        // After excerpt is still short (REPLACED is tiny), so it's NOT
        // truncated on its own — but `truncated` is true because the
        // before side hit the cap.
        expect(r.after.length).toBeLessThanOrEqual(EXCERPT_HARD_CAP);
        expect(r.truncated).toBe(true);
    });

    it("does not exceed buffer bounds when the span sits at the very start or end", () => {
        // span at offset 0
        const original = "HEAD" + "a".repeat(100);
        const modified = "TAIL" + "a".repeat(100);
        const r = buildSpanExcerpts(original, modified, 0, 4, 0, 4);
        // Should include the span + EXCERPT_CONTEXT_CHARS of post-context
        // but no pre-context (nothing before offset 0).
        expect(r.before.startsWith("HEAD")).toBe(true);
        expect(r.after.startsWith("TAIL")).toBe(true);
        expect(r.truncated).toBe(false);
    });
});
