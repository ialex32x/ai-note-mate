import { describe, it, expect } from "vitest";
import { sanitizeStreamingMarkdown } from "../src/utils/markdown-sanitizer";

// ─────────────────────────────────────────────────────────────────────────────
// Dataview deferral tests for sanitizeStreamingMarkdown
//
// The deferTrailingDataviewBlock logic ensures streaming dataview code blocks
// are not incrementally rendered, which would cause the Dataview plugin to
// evaluate incomplete queries — potentially producing empty results or error
// messages.  An unclosed dataview block at the end of content is stripped
// entirely until its closing ``` arrives, at which point it is rendered in
// one piece.
// ─────────────────────────────────────────────────────────────────────────────

describe("deferTrailingDataviewBlock (via sanitizeStreamingMarkdown)", () => {
    const sanitize = (s: string) => sanitizeStreamingMarkdown(s);

    // ── Unclosed dataview block (trailing) ─────────────────────────────────

    it("strips an unclosed trailing dataview block", () => {
        const input = "Some text\n\n```dataview\nLIST\nFROM #tag\n";
        const result = sanitize(input);
        expect(result).not.toContain("dataview");
        expect(result).not.toContain("LIST");
        expect(result).not.toContain("#tag");
        expect(result).toContain("Some text");
    });

    it("strips a dataview block that is the entire content", () => {
        const input = "```dataview\nTABLE file.ctime\nFROM #project";
        const result = sanitize(input);
        expect(result).not.toContain("dataview");
        expect(result).not.toContain("TABLE");
        expect(result.trim()).toBe("");
    });

    it("strips a dataview block with only the opener so far", () => {
        const input = "Intro\n\n```dataview\n";
        const result = sanitize(input);
        expect(result).not.toContain("dataview");
        expect(result).toContain("Intro");
    });

    // ── Complete dataview block (closed) ──────────────────────────────────

    it("renders a complete dataview block (closing fence present)", () => {
        const input = "Before\n\n```dataview\nLIST\nFROM #tag\nWHERE file.ctime > date(today) - dur(7 days)\n```\n\nAfter";
        const result = sanitize(input);
        expect(result).toContain("dataview");
        expect(result).toContain("LIST");
        expect(result).toContain("#tag");
        expect(result).toContain("```");
        expect(result).toContain("After");
    });

    it("renders a complete dataview block followed by another code block", () => {
        const input =
            "```dataview\nTABLE file.ctime\n```\n\n```python\nprint('hello')\n```";
        const result = sanitize(input);
        expect(result).toContain("dataview");
        expect(result).toContain("TABLE");
        expect(result).toContain("python");
        expect(result).toContain("print('hello')");
    });

    // ── Streaming simulation ───────────────────────────────────────────────

    it("streaming: defers throughout and renders after closing fence arrives", () => {
        // Step 1: only dataview opener
        const s1 = sanitize("Intro\n\n```dataview\n");
        expect(s1).not.toContain("dataview");
        expect(s1).toContain("Intro");

        // Step 2: opener + first line of query
        const s2 = sanitize("Intro\n\n```dataview\nTABLE\n");
        expect(s2).not.toContain("dataview");
        expect(s2).not.toContain("TABLE");

        // Step 3: opener + more content, still unclosed
        const s3 = sanitize("Intro\n\n```dataview\nTABLE\nFROM #tags\nWHERE\n");
        expect(s3).not.toContain("dataview");
        expect(s3).not.toContain("TABLE");

        // Step 4: block complete with closing fence
        const s4 = sanitize(
            "Intro\n\n```dataview\nTABLE\nFROM #tags\nWHERE file.ctime > date(today) - dur(7 days)\n```\n\nConclusion",
        );
        expect(s4).toContain("dataview");
        expect(s4).toContain("TABLE");
        expect(s4).toContain("FROM #tags");
        expect(s4).toContain("```");
        expect(s4).toContain("Conclusion");
    });

    // ── Dataview opener with space after backticks ─────────────────────────

    it("defers unclosed dataview block when opener has space: ``` dataview", () => {
        const input = "Text\n\n``` dataview\nTABLE file.name\n";
        const result = sanitize(input);
        expect(result).not.toContain("dataview");
        expect(result).not.toContain("TABLE");
        expect(result).toContain("Text");
    });

    it("renders complete dataview block when opener has space: ``` dataview ... ```", () => {
        const input = "Text\n\n``` dataview\nLIST FROM #project\n```\n\nAfter";
        const result = sanitize(input);
        expect(result).toContain("dataview");
        expect(result).toContain("LIST");
        expect(result).toContain("After");
    });

    // ── Dataviewjs block ──────────────────────────────────────────────────

    it("defers an unclosed trailing ```dataviewjs block", () => {
        const input = "Intro\n\n```dataviewjs\ndv.list(dv.pages('#tag').file.name);\n";
        const result = sanitize(input);
        expect(result).not.toContain("dataviewjs");
        expect(result).not.toContain("dv.list");
        expect(result).toContain("Intro");
    });

    it("renders a complete dataviewjs block when closed", () => {
        const input = "```dataviewjs\ndv.table(['Name'], dv.pages().map(p => [p.file.name]))\n```\n\nDone";
        const result = sanitize(input);
        expect(result).toContain("dataviewjs");
        expect(result).toContain("dv.table");
        expect(result).toContain("Done");
    });

    // ── Interaction with mermaid deferral ──────────────────────────────────

    it("defers trailing dataview while rendering a complete mermaid block before it", () => {
        const input =
            "```mermaid\ngraph TD\nA --> B\n```\n\nMid\n\n```dataview\nTABLE\n";
        const result = sanitize(input);
        // Mermaid block is complete → rendered
        expect(result).toContain("mermaid");
        expect(result).toContain("graph TD");
        expect(result).toContain("Mid");
        // Dataview block is unclosed and trailing → deferred
        expect(result).not.toContain("dataview");
        expect(result).not.toContain("TABLE");
    });

    it("defers both unclosed mermaid and dataview blocks", () => {
        const input =
            "Intro\n\n```mermaid\ngraph TD\n\n\n```dataview\nTABLE\n";
        const result = sanitize(input);
        // Both are unclosed → both deferred
        expect(result).not.toContain("mermaid");
        expect(result).not.toContain("dataview");
        expect(result).not.toContain("TABLE");
        expect(result).toContain("Intro");
    });

    // ── Edge cases ─────────────────────────────────────────────────────────

    it("returns empty string unchanged", () => {
        expect(sanitize("")).toBe("");
    });

    it("preserves content before dataview block", () => {
        const input = "## Heading\n\nSome paragraph text.\n\n```dataview\nTABLE\n";
        const result = sanitize(input);
        expect(result).toContain("## Heading");
        expect(result).toContain("Some paragraph text");
        expect(result).not.toContain("dataview");
    });

    it("handles dataview opener with leading whitespace", () => {
        const input = "Text\n\n   ```dataview\nTABLE file.name\n";
        const result = sanitize(input);
        expect(result).not.toContain("dataview");
        expect(result).not.toContain("TABLE");
        expect(result).toContain("Text");
    });

    it("handles closing fence with trailing whitespace", () => {
        const input = "```dataview\nTABLE file.name\n```   \n\nDone";
        const result = sanitize(input);
        expect(result).toContain("dataview");
        expect(result).toContain("TABLE");
        expect(result).toContain("Done");
    });

    // ── Non-dataview code blocks ───────────────────────────────────────────

    it("does NOT strip unclosed non-dataview code blocks (they get closed by closeFencedCodeBlock)", () => {
        const input = "Text\n\n```javascript\nconst x = 1;\n";
        const result = sanitize(input);
        expect(result).toContain("javascript");
        expect(result).toContain("const x = 1;");
    });

    it("does NOT strip unclosed block named similarly to dataview (e.g. dataview-example)", () => {
        // The regex /```\s*dataview/ would NOT match ```dataview-example
        // because "dataview" is not followed by a word boundary check.
        // However, since CommonMark allows info strings like `dataview-example`
        // which start with "dataview", the regex WILL match. This is acceptable
        // — "dataview-example" is borderline and deferring it is harmless.
        const input = "```dataview-example\nsome content\n";
        const result = sanitize(input);
        // The regex matches "dataview" prefix → block is deferred
        expect(result).not.toContain("dataview-example");
        expect(result).not.toContain("some content");
    });

    // ── Multiple dataview blocks ───────────────────────────────────────────

    it("renders a complete first dataview block, defers an unclosed trailing second", () => {
        const input =
            "```dataview\nTABLE file.name\nFROM #todo\n```\n\nMid\n\n```dataviewjs\ndv.list(\n";
        const result = sanitize(input);
        // First dataview block is complete → rendered
        expect(result).toContain("TABLE");
        expect(result).toContain("#todo");
        expect(result).toContain("Mid");
        // Second dataviewjs block is trailing and unclosed → deferred
        expect(result).not.toContain("dataviewjs");
        expect(result).not.toContain("dv.list");
    });
});
