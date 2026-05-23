import { describe, it, expect } from "vitest";
import {
    findHeadingByPath,
    formatFindSectionError,
    normalizeHeadingPathArg,
    resolveHeadingPathToRange,
    type HeadingNode,
} from "../src/services/tools/obsidian/heading-section";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — build a heading list mimicking what
// `app.metadataCache.getFileCache(file).headings` would look like.
//
// Each entry: [level, heading, 0-based line]. We keep the test fixture
// inline so the structure is obvious at the call site.
// ─────────────────────────────────────────────────────────────────────────────

function h(level: number, heading: string, line: number): HeadingNode {
    return { level, heading, line };
}

// File shape used by most tests:
//
//   line 0  # Chapter 1                     (level 1)
//   line 5  ## Intro                         (level 2)
//   line 10 ## Body                          (level 2)
//   line 15 ### Background                   (level 3)
//   line 25 ### Methods                      (level 3)
//   line 35 # Chapter 2                      (level 1)
//   line 40 ## Background                    (level 2)  ← duplicate name, different chain
//
// totalLines = 50
const SAMPLE_HEADINGS: HeadingNode[] = [
    h(1, "Chapter 1", 0),
    h(2, "Intro", 5),
    h(2, "Body", 10),
    h(3, "Background", 15),
    h(3, "Methods", 25),
    h(1, "Chapter 2", 35),
    h(2, "Background", 40),
];
const SAMPLE_TOTAL = 50;

// ─────────────────────────────────────────────────────────────────────────────
// findHeadingByPath
// ─────────────────────────────────────────────────────────────────────────────

