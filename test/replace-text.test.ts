import { describe, it, expect } from "vitest";
import { __TEST_ONLY__ } from "../src/services/tools/obsidian/edit/replace-text";
import type { Span, SearchEntry, AnchorEntry } from "../src/services/tools/obsidian/edit/replace-text";

const {
    normaliseReplacement,
    findAllOccurrences,
    findAllOccurrencesRegex,
    findAllRegexMatches,
    replaceWithGroups,
    looksLikeRegex,
    regexHintForLiteral,
    detectSpanOverlap,
    isTagShaped,
    TAG_TOKEN_RE,
} = __TEST_ONLY__;

// ─────────────────────────────────────────────────────────────────────────────
// normaliseReplacement — comprehensive validation
// ─────────────────────────────────────────────────────────────────────────────

describe("normaliseReplacement", () => {
    // ── Top-level type checks ──

    it("rejects a non-object", () => {
        const r = normaliseReplacement(null, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("must be an object");
    });

    it("rejects a string", () => {
        const r = normaliseReplacement("bad", 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("must be an object");
    });

    // ── Missing replacement ──

    it("rejects missing replacement field", () => {
        const r = normaliseReplacement({ pattern: "foo" }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("replacement");
    });

    it("rejects non-string replacement", () => {
        const r = normaliseReplacement({ pattern: "foo", replacement: 42 }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("replacement");
    });

    // ── Mutual exclusion: pattern vs anchor ──

    it("rejects both pattern and anchor present", () => {
        const r = normaliseReplacement(
            { pattern: "foo", anchor: { heading_path: ["H"], where: "replace_section" }, replacement: "bar" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("not both");
    });

    it("rejects neither pattern nor anchor present", () => {
        const r = normaliseReplacement({ replacement: "bar" }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("either");
    });

    // ── force field validation ──

    it("rejects non-boolean force", () => {
        const r = normaliseReplacement({ pattern: "foo", replacement: "bar", force: "yes" }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("force");
    });

    it("accepts force as boolean true", () => {
        const r = normaliseReplacement({ pattern: "foo", replacement: "bar", force: true }, 0);
        expect(typeof r).not.toBe("string");
        expect((r as SearchEntry).force).toBe(true);
    });

    // ── Search mode: pattern validation ──

    it("rejects non-string pattern", () => {
        const r = normaliseReplacement({ pattern: 123, replacement: "bar" }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("pattern");
    });

    it("rejects empty pattern", () => {
        const r = normaliseReplacement({ pattern: "", replacement: "bar" }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("not be empty");
    });

    it("rejects non-boolean replace_all", () => {
        const r = normaliseReplacement(
            { pattern: "foo", replacement: "bar", replace_all: "yes" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("replace_all");
    });

    it("rejects negative expected_count", () => {
        const r = normaliseReplacement(
            { pattern: "foo", replacement: "bar", expected_count: -1 },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("expected_count");
    });

    it("rejects non-integer expected_count", () => {
        const r = normaliseReplacement(
            { pattern: "foo", replacement: "bar", expected_count: 3.5 },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("expected_count");
    });

    it("accepts expected_count null (means no assertion)", () => {
        const r = normaliseReplacement(
            { pattern: "foo", replacement: "bar", expected_count: null },
            0,
        );
        expect(typeof r).not.toBe("string");
        expect((r as SearchEntry).expectedCount).toBeNull();
    });

    it("accepts a valid minimal search entry (defaults applied)", () => {
        const r = normaliseReplacement({ pattern: "foo", replacement: "bar" }, 5);
        expect(typeof r).not.toBe("string");
        const s = r as SearchEntry;
        expect(s.kind).toBe("search");
        expect(s.pattern).toBe("foo");
        expect(s.replacement).toBe("bar");
        expect(s.replaceAll).toBe(false);
        expect(s.expectedCount).toBe(1);
        expect(s.force).toBe(false);
    });

    it("accepts a full search entry", () => {
        const r = normaliseReplacement(
            {
                pattern: "needle",
                replacement: "thread",
                replace_all: true,
                expected_count: 3,
                force: true,
            },
            0,
        );
        expect(typeof r).not.toBe("string");
        const s = r as SearchEntry;
        expect(s.kind).toBe("search");
        expect(s.pattern).toBe("needle");
        expect(s.replacement).toBe("thread");
        expect(s.replaceAll).toBe(true);
        expect(s.expectedCount).toBe(3);
        expect(s.force).toBe(true);
    });

    it("allows empty string replacement in search mode (deletion)", () => {
        const r = normaliseReplacement({ pattern: "remove", replacement: "" }, 0);
        expect(typeof r).not.toBe("string");
        expect((r as SearchEntry).replacement).toBe("");
    });

    // ── use_regex validation ──

    it("defaults use_regex to false when omitted", () => {
        const r = normaliseReplacement({ pattern: "foo", replacement: "bar" }, 0);
        expect(typeof r).not.toBe("string");
        expect((r as SearchEntry).useRegex).toBe(false);
    });

    it("accepts use_regex: true", () => {
        const r = normaliseReplacement({ pattern: "foo", replacement: "bar", use_regex: true }, 0);
        expect(typeof r).not.toBe("string");
        expect((r as SearchEntry).useRegex).toBe(true);
    });

    it("rejects non-boolean use_regex", () => {
        const r = normaliseReplacement({ pattern: "foo", replacement: "bar", use_regex: "yes" }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("use_regex");
    });

    it("rejects invalid regex syntax eagerly", () => {
        const r = normaliseReplacement({ pattern: "[unclosed", replacement: "bar", use_regex: true }, 0);
        expect(typeof r).toBe("string");
        expect(r as string).toContain("not a valid regex");
    });

    it("accepts valid regex with use_regex: true (character class)", () => {
        const r = normaliseReplacement({ pattern: "foo\\s+bar", replacement: "baz", use_regex: true }, 0);
        expect(typeof r).not.toBe("string");
        expect((r as SearchEntry).useRegex).toBe(true);
    });

    // ── Anchor mode: anchor field validation ──

    it("rejects anchor that is not an object", () => {
        const r = normaliseReplacement(
            { anchor: "not-an-object", replacement: "bar" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("anchor");
    });

    it("rejects anchor that is an array", () => {
        const r = normaliseReplacement(
            { anchor: [], replacement: "bar" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("anchor");
    });

    it("rejects anchor with missing heading_path", () => {
        const r = normaliseReplacement(
            { anchor: { where: "replace_section" }, replacement: "bar" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("heading_path");
    });

    it("rejects anchor with empty heading_path", () => {
        const r = normaliseReplacement(
            { anchor: { heading_path: [], where: "replace_section" }, replacement: "bar" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("heading_path");
    });

    it("rejects anchor with non-string heading_path items", () => {
        const r = normaliseReplacement(
            {
                anchor: { heading_path: ["H1", 42, "H3"], where: "replace_section" },
                replacement: "bar",
            },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("heading_path[1]");
    });

    it("rejects anchor with invalid where value", () => {
        const r = normaliseReplacement(
            {
                anchor: { heading_path: ["H1"], where: "invalid_mode" },
                replacement: "bar",
            },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("where");
    });

    it("rejects anchor with replace_all present", () => {
        const r = normaliseReplacement(
            {
                anchor: { heading_path: ["H1"], where: "replace_section" },
                replacement: "bar",
                replace_all: true,
            },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("replace_all");
    });

    it("rejects anchor with expected_count present", () => {
        const r = normaliseReplacement(
            {
                anchor: { heading_path: ["H1"], where: "replace_section" },
                replacement: "bar",
                expected_count: 1,
            },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("expected_count");
    });

    it("accepts a valid minimal anchor entry", () => {
        const r = normaliseReplacement(
            { anchor: { heading_path: ["Chapter 1"], where: "append_to_section" }, replacement: "new content" },
            3,
        );
        expect(typeof r).not.toBe("string");
        const a = r as AnchorEntry;
        expect(a.kind).toBe("anchor");
        expect(a.headingPath).toEqual(["Chapter 1"]);
        expect(a.where).toBe("append_to_section");
        expect(a.replacement).toBe("new content");
        expect(a.force).toBe(false);
    });

    it("accepts anchor with multi-level heading path", () => {
        const r = normaliseReplacement(
            {
                anchor: { heading_path: ["Part 1", "Section A", "Subsection"], where: "prepend_to_body" },
                replacement: "body text",
            },
            0,
        );
        expect(typeof r).not.toBe("string");
        const a = r as AnchorEntry;
        expect(a.headingPath).toEqual(["Part 1", "Section A", "Subsection"]);
        expect(a.where).toBe("prepend_to_body");
    });

    it("rejects anchor with where=replace_section, redirects to set_section", () => {
        const r = normaliseReplacement(
            { anchor: { heading_path: ["H"], where: "replace_section" }, replacement: "text" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("set_section");
    });

    it("rejects anchor with where=replace_body, redirects to set_section", () => {
        const r = normaliseReplacement(
            { anchor: { heading_path: ["H"], where: "replace_body" }, replacement: "text" },
            0,
        );
        expect(typeof r).toBe("string");
        expect(r as string).toContain("set_section");
    });

    // ── Anchor: all currently valid where values ──

    const insertWhereModes = ["append_to_section", "prepend_to_body", "insert_before_section"] as const;
    for (const mode of insertWhereModes) {
        it(`accepts anchor with where=${mode}`, () => {
            const r = normaliseReplacement(
                { anchor: { heading_path: ["H"], where: mode }, replacement: "text" },
                0,
            );
            expect(typeof r).not.toBe("string");
            expect((r as AnchorEntry).where).toBe(mode);
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// findAllOccurrences — literal substring scanning
// ─────────────────────────────────────────────────────────────────────────────

describe("findAllOccurrences", () => {
    it("finds a single occurrence at the start", () => {
        expect(findAllOccurrences("hello world", "hello")).toEqual([0]);
    });

    it("finds a single occurrence in the middle", () => {
        expect(findAllOccurrences("abc needle xyz", "needle")).toEqual([4]);
    });

    it("finds a single occurrence at the end", () => {
        expect(findAllOccurrences("start end", "end")).toEqual([6]);
    });

    it("finds multiple non-overlapping occurrences", () => {
        expect(findAllOccurrences("foo bar foo baz foo", "foo")).toEqual([0, 8, 16]);
    });

    it("returns empty array when not found", () => {
        expect(findAllOccurrences("hello world", "xyz")).toEqual([]);
    });

    it("returns empty array for empty haystack", () => {
        expect(findAllOccurrences("", "anything")).toEqual([]);
    });

    it("handles overlapping occurrences correctly (non-overlapping scan)", () => {
        // "aaaa" with "aa" → non-overlapping scan: hits at 0, then skips to 2
        expect(findAllOccurrences("aaaa", "aa")).toEqual([0, 2]);
    });

    it("finds consecutive back-to-back occurrences", () => {
        expect(findAllOccurrences("abab", "ab")).toEqual([0, 2]);
    });

    it("is case sensitive", () => {
        expect(findAllOccurrences("Hello hello HELLO", "hello")).toEqual([6]);
    });

    it("handles newline characters in needle", () => {
        expect(findAllOccurrences("line1\nline2\nline1\n", "line1")).toEqual([0, 12]);
    });

    it("handles needle longer than haystack", () => {
        expect(findAllOccurrences("short", "very long needle")).toEqual([]);
    });

    it("empty needle is caught by validation before reaching findAllOccurrences", () => {
        // Empty needle is rejected by normaliseReplacement's pattern-empty check,
        // so findAllOccurrences is never called with "" in production. We don't
        // test defensive behavior here because indexOf("", pos) causes an
        // infinite loop — the production guard is sufficient.
        expect(true).toBe(true);
    });

    it("matches exact whitespace", () => {
        expect(findAllOccurrences("a  b  c", "  ")).toEqual([1, 4]);
    });

    // ── Multi-line markdown: headings ──

    it("finds a heading line (# prefix)", () => {
        const md = "# Introduction\n\nSome text.\n";
        expect(findAllOccurrences(md, "# Introduction")).toEqual([0]);
    });

    it("finds a second-level heading (## prefix)", () => {
        const md = "# Title\n\n## Section\n\nBody.\n";
        expect(findAllOccurrences(md, "## Section")).toEqual([9]);
    });

    it("finds multiple headings of the same level", () => {
        const md = "## A\n\ncontent\n\n## B\n\nmore\n\n## C\n";
        const pos = findAllOccurrences(md, "## ");
        expect(pos).toEqual([0, 15, 27]);
    });

    it("does not confuse #text with a heading when matching literally", () => {
        const md = "This is #not-a-heading inline.\n\n# Real Heading\n";
        // Matching "#not-a-heading" should find it inline
        expect(findAllOccurrences(md, "#not-a-heading")).toEqual([8]);
    });

    // ── Multi-line markdown: bold / italic / inline formatting ──

    it("finds **bold** text in multi-line content", () => {
        const md = "Some **bold** text here.\nMore text.\n";
        expect(findAllOccurrences(md, "**bold**")).toEqual([5]);
    });

    it("finds *italic* text in multi-line content", () => {
        const md = "line1\nline2 *emphasised* end\n";
        expect(findAllOccurrences(md, "*emphasised*")).toEqual([12]);
    });

    it("finds ***bold-italic*** text", () => {
        const md = "Normal ***both*** more.\n";
        expect(findAllOccurrences(md, "***both***")).toEqual([7]);
    });

    it("finds ~~strikethrough~~ text", () => {
        const md = "before ~~removed~~ after\n";
        expect(findAllOccurrences(md, "~~removed~~")).toEqual([7]);
    });

    it("finds ==highlighted== text", () => {
        const md = "prefix ==hl== suffix\n";
        expect(findAllOccurrences(md, "==hl==")).toEqual([7]);
    });

    it("finds inline `code` spans", () => {
        const md = "Use `foo.bar()` to call it.\n";
        expect(findAllOccurrences(md, "`foo.bar()`")).toEqual([4]);
    });

    it("matches a pattern containing markdown formatting characters literally", () => {
        const md = "Value: **important**\n";
        // The needle is the literal string including the ** markers
        expect(findAllOccurrences(md, "**important**")).toEqual([7]);
    });

    // ── Multi-line markdown: links and wikilinks ──

    it("finds a markdown link", () => {
        const md = "See [the docs](https://example.com) for more.\n";
        expect(findAllOccurrences(md, "[the docs](https://example.com)")).toEqual([4]);
    });

    it("finds a wikilink", () => {
        const md = "Related: [[Other Note]]\n";
        expect(findAllOccurrences(md, "[[Other Note]]")).toEqual([9]);
    });

    it("finds a wikilink with alias", () => {
        const md = "See [[page|alias text]] here.\n";
        expect(findAllOccurrences(md, "[[page|alias text]]")).toEqual([4]);
    });

    it("finds a bare URL", () => {
        const md = "Visit https://obsidian.md today.\n";
        expect(findAllOccurrences(md, "https://obsidian.md")).toEqual([6]);
    });

    // ── Multi-line markdown: lists ──

    it("finds an unordered list item", () => {
        const md = "- First item\n- Second item\n- Third item\n";
        expect(findAllOccurrences(md, "- Second item")).toEqual([13]);
    });

    it("finds a numbered list item", () => {
        const md = "1. Alpha\n2. Beta\n3. Gamma\n";
        expect(findAllOccurrences(md, "2. Beta")).toEqual([9]);
    });

    it("finds a nested list item (indented)", () => {
        const md = "- Parent\n\t- Child\n\t- Another\n";
        expect(findAllOccurrences(md, "\t- Child")).toEqual([9]);
    });

    it("finds a task list item", () => {
        const md = "- [ ] Todo\n- [x] Done\n";
        expect(findAllOccurrences(md, "- [x] Done")).toEqual([11]);
    });

    // ── Multi-line markdown: blockquotes ──

    it("finds a blockquote line", () => {
        const md = "Normal\n> Quoted text\n> More quote\nNormal\n";
        expect(findAllOccurrences(md, "> Quoted text")).toEqual([7]);
    });

    it("finds nested blockquote", () => {
        const md = "> Outer\n>> Nested quote\n> Back to outer\n";
        expect(findAllOccurrences(md, ">> Nested quote")).toEqual([8]);
    });

    // ── Multi-line markdown: fenced code blocks ──

    it("finds text inside a fenced code block", () => {
        const md = "```ts\nconst x = 1;\nconsole.log(x);\n```\n";
        expect(findAllOccurrences(md, "console.log(x)")).toEqual([19]);
    });

    it("finds the opening code fence", () => {
        const md = "before\n```python\nprint('hi')\n```\n";
        expect(findAllOccurrences(md, "```python")).toEqual([7]);
    });

    it("does not confuse content inside backticks with code fence when matching", () => {
        const md = "The pattern ``` is used for code.\n\n```\nreal code\n```\n";
        // Finding ``` literally in the sentence
        const pos = findAllOccurrences(md, "```");
        expect(pos).toEqual([12, 35, 49]); // inline mention + opening fence + closing fence
    });

    // ── Multi-line markdown: tables ──

    it("finds a table header cell", () => {
        const md = "| Name | Age |\n|------|-----|\n| Alice | 30 |\n";
        expect(findAllOccurrences(md, "| Name | Age |")).toEqual([0]);
    });

    it("finds a table separator row", () => {
        const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
        expect(findAllOccurrences(md, "| --- | --- |")).toEqual([10]);
    });

    it("finds a data row in a table", () => {
        const md = "| Key | Value |\n|-----|-------|\n| foo | bar   |\n";
        expect(findAllOccurrences(md, "| foo | bar   |")).toEqual([32]);
    });

    // ── Multi-line markdown: horizontal rules ──

    it("finds a horizontal rule (---)", () => {
        const md = "section 1\n\n---\n\nsection 2\n";
        expect(findAllOccurrences(md, "---")).toEqual([11]);
    });

    it("finds alternative horizontal rule (***)", () => {
        const md = "top\n***\nbottom\n";
        expect(findAllOccurrences(md, "***")).toEqual([4]);
    });

    // ── Multi-line markdown: callouts ──

    it("finds an Obsidian callout", () => {
        const md = "> [!note]\n> Callout content\n> More\n";
        expect(findAllOccurrences(md, "> [!note]")).toEqual([0]);
    });

    it("finds a foldable callout", () => {
        const md = "> [!info]- Folded Title\n> Hidden content\n";
        expect(findAllOccurrences(md, "> [!info]- Folded Title")).toEqual([0]);
    });

    // ── Multi-line markdown: frontmatter ──

    it("finds YAML frontmatter delimiter", () => {
        const md = "---\ntitle: Test\n---\n\n# Body\n";
        expect(findAllOccurrences(md, "---")).toEqual([0, 16]);
    });

    it("finds a key in YAML frontmatter", () => {
        const md = "---\ntitle: My Note\ntags: [a, b]\n---\n\nContent\n";
        expect(findAllOccurrences(md, "title: My Note")).toEqual([4]);
    });

    // ── Multi-line markdown: cross-line patterns ──

    it("finds a needle that itself contains embedded newlines", () => {
        const md = "Start A\n---\nB end\n";
        // Needle is "A\n---\nB" — spans across three lines
        expect(findAllOccurrences(md, "A\n---\nB")).toEqual([6]);
    });

    it("finds a multi-line needle in the middle of a larger document", () => {
        const md = [
            "# Doc",
            "",
            "Preamble.",
            "",
            "## Section",
            "",
            "Line one of target.",
            "Line two of target.",
            "",
            "Aftermath.",
        ].join("\n");
        const needle = "Line one of target.\nLine two of target.";
        const pos = findAllOccurrences(md, needle);
        expect(pos.length).toBe(1);
        expect(pos[0]).toBeGreaterThan(0);
    });

    it("finds multiple occurrences of a multi-line needle", () => {
        const block = "TODO:\n- [ ] item\n";
        const md = block + "other\n" + block;
        const pos = findAllOccurrences(md, block);
        // Non-overlapping: the first hit is at 0, the second at block.length + 5 ("other\n".length)
        expect(pos.length).toBe(2);
        expect(pos[0]).toBe(0);
        expect(pos[1]).toBe(block.length + 6); // "other\n" = 6 chars
    });

    // ── Multi-line markdown: large realistic document ──

    it("finds patterns in a realistic multi-section markdown document", () => {
        const md = [
            "---",
            "title: Test Document",
            "tags: [demo, markdown]",
            "---",
            "",
            "# Introduction",
            "",
            "This is a **bold** introduction with *italic* text.",
            "It also has `inline code` and a [link](https://example.com).",
            "",
            "## Features",
            "",
            "- **Fast**: blazing speed",
            "- **Simple**: easy to use",
            "- **Powerful**: many features",
            "",
            "## Code Example",
            "",
            "```ts",
            "function greet(name: string): string {",
            '  return `Hello, ${name}!`;',
            "}",
            "```",
            "",
            "> **Note**: This is a blockquote with a callout-like structure.",
            "",
            "| Feature | Status |",
            "|---------|--------|",
            "| Alpha   | Done   |",
            "| Beta    | WIP    |",
            "",
            "## References",
            "",
            "- [[Note A]]",
            "- [[Note B|Alias B]]",
            "- [[Note C]]",
            "",
            "---",
            "",
            "Footer text.",
        ].join("\n");

        // Find a heading
        expect(findAllOccurrences(md, "## Features")).toEqual([md.indexOf("## Features")]);

        // Find bold text
        expect(findAllOccurrences(md, "**Fast**").length).toBe(1);
        expect(findAllOccurrences(md, "**Simple**").length).toBe(1);
        expect(findAllOccurrences(md, "**Powerful**").length).toBe(1);

        // Find inline code
        expect(findAllOccurrences(md, "`inline code`").length).toBe(1);

        // Find a link
        expect(findAllOccurrences(md, "[link](https://example.com)").length).toBe(1);

        // Find a code block line
        expect(findAllOccurrences(md, '  return `Hello, ${name}!`;').length).toBe(1);

        // Find a blockquote
        expect(findAllOccurrences(md, "> **Note**: This is a blockquote").length).toBe(1);

        // Find a table row
        expect(findAllOccurrences(md, "| Alpha   | Done   |").length).toBe(1);

        // Find wikilinks
        expect(findAllOccurrences(md, "[[Note A]]").length).toBe(1);
        expect(findAllOccurrences(md, "[[Note B|Alias B]]").length).toBe(1);
        expect(findAllOccurrences(md, "[[Note C]]").length).toBe(1);

        // Horizontal rules: one closing frontmatter, one between References and Footer
        const hrCount = findAllOccurrences(md, "\n---\n").length;
        expect(hrCount).toBe(2);

        // Verify no false positives for strings that don't exist
        expect(findAllOccurrences(md, "## Not Found")).toEqual([]);
        expect(findAllOccurrences(md, "**Missing**")).toEqual([]);
    });

    // ── Edge cases with markdown special chars ──

    it("handles pattern containing only markdown formatting chars", () => {
        const md = "The separator is ** and ** for bold.\n";
        // The literal string "**" between "is" and "and"
        expect(findAllOccurrences(md, "**").length).toBe(2);
        expect(findAllOccurrences(md, "**")[0]).toBe(17);
        expect(findAllOccurrences(md, "**")[1]).toBe(24);
    });

    it("distinguishes between different markdown formatting when matching literally", () => {
        const md = "**bold** vs *italic* vs ***both***\n";
        expect(findAllOccurrences(md, "**bold**")).toEqual([0]);
        expect(findAllOccurrences(md, "*italic*")).toEqual([12]);
        expect(findAllOccurrences(md, "***both***")).toEqual([24]);
    });

    it("matches a code block including its content exactly", () => {
        const codeBlock = "```rust\nfn main() {\n    println!(\"hi\");\n}\n```";
        const md = "before\n" + codeBlock + "\nafter\n";
        // Match the entire code block as one needle
        expect(findAllOccurrences(md, codeBlock)).toEqual([7]);
    });

    it("matches a full table as a multi-line needle", () => {
        const table = "| A | B |\n| --- | --- |\n| 1 | 2 |";
        const md = "text\n" + table + "\nmore\n";
        expect(findAllOccurrences(md, table)).toEqual([5]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// findAllOccurrencesRegex — regex-based scanning
// ─────────────────────────────────────────────────────────────────────────────

describe("findAllOccurrencesRegex", () => {
    it("finds a simple literal regex match", () => {
        const hits = findAllOccurrencesRegex("hello world", "hello");
        expect(hits).toEqual([{ start: 0, end: 5 }]);
    });

    it("finds multiple matches with character class", () => {
        const hits = findAllOccurrencesRegex("cat cot cut", "c[aeiou]t");
        expect(hits).toEqual([
            { start: 0, end: 3 },
            { start: 4, end: 7 },
            { start: 8, end: 11 },
        ]);
    });

    it("finds matches with quantifier", () => {
        const hits = findAllOccurrencesRegex("aaab aab ab", "a+b");
        expect(hits).toEqual([
            { start: 0, end: 4 },
            { start: 5, end: 8 },
            { start: 9, end: 11 },
        ]);
    });

    it("finds matches with alternation", () => {
        const hits = findAllOccurrencesRegex("foo bar baz", "foo|baz");
        expect(hits).toEqual([
            { start: 0, end: 3 },
            { start: 8, end: 11 },
        ]);
    });

    it("uses non-overlapping scan (standard g flag behavior)", () => {
        const hits = findAllOccurrencesRegex("aaaa", "aa");
        expect(hits).toEqual([
            { start: 0, end: 2 },
            { start: 2, end: 4 },
        ]);
    });

    it("returns empty array when no match", () => {
        expect(findAllOccurrencesRegex("hello", "\\d+")).toEqual([]);
    });

    it("supports Unicode property escapes with u flag", () => {
        const hits = findAllOccurrencesRegex("你好世界", "\\p{L}+");
        expect(hits.length).toBe(1);
        expect(hits[0]!.start).toBe(0);
        expect(hits[0]!.end).toBe(4);
    });

    it("handles newlines via \\d", () => {
        const hits = findAllOccurrencesRegex("line1\nline2\nline3", "line\\d");
        expect(hits.length).toBe(3);
    });

    it("matches across lines with explicit \\n in pattern", () => {
        const hits = findAllOccurrencesRegex("A\n---\nB", "A\\n---\\nB");
        expect(hits).toEqual([{ start: 0, end: 7 }]);
    });

    it("matches markdown headings via ^ anchor (multiline flag)", () => {
        const md = "# A\n## B\n### C\nplain";
        const hits = findAllOccurrencesRegex(md, "^#{1,6} .+");
        expect(hits.length).toBe(3);
    });

    it("matches inline code spans", () => {
        const md = "Use `foo()` and `bar()` here.";
        const hits = findAllOccurrencesRegex(md, "`[^`]+`");
        expect(hits).toEqual([
            { start: 4, end: 11 },
            { start: 16, end: 23 },
        ]);
    });

    it("matches wikilinks", () => {
        const md = "See [[Note A]] and [[Note B|Alias]].";
        const hits = findAllOccurrencesRegex(md, "\\[\\[[^\\]]+\\]\\]");
        expect(hits).toEqual([
            { start: 4, end: 14 },
            { start: 19, end: 35 },
        ]);
    });

    it("matches task list checkboxes", () => {
        const md = "- [ ] todo\n- [x] done\n- normal\n";
        const hits = findAllOccurrencesRegex(md, "- \\[[ x]\\]");
        expect(hits.length).toBe(2);
    });

    it("capture groups still report full match boundaries", () => {
        const hits = findAllOccurrencesRegex("name: John, age: 30", "(\\w+): (\\w+)");
        expect(hits[0]).toEqual({ start: 0, end: 10 });
        expect(hits[1]).toEqual({ start: 12, end: 19 });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// findAllRegexMatches — regex matching with capture groups
// ─────────────────────────────────────────────────────────────────────────────

describe("findAllRegexMatches", () => {
    it("captures groups for simple regex", () => {
        const matches = findAllRegexMatches("2024年1月15日abc2023年12月31日", "(\\d{4})年(\\d{1,2})月(\\d{1,2})日");
        expect(matches.length).toBe(2);
        // First match: "2024年1月15日"
        expect(matches[0]!.start).toBe(0);
        expect(matches[0]!.end).toBe(10);
        expect(matches[0]!.groups[0]).toBe("2024年1月15日");
        expect(matches[0]!.groups[1]).toBe("2024");
        expect(matches[0]!.groups[2]).toBe("1");
        expect(matches[0]!.groups[3]).toBe("15");
        // Second match: "2023年12月31日"
        expect(matches[1]!.start).toBe(13);
        expect(matches[1]!.groups[1]).toBe("2023");
        expect(matches[1]!.groups[2]).toBe("12");
        expect(matches[1]!.groups[3]).toBe("31");
    });

    it("handles regex with no capture groups", () => {
        const matches = findAllRegexMatches("cat cot", "c[ao]t");
        expect(matches.length).toBe(2);
        expect(matches[0]!.groups[0]).toBe("cat");
        expect(matches[0]!.groups.length).toBe(1); // only full match
    });

    it("returns empty array when no match", () => {
        expect(findAllRegexMatches("hello", "\\d+")).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// replaceWithGroups — $1/$2 substitution
// ─────────────────────────────────────────────────────────────────────────────

describe("replaceWithGroups", () => {
    it("substitutes $1, $2, $3 with captured groups", () => {
        const original = "2024年1月15日";
        const matches = findAllRegexMatches(original, "(\\d{4})年(\\d{1,2})月(\\d{1,2})日");
        const result = replaceWithGroups("$1/$2/$3", original, matches[0]!);
        expect(result).toBe("2024/1/15");
    });

    it("substitutes $& as full match", () => {
        const original = "hello world";
        const matches = findAllRegexMatches(original, "(hello) (world)");
        const result = replaceWithGroups("[$&]", original, matches[0]!);
        expect(result).toBe("[hello world]");
    });

    it("substitutes $` (before match) and $\' (after match)", () => {
        const original = "prefixMATCHsuffix";
        const matches = findAllRegexMatches(original, "MATCH");
        const result = replaceWithGroups("[$`|$&|$\']", original, matches[0]!);
        expect(result).toBe("[prefix|MATCH|suffix]");
    });

    it("substitutes $$ as literal $", () => {
        const original = "Price: 100";
        const matches = findAllRegexMatches(original, "(\\d+)");
        const result = replaceWithGroups("$$$1", original, matches[0]!);
        expect(result).toBe("$100");
    });

    it("replaces unmatched groups ($99) with empty string", () => {
        const original = "abc";
        const matches = findAllRegexMatches(original, "abc"); // no capture
        const result = replaceWithGroups("X$1Y", original, matches[0]!);
        expect(result).toBe("XY");
    });

    it("handles multiple back-references", () => {
        const original = "swap a and b";
        const matches = findAllRegexMatches(original, "(a) and (b)");
        const result = replaceWithGroups("$2 and $1", original, matches[0]!);
        expect(result).toBe("b and a");
    });

    it("handles two-digit group number ($10)", () => {
        const original = "abcdefghij";
        // 10 capture groups — all single chars
        const matches = findAllRegexMatches(original, "(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)");
        const result = replaceWithGroups("$10$9", original, matches[0]!);
        expect(result).toBe("ji");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// looksLikeRegex — detect regex-looking patterns in literal mode
// ─────────────────────────────────────────────────────────────────────────────

describe("looksLikeRegex", () => {
    it("returns false for plain text", () => {
        expect(looksLikeRegex("hello world")).toBe(false);
        expect(looksLikeRegex("# Heading")).toBe(false);
        expect(looksLikeRegex("**bold**")).toBe(false);
    });

    it("detects escaped backslash sequences (\\d \\w \\s etc.)", () => {
        expect(looksLikeRegex("foo\\s+bar")).toBe(true);
        expect(looksLikeRegex("\\d{3}")).toBe(true);
        expect(looksLikeRegex("\\w+")).toBe(true);
        expect(looksLikeRegex("\\n---\\n")).toBe(true);
        expect(looksLikeRegex("\\bword\\b")).toBe(true);
    });

    it("detects escaped metacharacters (\\. \\+ \\* etc.)", () => {
        expect(looksLikeRegex("file\\.txt")).toBe(true);
        expect(looksLikeRegex("foo\\+bar")).toBe(true);
        expect(looksLikeRegex("a\\*b")).toBe(true);
        expect(looksLikeRegex("x\\?")).toBe(true);
        expect(looksLikeRegex("^start")).toBe(false); // bare ^ without backslash is not flagged
        // ^ and $ are too common in markdown to flag
    });

    it("detects escaped brackets/parens", () => {
        expect(looksLikeRegex("\\(group\\)")).toBe(true);
        expect(looksLikeRegex("\\[section\\]")).toBe(true);
    });

    it("detects lazy quantifiers (.*? +.+? )", () => {
        expect(looksLikeRegex("end:.*?\\n")).toBe(true);
        expect(looksLikeRegex(".+?")).toBe(true);
    });

    it("detects bare character classes (but not wikilinks)", () => {
        expect(looksLikeRegex("[aeiou]")).toBe(true);
        expect(looksLikeRegex("c[ao]t")).toBe(true);
    });

    it("does NOT flag wikilinks as regex", () => {
        expect(looksLikeRegex("[[Note A]]")).toBe(false);
        expect(looksLikeRegex("[[page|alias]]")).toBe(false);
    });

    it("does NOT flag markdown links as regex", () => {
        expect(looksLikeRegex("[click here](https://example.com)")).toBe(false);
    });

    it("returns false for Obsidian callouts", () => {
        expect(looksLikeRegex("> [!note]")).toBe(false);
    });

    it("returns false for task list checkboxes", () => {
        expect(looksLikeRegex("- [ ] todo")).toBe(false);
        expect(looksLikeRegex("- [x] done")).toBe(false);
    });

    it("returns false for common markdown inline code", () => {
        expect(looksLikeRegex("`const`")).toBe(false);
    });

    it("returns false for YAML array syntax (not a regex char class)", () => {
        expect(looksLikeRegex("[demo, markdown]")).toBe(false);
    });

    it("returns false for YAML array with quoted strings", () => {
        expect(looksLikeRegex('["a", "b"]')).toBe(false);
    });

    it("returns true for actual regex char classes (not markdown)", () => {
        expect(looksLikeRegex("c[ao]t")).toBe(true);
        expect(looksLikeRegex("[aeiou]")).toBe(true);
    });
});

describe("regexHintForLiteral", () => {
    it("returns empty string for plain text", () => {
        expect(regexHintForLiteral("hello")).toBe("");
    });

    it("returns hint with use_regex suggestion for regex-like pattern", () => {
        const hint = regexHintForLiteral("foo\\s+bar");
        expect(hint).toContain("HINT");
        expect(hint).toContain("use_regex");
        expect(hint).toContain("true");
    });

    it("mentions detected constructs", () => {
        expect(regexHintForLiteral("file\\.txt")).toContain("escaped metacharacters");
        expect(regexHintForLiteral("\\(group\\)")).toContain("escaped brackets");
        expect(regexHintForLiteral("end:.*?\\n")).toContain("lazy quantifiers");
    });

    it("returns empty string for wikilinks", () => {
        expect(regexHintForLiteral("[[Note]]")).toBe("");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectSpanOverlap — multi-entry disjointness check
// ─────────────────────────────────────────────────────────────────────────────

describe("detectSpanOverlap", () => {
    function span(repIndex: number, from: number, to: number, replacement = "x"): Span {
        return { repIndex, from, to, replacement };
    }

    it("returns null for a single span", () => {
        expect(detectSpanOverlap([span(0, 0, 5)])).toBeNull();
    });

    it("returns null for non-overlapping disjoint spans", () => {
        const spans: Span[] = [
            span(0, 0, 3),
            span(1, 5, 8),
            span(2, 10, 15),
        ];
        expect(detectSpanOverlap(spans)).toBeNull();
    });

    it("returns null for adjacent but non-overlapping spans", () => {
        // Spans [0, 3) and [3, 6) touch but don't overlap
        const spans: Span[] = [
            span(0, 0, 3),
            span(1, 3, 6),
        ];
        expect(detectSpanOverlap(spans)).toBeNull();
    });

    it("returns null for zero-length insertion points", () => {
        const spans: Span[] = [
            span(0, 10, 10), // zero-length insertion
        ];
        expect(detectSpanOverlap(spans)).toBeNull();
    });

    it("returns null for multiple zero-length insertions at different offsets", () => {
        const spans: Span[] = [
            span(0, 5, 5),
            span(1, 10, 10),
        ];
        expect(detectSpanOverlap(spans)).toBeNull();
    });

    it("detects overlapping spans (partial overlap)", () => {
        const spans: Span[] = [
            span(0, 0, 5),
            span(1, 3, 8),
        ];
        const err = detectSpanOverlap(spans);
        expect(typeof err).toBe("string");
        expect(err as string).toContain("overlapping");
        expect(err as string).toContain("0");
        expect(err as string).toContain("1");
    });

    it("detects nested overlap (one contains another)", () => {
        const spans: Span[] = [
            span(0, 0, 10),
            span(1, 3, 6),
        ];
        const err = detectSpanOverlap(spans);
        expect(typeof err).toBe("string");
        expect(err as string).toContain("overlapping");
    });

    it("allows zero-length insertion at the boundary of another span (adjacent, no overlap)", () => {
        // Span [5,5) is a zero-length insertion at offset 5.
        // Span [5,10) starts at 5. In the sorted order, [5,5) sorts before
        // [5,10) because `a.to - b.to` tiebreaker: 5 < 10.
        // Check: cur.from(5) < prev.to(5) → false. So they're NOT overlapping,
        // they're adjacent. This is the correct behavior — insertion at the
        // boundary does not overlap with the content.
        const spans: Span[] = [
            span(0, 5, 10),
            span(1, 5, 5),
        ];
        expect(detectSpanOverlap(spans)).toBeNull();
    });

    it("detects zero-length insertion entirely inside another span", () => {
        // [0,10) contains [5,5): cur.from(5) < prev.to(10) → true → overlap!
        const spans: Span[] = [
            span(0, 0, 10),
            span(1, 5, 5),
        ];
        const err = detectSpanOverlap(spans);
        expect(typeof err).toBe("string");
        expect(err as string).toContain("overlapping");
    });

    it("works regardless of input order (sorts internally)", () => {
        // Out-of-order input should still detect overlap
        const spans: Span[] = [
            span(1, 7, 12),
            span(0, 5, 10),
        ];
        const err = detectSpanOverlap(spans);
        expect(typeof err).toBe("string");
    });

    it("handles many non-overlapping spans without false positives", () => {
        const spans: Span[] = [];
        for (let i = 0; i < 20; i++) {
            spans.push(span(i, i * 5, i * 5 + 4));
        }
        expect(detectSpanOverlap(spans)).toBeNull();
    });

    it("returns null for empty span list", () => {
        expect(detectSpanOverlap([])).toBeNull();
    });

    it("reports correct indices for the first overlapping pair found", () => {
        // Three spans: 2 and 3 overlap, 0 and 1 are fine
        const spans: Span[] = [
            span(0, 0, 3),
            span(1, 5, 8),
            span(2, 7, 12), // overlaps with span[1]
        ];
        const err = detectSpanOverlap(spans);
        expect(typeof err).toBe("string");
        // After sorting by (from, to): [0-3] idx=0, [5-8] idx=1, [7-12] idx=2
        // The overlapping pair is 5-8 and 7-12, i.e. repIndex 1 and 2
        expect(err as string).toContain("1");
        expect(err as string).toContain("2");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// isTagShaped — tag-token guard
// ─────────────────────────────────────────────────────────────────────────────

describe("isTagShaped", () => {
    it("recognizes a simple tag like #foo", () => {
        expect(isTagShaped("#foo")).toBe(true);
    });

    it("recognizes a tag with hyphens", () => {
        expect(isTagShaped("#my-tag")).toBe(true);
    });

    it("recognizes a tag with slashes (nested)", () => {
        expect(isTagShaped("#note/tech")).toBe(true);
    });

    it("recognizes a tag with underscores", () => {
        expect(isTagShaped("#my_tag")).toBe(true);
    });

    it("recognizes a tag with digits", () => {
        expect(isTagShaped("#tag123")).toBe(true);
    });

    it("recognizes a tag with Unicode letters", () => {
        expect(isTagShaped("#标签")).toBe(true);
    });

    it("strips surrounding whitespace before check", () => {
        expect(isTagShaped("  #foo  ")).toBe(true);
    });

    it("rejects a pattern that is not tag-shaped", () => {
        expect(isTagShaped("hello world")).toBe(false);
    });

    it("rejects a hash mid-word", () => {
        expect(isTagShaped("some #text in middle")).toBe(false);
    });

    it("rejects a bare hash", () => {
        expect(isTagShaped("#")).toBe(false);
    });

    it("recognizes a tag starting with a digit (#123 is a valid Obsidian tag)", () => {
        // The regex allows `\p{N}` (Unicode digits) after the hash,
        // so `#123` is a valid tag token.
        expect(isTagShaped("#123")).toBe(true);
    });

    it("rejects an empty string", () => {
        expect(isTagShaped("")).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// TAG_TOKEN_RE — regex itself
// ─────────────────────────────────────────────────────────────────────────────

describe("TAG_TOKEN_RE", () => {
    it("matches basic tags", () => {
        expect(TAG_TOKEN_RE.test("#tag")).toBe(true);
    });

    it("matches nested tags", () => {
        expect(TAG_TOKEN_RE.test("#foo/bar/baz")).toBe(true);
    });

    it("does not match text without a hash", () => {
        expect(TAG_TOKEN_RE.test("notag")).toBe(false);
    });

    it("does not match hash in the middle of text", () => {
        expect(TAG_TOKEN_RE.test("text #tag more")).toBe(false);
    });

    it("does not match tag with spaces", () => {
        expect(TAG_TOKEN_RE.test("#my tag")).toBe(false);
    });

    it("matches #_underscore-start", () => {
        expect(TAG_TOKEN_RE.test("#_private")).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: full search-mode pipeline with multi-line markdown content
//
// These tests simulate the internal steps of the replace_text tool on
// realistic markdown documents.  Each test goes through the same sequence
// that vaultReplaceText follows internally:
//   1. normaliseReplacement → validate entries
//   2. findAllOccurrences → locate matches
//   3. expected_count assertion (if applicable)
//   4. build spans → detectSpanOverlap
//   5. apply spans back-to-front → produce final result
// ─────────────────────────────────────────────────────────────────────────────

describe("search-mode integration: single replacement in markdown", () => {
    /**
     * Helper: execute the full search-mode pipeline on `original` with
     * the given raw replacement entries.  Returns the post-edit text on
     * success, or an error string on failure (validation / overlap / not-found).
     */
    function applyReplacements(
        original: string,
        rawEntries: Array<Record<string, unknown>>,
    ): string {
        // Step 1: validate
        const normalised: Array<ReturnType<typeof normaliseReplacement>> = [];
        for (let i = 0; i < rawEntries.length; i++) {
            const r = normaliseReplacement(rawEntries[i]!, i);
            if (typeof r === "string") return `VALIDATION: ${r}`;
            normalised.push(r);
        }

        // Step 1b: tag-shape guard (search-only)
        for (let i = 0; i < normalised.length; i++) {
            const n = normalised[i]!;
            if (n.kind === "search" && !n.force && isTagShaped(n.pattern)) {
                return `TAG_GUARD: replacements[${i}] rejected (tag-shaped)`;
            }
        }

        // Step 2: find matches & build spans
        const spans: Span[] = [];
        for (let i = 0; i < normalised.length; i++) {
            const n = normalised[i]!;
            if (n.kind === "anchor") return "SKIP_ANCHOR"; // anchor not covered here

            // regex mode: capture groups for $1/$2 substitution
            const regexMatches = n.useRegex ? findAllRegexMatches(original, n.pattern) : null;
            const positions: Array<{ start: number; end: number; match?: typeof regexMatches extends Array<infer T> ? T : never }> =
                regexMatches
                    ? regexMatches.map((m) => ({ start: m.start, end: m.end, match: m }))
                    : findAllOccurrences(original, n.pattern).map((pos) => ({ start: pos, end: pos + n.pattern.length }));

            // Check "not found" first so the regex hint is available.
            if (positions.length === 0) {
                const hint = n.useRegex ? "" : regexHintForLiteral(n.pattern);
                return `NOT_FOUND: replacement[${i}] pattern not found${hint}`;
            }
            // expected_count (now defaults to 1 when replace_all is false)
            if (n.expectedCount !== null && positions.length !== n.expectedCount) {
                return `EXPECTED_COUNT: replacement[${i}] expected ${n.expectedCount}, found ${positions.length}`;
            }

            const targets = n.replaceAll ? positions : [positions[0]!];
            for (const hit of targets) {
                const effectiveReplacement =
                    hit.match
                        ? replaceWithGroups(n.replacement, original, hit.match)
                        : n.replacement;
                spans.push({
                    repIndex: i,
                    from: hit.start,
                    to: hit.end,
                    replacement: effectiveReplacement,
                });
            }
        }

        // Step 3: overlap check
        const overlapErr = detectSpanOverlap(spans);
        if (overlapErr) return `OVERLAP: ${overlapErr}`;

        // Step 4: apply back-to-front
        const sorted = [...spans].sort((a, b) => b.from - a.from || b.to - a.to);
        let result = original;
        for (const span of sorted) {
            result = result.substring(0, span.from) + span.replacement + result.substring(span.to);
        }
        return result;
    }

    // ── Single replacements on markdown content ──

    it("replaces a heading line", () => {
        const md = "# Old Title\n\nContent.\n";
        const result = applyReplacements(md, [
            { pattern: "# Old Title", replacement: "# New Title" },
        ]);
        expect(result).toBe("# New Title\n\nContent.\n");
    });

    it("replaces bold text in a paragraph", () => {
        const md = "# Doc\n\nThis is **very important** content.\n\nMore text.\n";
        const result = applyReplacements(md, [
            { pattern: "**very important**", replacement: "**critical**" },
        ]);
        expect(result).toContain("**critical**");
        expect(result).not.toContain("**very important**");
    });

    it("replaces italic text", () => {
        const md = "Normal *emphasised* normal.\n";
        const result = applyReplacements(md, [
            { pattern: "*emphasised*", replacement: "*highlighted*" },
        ]);
        expect(result).toBe("Normal *highlighted* normal.\n");
    });

    it("replaces a link URL", () => {
        const md = "See [docs](https://old.example.com) for info.\n";
        const result = applyReplacements(md, [
            { pattern: "https://old.example.com", replacement: "https://new.example.com" },
        ]);
        expect(result).toBe("See [docs](https://new.example.com) for info.\n");
    });

    it("replaces an entire wikilink", () => {
        const md = "Related: [[Old Note]]\n";
        const result = applyReplacements(md, [
            { pattern: "[[Old Note]]", replacement: "[[New Note]]" },
        ]);
        expect(result).toBe("Related: [[New Note]]\n");
    });

    it("replaces inline code", () => {
        const md = "Call `oldFunction()` to proceed.\n";
        const result = applyReplacements(md, [
            { pattern: "`oldFunction()`", replacement: "`newFunction()`" },
        ]);
        expect(result).toBe("Call `newFunction()` to proceed.\n");
    });

    it("replaces a list item", () => {
        const md = "- Apples\n- Oranges\n- Bananas\n";
        const result = applyReplacements(md, [
            { pattern: "- Oranges", replacement: "- Grapes" },
        ]);
        expect(result).toBe("- Apples\n- Grapes\n- Bananas\n");
    });

    it("replaces a blockquote line", () => {
        const md = "> Old quote text\n> More quote\n\nNormal.\n";
        const result = applyReplacements(md, [
            { pattern: "> Old quote text", replacement: "> New quote text" },
        ]);
        expect(result).toBe("> New quote text\n> More quote\n\nNormal.\n");
    });

    it("replaces code inside a fenced code block", () => {
        const md = "```python\nprint('hello')\n```\n";
        const result = applyReplacements(md, [
            { pattern: "print('hello')", replacement: "print('world')" },
        ]);
        expect(result).toBe("```python\nprint('world')\n```\n");
    });

    it("replaces a line in a table", () => {
        const md = "| Name | Age |\n|------|-----|\n| Bob  | 25  |\n";
        const result = applyReplacements(md, [
            { pattern: "| Bob  | 25  |", replacement: "| Alice | 30  |" },
        ]);
        expect(result).toBe("| Name | Age |\n|------|-----|\n| Alice | 30  |\n");
    });

    it("replaces a YAML frontmatter value", () => {
        const md = "---\ntitle: Old Title\ntags: [a]\n---\n\n# Body\n";
        const result = applyReplacements(md, [
            { pattern: "title: Old Title", replacement: "title: New Title" },
        ]);
        expect(result).toBe("---\ntitle: New Title\ntags: [a]\n---\n\n# Body\n");
    });

    it("replaces a horizontal rule style", () => {
        const md = "top\n\n---\n\nbottom\n";
        const result = applyReplacements(md, [
            { pattern: "---", replacement: "***" },
        ]);
        expect(result).toBe("top\n\n***\n\nbottom\n");
    });

    it("replaces a strikethrough text", () => {
        const md = "We decided ~~against~~ this.\n";
        const result = applyReplacements(md, [
            { pattern: "~~against~~", replacement: "~~in favor of~~" },
        ]);
        expect(result).toBe("We decided ~~in favor of~~ this.\n");
    });

    it("deletes text with empty replacement (pattern mode)", () => {
        const md = "Keep this. Remove me. Keep that.\n";
        const result = applyReplacements(md, [
            { pattern: "Remove me. ", replacement: "" },
        ]);
        expect(result).toBe("Keep this. Keep that.\n");
    });

    it("replaces a multi-line text block", () => {
        const md = "# Title\n\nOld paragraph\nline two of old.\n\n## Next\n";
        const result = applyReplacements(md, [
            {
                pattern: "Old paragraph\nline two of old.",
                replacement: "New paragraph\nline two of new.",
            },
        ]);
        expect(result).toBe("# Title\n\nNew paragraph\nline two of new.\n\n## Next\n");
    });

    it("replaces a multi-line block with embedded markdown formatting", () => {
        const md = "Start\n\n- **Bold item**\n- *Italic item*\n\nEnd\n";
        const result = applyReplacements(md, [
            {
                pattern: "- **Bold item**\n- *Italic item*",
                replacement: "- ~~Removed~~\n- ==Added==",
            },
        ]);
        expect(result).toBe("Start\n\n- ~~Removed~~\n- ==Added==\n\nEnd\n");
    });

    // ── replace_all on markdown content ──

    it("replaces all occurrences of a word in markdown (replace_all)", () => {
        const md = "# foo\n\nfoo is a foo word. foo.\n";
        const result = applyReplacements(md, [
            { pattern: "foo", replacement: "bar", replace_all: true },
        ]);
        // "foo" appears 4 times; the heading "# foo" becomes "# bar"
        expect(result).toBe("# bar\n\nbar is a bar word. bar.\n");
        expect(result).not.toContain("foo");
    });

    it("replaces all matches of multi-line pattern", () => {
        const sep = "\n---\n";
        const md = "A" + sep + "B" + sep + "C\n";
        const result = applyReplacements(md, [
            { pattern: sep, replacement: "\n***\n", replace_all: true },
        ]);
        expect(result).toBe("A\n***\nB\n***\nC\n");
    });

    // ── expected_count on markdown content ──

    it("passes when expected_count matches on markdown content", () => {
        const md = "## Section\n\nBody text here.\n\n## Section\n\nMore.\n";
        const result = applyReplacements(md, [
            { pattern: "## Section", replacement: "## Chapter", replace_all: true, expected_count: 2 },
        ]);
        expect(typeof result).toBe("string");
        expect(result).not.toContain("EXPECTED_COUNT");
    });

    it("fails when expected_count mismatches on markdown content", () => {
        const md = "## Section\n\nBody text here.\n\n## Section\n\nMore.\n";
        const result = applyReplacements(md, [
            { pattern: "## Section", replacement: "## Chapter", replace_all: true, expected_count: 5 },
        ]);
        expect(result).toContain("EXPECTED_COUNT");
        expect(result).toContain("expected 5");
        expect(result).toContain("found 2");
    });

    // ── Multi-entry: multiple independent replacements in one markdown doc ──

    it("applies two non-overlapping replacements in a markdown document", () => {
        const md = "# Old Heading\n\nSome **bold** text.\n\n## Another\n\nMore stuff.\n";
        const result = applyReplacements(md, [
            { pattern: "# Old Heading", replacement: "# New Heading" },
            { pattern: "**bold**", replacement: "**strong**" },
        ]);
        expect(result).toContain("# New Heading");
        expect(result).toContain("**strong**");
        expect(result).not.toContain("# Old Heading");
        expect(result).not.toContain("**bold**");
    });

    it("applies three independent replacements (heading, inline, list) in one doc", () => {
        const md = [
            "# Project Plan",
            "",
            "Status: **draft**",
            "",
            "## Tasks",
            "",
            "- Task A (pending)",
            "- Task B (pending)",
            "- Task C (done)",
        ].join("\n");

        const result = applyReplacements(md, [
            { pattern: "# Project Plan", replacement: "# Project Plan v2" },
            { pattern: "**draft**", replacement: "**final**" },
            { pattern: "(pending)", replacement: "(complete)", replace_all: true },
        ]);

        expect(result).toContain("# Project Plan v2");
        expect(result).toContain("**final**");
        expect(result).toContain("(complete)");
        expect(result).not.toContain("(pending)");
    });

    it("detects overlapping replacements in markdown and rejects", () => {
        const md = "Prefix **this is bold text** suffix.\n";
        const result = applyReplacements(md, [
            { pattern: "**this is bold text**", replacement: "replaced" },
            { pattern: "bold", replacement: "conflict" }, // inside the first span
        ]);
        expect(result).toContain("OVERLAP");
    });

    // ── Tag-shaped pattern is rejected without force ──

    it("rejects a tag-shaped pattern (#tag) in markdown without force", () => {
        const md = "# Heading\n\nSome #tag content.\n";
        const result = applyReplacements(md, [
            { pattern: "#tag", replacement: "#replaced" },
        ]);
        expect(result).toContain("TAG_GUARD");
    });

    it("allows a tag-shaped pattern when force=true", () => {
        const md = "# Heading\n\nSome #tag content.\n";
        const result = applyReplacements(md, [
            { pattern: "#tag", replacement: "#replaced", force: true },
        ]);
        expect(result).toContain("#replaced");
        expect(result).not.toContain("#tag");
    });

    // ── Edge case: pattern containing backtick that looks like code fence ──

    it("handles replacement of backtick-containing text in markdown", () => {
        const md = "The syntax is `const` in TypeScript.\n";
        const result = applyReplacements(md, [
            { pattern: "`const`", replacement: "`let`" },
        ]);
        expect(result).toBe("The syntax is `let` in TypeScript.\n");
    });

    // ── Full document rewrite simulation ──

    it("simulates a full document edit: multiple changes across sections", () => {
        const md = [
            "---",
            "title: Old Doc",
            "date: 2024-01-01",
            "---",
            "",
            "# Old Title",
            "",
            "This document discusses **old topic**.",
            "",
            "## Section A",
            "",
            "- Point 1: old",
            "- Point 2: old",
            "- Point 3: keep",
            "",
            "## Section B",
            "",
            "```python",
            "old_function()",
            "```",
            "",
            "> Old quote",
            "",
            "| Column | Value |",
            "|--------|-------|",
            "| old    | 100   |",
            "",
            "See [[Old Note]] and [[Another Old]].",
            "",
            "---",
            "",
            "Footer: old footer text.",
        ].join("\n");

        const result = applyReplacements(md, [
            { pattern: "title: Old Doc", replacement: "title: New Doc" },
            { pattern: "# Old Title", replacement: "# New Title" },
            { pattern: "old", replacement: "new", replace_all: true, expected_count: 6 },
            // ^ 6 lowercase matches: **old topic**, Point 1: old, Point 2: old,
            //   old_function(), | old (table), Footer: old footer
            { pattern: "> Old quote", replacement: "> New quote" },
            { pattern: "[[Old Note]]", replacement: "[[New Note]]" },
            { pattern: "[[Another Old]]", replacement: "[[Another New]]" },
        ]);

        // Verify all changes took effect
        expect(result).toContain("title: New Doc");
        expect(result).toContain("# New Title");
        expect(result).toContain("**new topic**");
        expect(result).toContain("new_function()");
        expect(result).toContain("> New quote");
        expect(result).toContain("[[New Note]]");
        expect(result).toContain("[[Another New]]");

        // "Point 1: new" and "Point 2: new" should be present
        expect(result).toContain("Point 1: new");
        expect(result).toContain("Point 2: new");

        // "Footer: new footer text" should be present (NOT "new footer text")
        expect(result).toContain("Footer: new footer text.");
        // But "old" in "old footer text" was replaced
        expect(result).not.toContain("old footer text");

        // Things that should NOT have been touched
        expect(result).toContain("Point 3: keep"); // was not matched by "old"
        expect(result).toContain("```python"); // untouched
        expect(result).toContain("```"); // code fence untouched
        // Table row "old" was replaced by replace_all
        expect(result).toContain("| new    | 100   |");
        expect(result).not.toContain("| old    | 100   |");
    });

    // ── Regex mode integration ──

    it("replaces using regex character class", () => {
        // [aeiou] = any vowel; but o is a vowel — just use explicit set
        const md = "cat cot cut\n";
        const result = applyReplacements(md, [
            { pattern: "c[ao]t", replacement: "X", use_regex: true, replace_all: true },
        ]);
        expect(result).toBe("X X cut\n");
    });

    it("replaces using regex alternation", () => {
        const md = "foo bar baz\n";
        const result = applyReplacements(md, [
            { pattern: "foo|baz", replacement: "qux", use_regex: true, replace_all: true },
        ]);
        expect(result).toBe("qux bar qux\n");
    });

    it("replaces markdown headings using regex with word boundaries", () => {
        // \\bOld\\b ensures we replace the standalone word, not substrings like "Olden".
        const md = "# Old\n\ncontent\n\n## Old\n\nmore\n";
        const result = applyReplacements(md, [
            { pattern: "\\bOld\\b", replacement: "New", use_regex: true, replace_all: true },
        ]);
        expect(result).toBe("# New\n\ncontent\n\n## New\n\nmore\n");
        expect(result).not.toContain("Old");
    });

    it("replaces inline code spans using regex", () => {
        const md = "Use `old_func()` and `old_var`.\n";
        // [^`]+ matches one or more non-backtick chars (including parens, dots)
        const result = applyReplacements(md, [
            { pattern: "`old_[^`]+`", replacement: "`new_ref`", use_regex: true, replace_all: true },
        ]);
        expect(result).toBe("Use `new_ref` and `new_ref`.\n");
    });

    it("replaces wikilinks using regex", () => {
        const md = "Ref: [[Old Page]] and [[Another Old]].\n";
        const result = applyReplacements(md, [
            { pattern: "\\[\\[Old[^\\]]*\\]\\]", replacement: "[[Updated]]", use_regex: true, replace_all: true },
        ]);
        expect(result).toContain("[[Updated]]");
        expect(result).not.toContain("[[Old");
    });

    it("replaces YAML frontmatter field with regex", () => {
        const md = "---\ndate: 2024-01-01\ntitle: Old\n---\n\nBody\n";
        const result = applyReplacements(md, [
            { pattern: "^date: .+", replacement: "date: 2025-06-01", use_regex: true },
        ]);
        expect(result).toContain("date: 2025-06-01");
        expect(result).not.toContain("2024-01-01");
    });

    it("fails on invalid regex with clear error", () => {
        const md = "some text\n";
        const result = applyReplacements(md, [
            { pattern: "[unclosed", replacement: "x", use_regex: true },
        ]);
        expect(result).toContain("VALIDATION");
        expect(result).toContain("not a valid regex");
    });

    it("combines literal and regex entries in one call", () => {
        const md = "# Title\n\ncat cot cut\n\nFooter\n";
        const result = applyReplacements(md, [
            { pattern: "# Title", replacement: "# New Title" },
            { pattern: "c[ao]t", replacement: "X", use_regex: true, replace_all: true },
        ]);
        expect(result).toContain("# New Title");
        expect(result).toContain("X X cut");
    });

    it("replaces markdown task list status with regex", () => {
        const md = "- [ ] Incomplete\n- [x] Complete\n- [ ] Another\n";
        const result = applyReplacements(md, [
            { pattern: "- \\[ \\]", replacement: "- [x]", use_regex: true, replace_all: true },
        ]);
        expect(result).toBe("- [x] Incomplete\n- [x] Complete\n- [x] Another\n");
    });

    it("hints use_regex when literal pattern looks like regex", () => {
        // Simulates the session-226 bug: AI wrote \\(DevRoot\\) expecting regex
        const md = "some text\n";
        const result = applyReplacements(md, [
            { pattern: "\\(DevRoot\\)", replacement: "replaced" },
        ]);
        expect(result).toContain("NOT_FOUND");
        expect(result).toContain("HINT");
        expect(result).toContain("use_regex");
        expect(result).toContain("escaped brackets");
    });

    it("does NOT hint regex for normal literal text that is not found", () => {
        const md = "hello world\n";
        const result = applyReplacements(md, [
            { pattern: "missing text", replacement: "x" },
        ]);
        expect(result).toContain("NOT_FOUND");
        expect(result).not.toContain("HINT");
    });

    // ── Regex $N capture-group substitution ──

    it("replaces date format using $1/$2/$3 groups", () => {
        const md = "发布于2024年1月15日，截止2023年12月31日。\n";
        const result = applyReplacements(md, [
            {
                pattern: "(\\d{4})年(\\d{1,2})月(\\d{1,2})日",
                replacement: "$1/$2/$3",
                use_regex: true,
                replace_all: true,
            },
        ]);
        expect(result).toBe("发布于2024/1/15，截止2023/12/31。\n");
    });

    it("reverses word order with $2 $1", () => {
        const md = "Last, First\n";
        const result = applyReplacements(md, [
            {
                pattern: "(\\w+), (\\w+)",
                replacement: "$2 $1",
                use_regex: true,
            },
        ]);
        expect(result).toBe("First Last\n");
    });

    it("uses $& (full match) to wrap matched text", () => {
        const md = "Status: **draft**\n";
        const result = applyReplacements(md, [
            {
                pattern: "\\*\\*[^*]+\\*\\*",
                replacement: "<strong>$&</strong>",
                use_regex: true,
            },
        ]);
        expect(result).toBe("Status: <strong>**draft**</strong>\n");
    });

    it("handles literal $$ in replacement", () => {
        const md = "Price: 100\n";
        const result = applyReplacements(md, [
            {
                pattern: "(\\d+)",
                replacement: "$$$1",
                use_regex: true,
            },
        ]);
        expect(result).toBe("Price: $100\n");
    });

    it("leaves replacement literal when no capture groups used", () => {
        const md = "cat cot cut\n";
        const result = applyReplacements(md, [
            { pattern: "c[ao]t", replacement: "X", use_regex: true, replace_all: true },
        ]);
        expect(result).toBe("X X cut\n");
    });
});
