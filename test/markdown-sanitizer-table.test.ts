import { describe, it, expect } from "vitest";
import { sanitizeStreamingMarkdown } from "../src/utils/markdown-sanitizer";

// ─────────────────────────────────────────────────────────────────────────────
// Table deferral tests for sanitizeStreamingMarkdown
//
// The deferTrailingTable logic ensures streaming table content is not
// incrementally rendered, which would cause column-width recalculations
// and layout jumps.  A table that is still receiving rows (trailing at
// the end of content) is deferred entirely until it is followed by
// non-table content or the stream ends.
// ─────────────────────────────────────────────────────────────────────────────

describe("deferTrailingTable (via sanitizeStreamingMarkdown)", () => {
    // ── Helper ────────────────────────────────────────────────────────────
    const sanitize = (s: string) => sanitizeStreamingMarkdown(s);

    // ── Table header only (no separator) ──────────────────────────────────

    it("defers a table with only a header row (no separator)", () => {
        const input = "Some text\n\n| Name | Age |\n";
        const result = sanitize(input);
        expect(result).not.toContain("| Name");
        expect(result).toContain("Some text");
    });

    // ── Table header + incomplete separator ───────────────────────────────

    it("defers a table whose second line looks like a row, not a separator", () => {
        const input = "Text\n\n| Col A | Col B |\n| 1 | 2 |\n";
        const result = sanitize(input);
        expect(result).not.toContain("| Col A");
    });

    // ── Table header + separator (trailing) ───────────────────────────────

    it("defers a table with header + separator when it is the last block", () => {
        const input = "Intro\n\n| Key | Value |\n| --- | --- |\n";
        const result = sanitize(input);
        expect(result).not.toContain("| Key");
        expect(result).not.toContain("| ---");
        expect(result).toContain("Intro");
    });

    // ── Table header + separator (followed by non-table text) ─────────────

    it("renders a complete table when followed by non-table content", () => {
        const input =
            "Before\n\n| Key | Value |\n| --- | --- |\n| a   | b     |\n\nAfter";
        const result = sanitize(input);
        expect(result).toContain("| Key");
        expect(result).toContain("| ---");
        expect(result).toContain("| a");
        expect(result).toContain("After");
    });

    // ── Table header + separator + data rows (trailing) ───────────────────

    it("defers a trailing table with header + separator + data rows", () => {
        const input =
            "Lead\n\n| Name | Score |\n| --- | --- |\n| Alice | 95 |\n| Bob | 87 |\n";
        const result = sanitize(input);
        expect(result).not.toContain("| Name");
        expect(result).not.toContain("Alice");
        expect(result).toContain("Lead");
    });

    // ── Table trailing vs followed ── boundary test ───────────────────────

    it("renders a table when the line after it is non-table (not blank)", () => {
        const input =
            "Start\n\n| X | Y |\n| - | - |\n| 1 | 2 |\n\nNext paragraph.";
        const result = sanitize(input);
        expect(result).toContain("| X");
        expect(result).toContain("| 1");
        expect(result).toContain("Next paragraph.");
    });

    // ── Incomplete data row (streaming middle of a cell) ──────────────────

    it("defers a table with an incomplete trailing row", () => {
        const input = "Text\n\n| A | B |\n| --- | --- |\n| da";
        const result = sanitize(input);
        expect(result).not.toContain("| A | B |");
        expect(result).not.toContain("| ---");
        expect(result).toContain("Text");
    });

    // ── Table inside a fenced code block ──────────────────────────────────

    it("does NOT defer a table inside a fenced code block", () => {
        const input =
            "```\n| Name | Value |\n| ---- | ----- |\n| x    | 1     |\n```";
        const result = sanitize(input);
        expect(result).toContain("| Name");
    });

    it("does NOT defer an incomplete table row inside a fenced code block", () => {
        const input = "```\n| Only header\n```";
        const result = sanitize(input);
        expect(result).toContain("| Only header");
    });

    // ── Complex cell content ──────────────────────────────────────────────

    it("handles inline code inside table cells", () => {
        const input =
            "P\n\n| Command | Description |\n| --- | --- |\n| `ls` | List files |\n| `cd` | Change dir |\n\nDone";
        const result = sanitize(input);
        expect(result).toContain("`ls`");
        expect(result).toContain("List files");
        expect(result).toContain("Done");
    });

    it("handles bold / italic inside table cells", () => {
        const input =
            "Top\n\n| Style | Example |\n| --- | --- |\n| **bold** | *italic* |\n| ***both*** | ~~strike~~ |\n\nBottom";
        const result = sanitize(input);
        expect(result).toContain("**bold**");
        expect(result).toContain("*italic*");
        expect(result).toContain("Bottom");
    });

    it("handles links inside table cells", () => {
        const input =
            "H\n\n| Site | URL |\n| --- | --- |\n| [Google](https://google.com) | [Bing](https://bing.com) |\n\nF";
        const result = sanitize(input);
        expect(result).toContain("[Google](https://google.com)");
        expect(result).toContain("[Bing](https://bing.com)");
    });

    it("handles images inside table cells", () => {
        const input =
            "H\n\n| Icon | Name |\n| --- | --- |\n| ![img](icon.png) | App |\n\nTrailing text";
        const result = sanitize(input);
        expect(result).toContain("![img](icon.png)");
    });

    it("handles escaped pipes inside table cells", () => {
        const input =
            "H\n\n| Expr | Meaning |\n| --- | --- |\n| a \\| b | a or b |\n\nE";
        const result = sanitize(input);
        // Escaped pipe preserved verbatim — sanitizer does not unescape
        expect(result).toContain("a \\| b");
    });

    it("handles nested pipe (`|`) characters inside inline code in cells", () => {
        // The `|` inside backticks should NOT be treated as a cell separator
        // The sanitizer preserves content verbatim, including escaped pipes
        const input =
            "Text\n\n| Syntax | Meaning |\n| --- | --- |\n| `a \\|\\| b` | Logical OR |\n\nEnd";
        const result = sanitize(input);
        expect(result).toContain("`a \\|\\| b`");
        expect(result).toContain("Logical OR");
    });

    it("handles HTML-like content inside table cells", () => {
        const input =
            "A\n\n| Tag | Usage |\n| --- | --- |\n| `<br>` | Line break |\n| `<div>` | Container |\n\nB";
        const result = sanitize(input);
        expect(result).toContain("`<br>`");
        expect(result).toContain("`<div>`");
    });

    // ── Single-column tables ──────────────────────────────────────────────

    it("handles a single-column table (header only, trailing)", () => {
        const input = "Pre\n\n| Value |\n";
        const result = sanitize(input);
        expect(result).not.toContain("| Value");
        expect(result).toContain("Pre");
    });

    it("handles a single-column complete table followed by text", () => {
        const input = "Pre\n\n| Value |\n| --- |\n| 42 |\n\nPost";
        const result = sanitize(input);
        expect(result).toContain("| Value");
        expect(result).toContain("| 42");
        expect(result).toContain("Post");
    });

    // ── Empty cells ───────────────────────────────────────────────────────

    it("handles tables with empty cells", () => {
        const input =
            "H\n\n| A | B | C |\n| --- | --- | --- |\n| 1 |   | 3 |\n|   | 2 |   |\n\nE";
        const result = sanitize(input);
        expect(result).toContain("| 1 |   | 3 |");
        expect(result).toContain("|   | 2 |   |");
    });

    // ── Separator with alignment colons ───────────────────────────────────

    it("handles separator rows with alignment syntax (:---, :---:, ---:)", () => {
        const input =
            "H\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n\nE";
        const result = sanitize(input);
        expect(result).toContain("| :--- | :---: | ---: |");
        expect(result).toContain("| a | b | c |");
    });

    // ── Multiple tables ───────────────────────────────────────────────────

    it("handles two complete tables in sequence", () => {
        const input =
            "Top\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n| X | Y |\n| --- | --- |\n| 3 | 4 |\n\nBottom";
        const result = sanitize(input);
        expect(result).toContain("| A | B |");
        expect(result).toContain("| X | Y |");
        expect(result).toContain("Bottom");
    });

    it("defers a second trailing table after a complete first table", () => {
        const input =
            "Top\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nNext\n\n| X | Y |\n| --- | --- |\n";
        const result = sanitize(input);
        // First table (followed by "Next") should be present
        expect(result).toContain("| A | B |");
        // Second table (trailing) should be deferred
        expect(result).not.toContain("| X | Y |");
    });

    // ── Edge: trailing whitespace in cells ────────────────────────────────

    it("tolerates trailing whitespace inside complete table rows", () => {
        const input =
            "H\n\n| A   | B   |   \n| --- | --- |\n| 1   | 2   |   \n\nE";
        const result = sanitize(input);
        expect(result).toContain("| A   | B   |");
    });

    // ── Empty / whitespace-only input ─────────────────────────────────────

    it("returns empty string unchanged", () => {
        expect(sanitize("")).toBe("");
    });

    it("returns whitespace-only text unchanged (no table involved)", () => {
        expect(sanitize("   \n  \n ")).toBe("   \n  \n ");
    });

    // ── Regression: table that is the entire content ──────────────────────

    it("defers a table that is the entire content (no surrounding text)", () => {
        const input = "| X | Y |\n| --- | --- |\n| 1 | 2 |\n";
        const result = sanitize(input);
        expect(result).not.toContain("| X");
        expect(result).not.toContain("| 1");
        expect(result.trim()).toBe("");
    });

    // ── Streaming scenario simulation ─────────────────────────────────────

    it("streaming: defers throughout and renders after non-table text arrives", () => {
        // Step 1: only header
        const s1 = sanitize("Intro\n\n| Name | Score |\n");
        expect(s1).not.toContain("| Name");

        // Step 2: header + separator (still trailing)
        const s2 = sanitize("Intro\n\n| Name | Score |\n| --- | --- |\n");
        expect(s2).not.toContain("| Name");

        // Step 3: header + separator + one data row (trailing)
        const s3 = sanitize(
            "Intro\n\n| Name | Score |\n| --- | --- |\n| Alice | 95 |\n",
        );
        expect(s3).not.toContain("Alice");

        // Step 4: table complete + followed by non-table content
        const s4 = sanitize(
            "Intro\n\n| Name | Score |\n| --- | --- |\n| Alice | 95 |\n| Bob | 87 |\n\nConclusion",
        );
        expect(s4).toContain("| Name | Score |");
        expect(s4).toContain("Alice");
        expect(s4).toContain("Bob");
        expect(s4).toContain("Conclusion");
    });

    it("streaming: incomplete row → complete row → followed", () => {
        // Partial data row (mid-cell)
        const s1 = sanitize("Top\n\n| A | B |\n| --- | --- |\n| da");
        expect(s1).not.toContain("| A | B |"); // deferred by recursion

        // Row completed but still trailing
        const s2 = sanitize(
            "Top\n\n| A | B |\n| --- | --- |\n| data | here |\n",
        );
        expect(s2).not.toContain("data"); // still trailing

        // Followed by text → fully rendered
        const s3 = sanitize(
            "Top\n\n| A | B |\n| --- | --- |\n| data | here |\n\nDone",
        );
        expect(s3).toContain("data");
        expect(s3).toContain("Done");
    });

    // ── Interaction with other sanitizers ─────────────────────────────────

    it("defers a trailing table even when inline code is present elsewhere", () => {
        const input =
            "Use `code` here\n\n| X | Y |\n| --- | --- |\n| a | b |\n";
        const result = sanitize(input);
        expect(result).toContain("`code`");
        expect(result).not.toContain("| X | Y |");
    });

    it("preserves bold/italic in leading text and defers trailing table", () => {
        // closeBoldItalic runs *before* deferTrailingTable in the pipeline.
        // However, closeBoldItalic operates on the last paragraph only
        // (after the last `\n\n`).  The last paragraph here is the table
        // block, so the bold in the first paragraph is not affected.
        // The bold marker in the first paragraph is already correct (it has
        // no closing `**`), and deferTrailingTable defers the trailing table.
        const input =
            "This is **important\n\n| K | V |\n| --- | --- |\n| 1 | 2 |\n";
        const result = sanitize(input);
        // The bold marker is preserved as-is (no auto-closing in a
        // different paragraph)
        expect(result).toContain("**important");
        expect(result).not.toContain("| K | V |");
    });

    // ── Non-table pipe-starting line: not deferred when alone ─────────────

    it("does NOT defer a single pipe-starting line when not a table block", () => {
        // A single line like "| Just a line" that is not part of a multi-row
        // table block.  Since it's the only "table row" and the preceding
        // line is blank but the line after it is text (or nothing), the walk
        // backwards finds it as the only row.  But wait — it *is* at the
        // end of the content, so case 2 would defer it.
        //
        // This is actually the correct behavior for streaming: a single
        // `| ...` line might be the start of a table, so defer it until
        // we see more content.  When it IS followed by non-table text,
        // it will be rendered (the function detects the table block does
        // NOT extend to end of content).
        const input = "| Just a line\n\nMore text";
        const result = sanitize(input);
        // During streaming, a single line starting with | at the end IS
        // deferred (case 2).  When followed by "More text", the table
        // block no longer extends to end → rendered.
        // Since "| Just a line" is followed by "\n\nMore text" which is
        // non-table content, it should be rendered.
        expect(result).toContain("| Just a line");
        expect(result).toContain("More text");
    });

    // ── Blocks that end without trailing newline ──────────────────────────

    it("defers a trailing table even when content has no final newline", () => {
        const input = "Intro\n\n| X | Y |\n| --- | --- |\n| 1 | 2 |";
        const result = sanitize(input);
        expect(result).not.toContain("| X");
        expect(result).toContain("Intro");
    });
});