describe("findHeadingByPath", () => {
    it("returns empty_path on empty input", () => {
        const r = findHeadingByPath(SAMPLE_HEADINGS, []);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.kind).toBe("empty_path");
    });

    it("returns no_headings on empty heading list", () => {
        const r = findHeadingByPath([], ["X"]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.kind).toBe("no_headings");
    });

    it("matches a top-level heading by single-element path", () => {
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["Chapter 1"]);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.index).toBe(0);
            expect(r.ancestorsAtMatch).toEqual([]);
        }
    });

    it("matches a nested heading by full ancestor chain", () => {
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["Chapter 1", "Body", "Background"]);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.index).toBe(3); // line 15
            expect(r.ancestorsAtMatch).toEqual(["Chapter 1", "Body"]);
        }
    });

    it("disambiguates same heading text under different ancestor chains", () => {
        // "Background" appears twice — once under Chapter 1 > Body, once under Chapter 2.
        // Ancestor chain MUST be specified to pick one.
        const a = findHeadingByPath(SAMPLE_HEADINGS, ["Chapter 1", "Body", "Background"]);
        const b = findHeadingByPath(SAMPLE_HEADINGS, ["Chapter 2", "Background"]);
        expect(a.ok && b.ok).toBe(true);
        if (a.ok && b.ok) {
            expect(a.index).toBe(3);
            expect(b.index).toBe(6);
        }
    });

    it("reports ambiguous when two headings share the EXACT same ancestor chain", () => {
        const dupes: HeadingNode[] = [
            h(1, "Chapter 1", 0),
            h(2, "Notes", 5),
            h(2, "Notes", 20), // same chain ['Chapter 1', 'Notes']
        ];
        const r = findHeadingByPath(dupes, ["Chapter 1", "Notes"]);
        expect(r.ok).toBe(false);
        if (!r.ok && r.error.kind === "ambiguous") {
            expect(r.error.matches).toHaveLength(2);
            expect(r.error.matches.map((m) => m.line)).toEqual([6, 21]); // 1-based
        } else {
            throw new Error("expected ambiguous error");
        }
    });

    it("reports not_found with available chains for diagnostics", () => {
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["No Such Heading"]);
        expect(r.ok).toBe(false);
        if (!r.ok && r.error.kind === "not_found") {
            expect(r.error.available.length).toBeGreaterThan(0);
            expect(r.error.available).toContain("Chapter 1");
            expect(r.error.available).toContain("Chapter 1 > Body > Background");
        } else {
            throw new Error("expected not_found error");
        }
    });

    it("matching is case-sensitive (no silent widening)", () => {
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["chapter 1"]); // lowercase
        expect(r.ok).toBe(false);
    });

    it("trims whitespace around heading titles in the path argument", () => {
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["  Chapter 1  ", " Body ", " Background "]);
        expect(r.ok).toBe(true);
    });

    it("rejects a partial chain that skips an intermediate ancestor", () => {
        // ["Chapter 1", "Background"] would skip "Body" — must NOT match.
        // Tail-subsequence semantics still forbid mid-chain skips: the wanted
        // path must equal a CONTIGUOUS suffix of the actual chain.
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["Chapter 1", "Background"]);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.kind).toBe("not_found");
    });

    it("matches a unique tail of the ancestor chain (single leaf title)", () => {
        // 'Methods' appears only once, under Chapter 1 > Body. Submitting just
        // ["Methods"] should resolve to that heading, with the FULL ancestor
        // chain echoed back to the caller via `ancestorsAtMatch`.
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["Methods"]);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.index).toBe(4); // line 25
            expect(r.ancestorsAtMatch).toEqual(["Chapter 1", "Body"]);
        }
    });

    it("matches a unique multi-level tail of the ancestor chain", () => {
        // ["Body", "Background"] is the tail of ["Chapter 1", "Body", "Background"].
        // 'Body' only ever appears inside Chapter 1, so the tail is unique.
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["Body", "Background"]);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.index).toBe(3); // line 15
            expect(r.ancestorsAtMatch).toEqual(["Chapter 1", "Body"]);
        }
    });

    it("reports ambiguous when a short tail matches multiple branches", () => {
        // 'Background' appears as a tail in BOTH "Chapter 1 > Body > Background"
        // and "Chapter 2 > Background". The lone leaf must NOT auto-pick.
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["Background"]);
        expect(r.ok).toBe(false);
        if (!r.ok && r.error.kind === "ambiguous") {
            expect(r.error.matches).toHaveLength(2);
            expect(r.error.matches.map((m) => m.line).sort((x, y) => x - y)).toEqual([16, 41]);
        } else {
            throw new Error("expected ambiguous error");
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveHeadingPathToRange
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveHeadingPathToRange", () => {
    it("returns 1-based inclusive range for a leaf section (no subsections)", () => {
        // Background is a level-3 leaf at line 15..24 (next sibling Methods at line 25).
        // 1-based inclusive: start=16, end=25 (the line BEFORE Methods, i.e. 25).
        // The function returns end_line = next_heading.line (0-based) = 25, which
        // is one past the actual last content line. We treat this as "exclusive
        // bound, expressed numerically equal to the next heading's 1-based start
        // minus 1 — confirm via slicing semantics in the integration test."
        const r = resolveHeadingPathToRange(
            SAMPLE_HEADINGS,
            ["Chapter 1", "Body", "Background"],
            SAMPLE_TOTAL,
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.section.start_line).toBe(16);
            expect(r.section.end_line).toBe(25);
            expect(r.section.level).toBe(3);
            expect(r.section.heading).toBe("Background");
        }
    });

    it("includes subsections by default (level 2 section spans children)", () => {
        // Body is at line 10..34 (next level-1 'Chapter 2' at line 35).
        // include_subsections=true → end is at the next heading of equal-or-shallower level.
        const r = resolveHeadingPathToRange(
            SAMPLE_HEADINGS,
            ["Chapter 1", "Body"],
            SAMPLE_TOTAL,
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.section.start_line).toBe(11);
            expect(r.section.end_line).toBe(35);
        }
    });

    it("excludes subsections when include_subsections=false", () => {
        // Body excluding subsections → ends at the very next heading of ANY level
        // (Background at line 15) → end_line = 15 (exclusive).
        const r = resolveHeadingPathToRange(
            SAMPLE_HEADINGS,
            ["Chapter 1", "Body"],
            SAMPLE_TOTAL,
            false,
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.section.start_line).toBe(11);
            expect(r.section.end_line).toBe(15);
        }
    });

    it("extends to total_lines for the last section in the file", () => {
        // 'Chapter 2 > Background' is the last heading; section runs to EOF.
        const r = resolveHeadingPathToRange(
            SAMPLE_HEADINGS,
            ["Chapter 2", "Background"],
            SAMPLE_TOTAL,
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.section.start_line).toBe(41);
            expect(r.section.end_line).toBe(SAMPLE_TOTAL);
        }
    });

    it("returns the heading line itself when the section is empty (heading immediately followed by next heading)", () => {
        const tight: HeadingNode[] = [
            h(2, "A", 5),
            h(2, "B", 6), // immediately after A
        ];
        const r = resolveHeadingPathToRange(tight, ["A"], 10);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.section.start_line).toBe(6);
            expect(r.section.end_line).toBe(6); // clamped to start_line
        }
    });

    it("propagates not_found errors", () => {
        const r = resolveHeadingPathToRange(SAMPLE_HEADINGS, ["Nope"], SAMPLE_TOTAL);
        expect(r.ok).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatFindSectionError — the user-facing message wording matters
// because the LLM uses it to refine the next call.
// ─────────────────────────────────────────────────────────────────────────────

describe("formatFindSectionError", () => {
    it("renders not_found with sample available chains", () => {
        const r = findHeadingByPath(SAMPLE_HEADINGS, ["Bogus"]);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            const msg = formatFindSectionError(r.error, ["Bogus"]);
            expect(msg).toContain("not found");
            expect(msg).toContain("Available ancestor chains");
            expect(msg).toContain("Chapter 1");
        }
    });

    it("renders ambiguous with line numbers and ancestor chains", () => {
        const dupes: HeadingNode[] = [
            h(1, "Chapter 1", 0),
            h(2, "Notes", 5),
            h(2, "Notes", 20),
        ];
        const r = findHeadingByPath(dupes, ["Chapter 1", "Notes"]);
        if (r.ok) throw new Error("expected error");
        const msg = formatFindSectionError(r.error, ["Chapter 1", "Notes"]);
        expect(msg).toContain("ambiguous");
        expect(msg).toContain("line 6");
        expect(msg).toContain("line 21");
        expect(msg).toContain("Prepend more ancestors");
    });

    it("renders empty_path", () => {
        const msg = formatFindSectionError({ kind: "empty_path" }, []);
        expect(msg).toContain("must contain at least one element");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeHeadingPathArg — tool-call argument normalization
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeHeadingPathArg", () => {
    it("accepts canonical heading_path", () => {
        const r = normalizeHeadingPathArg(
            { heading_path: ["Chapter 2", "Background"] },
            { required: true },
        );
        expect(r).toEqual({ ok: true, value: ["Chapter 2", "Background"] });
    });

    it("accepts heading alias", () => {
        const r = normalizeHeadingPathArg(
            { heading: ["三、化解矛盾的 5 个实用技巧"] },
            { required: true },
        );
        expect(r).toEqual({ ok: true, value: ["三、化解矛盾的 5 个实用技巧"] });
    });

    it("prefers heading_path over heading alias", () => {
        const r = normalizeHeadingPathArg(
            { heading_path: ["A"], heading: ["B"] },
            { required: true },
        );
        expect(r).toEqual({ ok: true, value: ["A"] });
    });

    it("coerces a single string to one-element array", () => {
        const r = normalizeHeadingPathArg(
            { heading: "Background" },
            { required: true },
        );
        expect(r).toEqual({ ok: true, value: ["Background"] });
    });

    it("returns null when optional and absent", () => {
        const r = normalizeHeadingPathArg({}, { required: false });
        expect(r).toEqual({ ok: true, value: null });
    });

    it("rejects legacy section with migration hint", () => {
        const r = normalizeHeadingPathArg({ section: "Background" }, { required: false });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.message).toContain("section");
            expect(r.message).toContain("heading_path");
        }
    });

    it("errors on empty heading alias with hint", () => {
        const r = normalizeHeadingPathArg({ heading: [] }, { required: true });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.message).toContain("heading_path");
            expect(r.message).toContain("Use parameter name");
        }
    });
});
