import { describe, it, expect } from "vitest";
import { normalizeMarkdownForObsidian } from "../src/utils/markdown-sanitizer";

// ─────────────────────────────────────────────────────────────────────────────
// normalizeMarkdownForObsidian — table blank-line normalization
//
// Obsidian's Markdown renderer may fail to recognize a table if it is not
// separated from adjacent content by blank lines.  This function ensures
// every structurally valid table block (header + separator [+ data rows])
// has at least one blank line before and after it (existing blanks are
// preserved, only missing separators are added).
//
// Blank lines at BOF/EOF are never added — the table itself anchors the edge.
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeMarkdownForObsidian", () => {
    const norm = (s: string) => normalizeMarkdownForObsidian(s);

    // ── Table without blank lines around it ─────────────────────────────

    it("inserts blank line before a table that follows text directly", () => {
        const input = "Some text\n| Col A | Col B |\n| --- | --- |\n| data | here |";
        const result = norm(input);
        expect(result).toBe(
            "Some text\n\n| Col A | Col B |\n| --- | --- |\n| data | here |",
        );
    });

    it("inserts blank line after a table that is followed by text directly", () => {
        const input = "| Col A | Col B |\n| --- | --- |\n| data | here |\nMore text";
        const result = norm(input);
        expect(result).toBe(
            "| Col A | Col B |\n| --- | --- |\n| data | here |\n\nMore text",
        );
    });

    it("inserts blank lines on both sides when table has no blank lines", () => {
        const input =
            "Before\n| Col A | Col B |\n| --- | --- |\n| data | here |\nAfter";
        const result = norm(input);
        expect(result).toBe(
            "Before\n\n| Col A | Col B |\n| --- | --- |\n| data | here |\n\nAfter",
        );
    });

    // ── Table already has correct blank lines ───────────────────────────

    it("leaves a correctly spaced table unchanged", () => {
        const input =
            "Before\n\n| Col A | Col B |\n| --- | --- |\n| data | here |\n\nAfter";
        const result = norm(input);
        expect(result).toBe(input);
    });

    it("preserves multiple blank lines before a table", () => {
        const input =
            "Before\n\n\n\n| Col A | Col B |\n| --- | --- |\n| data | here |";
        const result = norm(input);
        expect(result).toBe(
            "Before\n\n\n\n| Col A | Col B |\n| --- | --- |\n| data | here |",
        );
    });

    it("preserves multiple blank lines after a table", () => {
        const input =
            "| Col A | Col B |\n| --- | --- |\n| data | here |\n\n\n\nAfter";
        const result = norm(input);
        expect(result).toBe(
            "| Col A | Col B |\n| --- | --- |\n| data | here |\n\n\n\nAfter",
        );
    });

    // ── Table at document boundaries ────────────────────────────────────

    it("does NOT insert a blank line before a table at the very beginning", () => {
        const input = "| Col A | Col B |\n| --- | --- |\n| data | here |";
        const result = norm(input);
        expect(result).toBe(input);
    });

    it("does NOT insert a blank line after a table at the very end", () => {
        const input =
            "Before\n\n| Col A | Col B |\n| --- | --- |\n| data | here |";
        const result = norm(input);
        expect(result).toBe(input);
    });

    // ── Table inside a fenced code block ────────────────────────────────

    it("does NOT add blank lines around a table inside a fenced code block", () => {
        const input =
            "Text\n\n```\n| Col A | Col B |\n| --- | --- |\n| data | here |\n```\n\nMore";
        const result = norm(input);
        expect(result).toBe(input);
    });

    it("does NOT add blank lines around a table inside a tilde fenced code block", () => {
        const input =
            "Text\n\n~~~\n| Col A | Col B |\n| --- | --- |\n| data | here |\n~~~\n\nMore";
        const result = norm(input);
        expect(result).toBe(input);
    });

    it("handles a table-like pattern after a code block (not inside)", () => {
        // Table appears after a closed code block — should be normalized.
        const input =
            "```\ncode content\n```\n| Col A | Col B |\n| --- | --- |\n| data | here |";
        const result = norm(input);
        expect(result).toBe(
            "```\ncode content\n```\n\n| Col A | Col B |\n| --- | --- |\n| data | here |",
        );
    });

    // ── Multiple consecutive tables ─────────────────────────────────────

    it("inserts blank line between two adjacent tables", () => {
        const input =
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n| X | Y |\n| --- | --- |\n| 3 | 4 |";
        const result = norm(input);
        expect(result).toBe(
            "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| X | Y |\n| --- | --- |\n| 3 | 4 |",
        );
    });

    it("handles two tables with surrounding text", () => {
        const input =
            "Top\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| X | Y |\n| --- | --- |\n| 3 | 4 |\nBottom";
        const result = norm(input);
        expect(result).toBe(
            "Top\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| X | Y |\n| --- | --- |\n| 3 | 4 |\n\nBottom",
        );
    });

    // ── Single-column tables ────────────────────────────────────────────

    it("handles a single-column table", () => {
        const input = "Text\n| Value |\n| --- |\n| 42 |\nMore";
        const result = norm(input);
        expect(result).toBe(
            "Text\n\n| Value |\n| --- |\n| 42 |\n\nMore",
        );
    });

    // ── Separator with alignment colons ─────────────────────────────────

    it("recognizes tables with alignment separators", () => {
        const input =
            "Text\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\nMore";
        const result = norm(input);
        expect(result).toBe(
            "Text\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n\nMore",
        );
    });

    // ── Table with complex cell content ─────────────────────────────────

    it("handles tables with inline code in cells", () => {
        const input =
            "Text\n| Command | Desc |\n| --- | --- |\n| `ls` | List |\n| `cd` | Change |\nMore";
        const result = norm(input);
        expect(result).toBe(
            "Text\n\n| Command | Desc |\n| --- | --- |\n| `ls` | List |\n| `cd` | Change |\n\nMore",
        );
    });

    it("handles tables with bold/italic in cells", () => {
        const input =
            "Text\n| Style | Example |\n| --- | --- |\n| **bold** | *italic* |\nMore";
        const result = norm(input);
        expect(result).toBe(
            "Text\n\n| Style | Example |\n| --- | --- |\n| **bold** | *italic* |\n\nMore",
        );
    });

    it("handles tables with links in cells", () => {
        const input =
            "Text\n| Site | URL |\n| --- | --- |\n| [Google](https://google.com) | Search |\nMore";
        const result = norm(input);
        expect(result).toBe(
            "Text\n\n| Site | URL |\n| --- | --- |\n| [Google](https://google.com) | Search |\n\nMore",
        );
    });

    // ── Non-table: single pipe line without separator ───────────────────

    it("does NOT treat a lone pipe-starting line as a table (no separator)", () => {
        const input = "| Just a thought\n\nMore text";
        const result = norm(input);
        expect(result).toBe(input);
    });

    // ── Table header without closing pipe ───────────────────────────────
    // (Some markdown flavors allow `| Col` without trailing `|`)

    it("does NOT treat a header without closing | as a table row", () => {
        // `isTableRow` requires both leading and trailing `|`.
        const input = "Text\n| Col A | Col B\n| --- | --- |\n| data | here |";
        // First "table" line lacks closing | — not recognized as a table row,
        // so the block is not treated as a table.
        const result = norm(input);
        expect(result).toBe(input);
    });

    // ── Empty / whitespace-only input ───────────────────────────────────

    it("returns empty string unchanged", () => {
        expect(norm("")).toBe("");
    });

    it("returns whitespace-only unchanged", () => {
        const input = "   \n  \n ";
        expect(norm(input)).toBe(input);
    });

    // ── No table present ────────────────────────────────────────────────

    it("returns plain text without tables unchanged", () => {
        const input = "Just some\n\nparagraphs\n\nand **markdown** formatting.";
        expect(norm(input)).toBe(input);
    });

    it("returns heading + paragraph unchanged", () => {
        const input = "## Heading\n\nSome text here.\n\nMore text.";
        expect(norm(input)).toBe(input);
    });

    // ── Table with empty cells ──────────────────────────────────────────

    it("handles tables with empty cells", () => {
        const input =
            "Text\n| A | B | C |\n| --- | --- | --- |\n| 1 |   | 3 |\n|   | 2 |   |\nMore";
        const result = norm(input);
        expect(result).toBe(
            "Text\n\n| A | B | C |\n| --- | --- | --- |\n| 1 |   | 3 |\n|   | 2 |   |\n\nMore",
        );
    });

    // ── Indented table lines ────────────────────────────────────────────

    it("handles indented table rows (preserves indentation)", () => {
        const input =
            "Text\n  | Col A | Col B |\n  | --- | --- |\n  | data | here |\nMore";
        const result = norm(input);
        expect(result).toBe(
            "Text\n\n  | Col A | Col B |\n  | --- | --- |\n  | data | here |\n\nMore",
        );
    });
});
