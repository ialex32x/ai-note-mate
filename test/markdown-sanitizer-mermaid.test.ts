import { describe, it, expect } from "vitest";
import { sanitizeStreamingMarkdown } from "../src/utils/markdown-sanitizer";

// ─────────────────────────────────────────────────────────────────────────────
// Mermaid deferral tests for sanitizeStreamingMarkdown
//
// Strategy: only strip trailing *unclosed* mermaid blocks.  A complete block
// (opening + closing fence both present) is kept so the streaming controller
// can render it immediately when the closing fence arrives.  The controller's
// SVG caching layer (snapshotMermaidSvgs / restoreMermaidSvgs) is responsible
// for preventing per-tick flicker once the SVG is rendered.
// ─────────────────────────────────────────────────────────────────────────────

describe("deferTrailingMermaidBlock (via sanitizeStreamingMarkdown)", () => {
    const sanitize = (s: string) => sanitizeStreamingMarkdown(s);

    // ── Unclosed mermaid block (trailing) ──────────────────────────────────

    it("strips an unclosed trailing mermaid block", () => {
        const input = "Some text\n\n```mermaid\ngraph TD\nA --> B\n";
        const result = sanitize(input);
        expect(result).not.toContain("mermaid");
        expect(result).not.toContain("graph TD");
        expect(result).toContain("Some text");
    });

    it("strips a mermaid block that is the entire content", () => {
        const input = "```mermaid\ngraph TD\nA --> B";
        const result = sanitize(input);
        expect(result).not.toContain("mermaid");
        expect(result).not.toContain("graph TD");
        expect(result.trim()).toBe("");
    });

    it("strips a mermaid block with only the opener so far", () => {
        const input = "Intro\n\n```mermaid\n";
        const result = sanitize(input);
        expect(result).not.toContain("mermaid");
        expect(result).toContain("Intro");
    });

    // ── Complete mermaid block (closed) ────────────────────────────────────
    // A complete block is preserved so the controller can render it immediately.

    it("keeps a complete mermaid block (closing fence present)", () => {
        const input = "Before\n\n```mermaid\ngraph TD\nA --> B\n```\n\nAfter";
        const result = sanitize(input);
        expect(result).toContain("mermaid");
        expect(result).toContain("graph TD");
        expect(result).toContain("A --> B");
        expect(result).toContain("After");
    });

    it("keeps a complete mermaid block followed by another code block", () => {
        const input =
            "```mermaid\ngraph TD\nA --> B\n```\n\n```python\nprint('hello')\n```";
        const result = sanitize(input);
        expect(result).toContain("mermaid");
        expect(result).toContain("graph TD");
        expect(result).toContain("python");
        expect(result).toContain("print('hello')");
    });

    // ── Streaming simulation ───────────────────────────────────────────────

    it("streaming: strips while unclosed, then keeps once closed", () => {
        // Step 1: only mermaid opener
        const s1 = sanitize("Intro\n\n```mermaid\n");
        expect(s1).not.toContain("mermaid");
        expect(s1).toContain("Intro");

        // Step 2: mermaid opener + one line of content
        const s2 = sanitize("Intro\n\n```mermaid\ngraph TD\n");
        expect(s2).not.toContain("mermaid");
        expect(s2).not.toContain("graph TD");

        // Step 3: mermaid opener + content, still unclosed
        const s3 = sanitize("Intro\n\n```mermaid\ngraph TD\nA --> B\n");
        expect(s3).not.toContain("mermaid");
        expect(s3).not.toContain("A --> B");

        // Step 4: mermaid block complete — now kept for immediate rendering
        const s4 = sanitize(
            "Intro\n\n```mermaid\ngraph TD\nA --> B\n```\n\nConclusion",
        );
        expect(s4).toContain("mermaid");
        expect(s4).toContain("graph TD");
        expect(s4).toContain("A --> B");
        expect(s4).toContain("Conclusion");
    });

    // ── Non-mermaid code blocks ────────────────────────────────────────────

    it("does NOT strip unclosed non-mermaid code blocks (they get closed by closeFencedCodeBlock)", () => {
        const input = "Text\n\n```python\nprint('hello')\n";
        // closeFencedCodeBlock will append a closing ```, so the block
        // contents are preserved with the closing fence added.
        const result = sanitize(input);
        expect(result).toContain("python");
        expect(result).toContain("print('hello')");
    });

    it("does NOT affect a complete non-mermaid code block", () => {
        const input = "Text\n\n```typescript\nconst x = 1;\n```\n\nMore";
        const result = sanitize(input);
        expect(result).toContain("typescript");
        expect(result).toContain("const x = 1;");
        expect(result).toContain("More");
    });

    // ── Mermaid with language suffix ───────────────────────────────────────

    it("handles mermaid opener with extra text after 'mermaid'", () => {
        const input = "```mermaid\ngraph TD\nA --> B\n";
        const result = sanitize(input);
        expect(result).not.toContain("mermaid");
        expect(result).not.toContain("graph TD");
    });

    it("keeps a complete mermaid block with extra text after 'mermaid'", () => {
        const input = "```mermaid\ngraph TD\nA --> B\n```\n";
        const result = sanitize(input);
        expect(result).toContain("mermaid");
        expect(result).toContain("graph TD");
    });

    // ── Mermaid opener with space after backticks ──────────────────────────

    it("defers unclosed mermaid block when opener has space: ``` mermaid", () => {
        const input = "Text\n\n``` mermaid\ngraph TD\nA --> B\n";
        const result = sanitize(input);
        expect(result).not.toContain("mermaid");
        expect(result).not.toContain("graph TD");
        expect(result).toContain("Text");
    });

    it("keeps complete mermaid block when opener has space: ``` mermaid ... ```", () => {
        const input = "Text\n\n``` mermaid\ngraph TD\nA --> B\n```\n\nAfter";
        const result = sanitize(input);
        expect(result).toContain("mermaid");
        expect(result).toContain("graph TD");
        expect(result).toContain("After");
    });

    // ── Multiple mermaid blocks ────────────────────────────────────────────

    it("keeps a complete first mermaid block, strips an unclosed trailing second", () => {
        const input =
            "```mermaid\ngraph TD\nA --> B\n```\n\nMid\n\n```mermaid\nsequenceDiagram\n";
        const result = sanitize(input);
        // First mermaid block is complete → kept
        expect(result).toContain("graph TD");
        expect(result).toContain("A --> B");
        expect(result).toContain("Mid");
        // Second mermaid block is trailing and unclosed → stripped
        expect(result).not.toContain("sequenceDiagram");
    });

    // ── Interaction with table deferral ────────────────────────────────────

    it("defers both an unclosed mermaid block and a trailing table", () => {
        const input =
            "Intro\n\n```mermaid\ngraph TD\nA --> B\n\n\n| X | Y |\n| --- | --- |\n";
        const result = sanitize(input);
        // Mermaid block is unclosed and trailing → stripped
        expect(result).not.toContain("mermaid");
        expect(result).not.toContain("graph TD");
        // Table is trailing → deferred
        expect(result).not.toContain("| X | Y |");
        // Only Intro remains
        expect(result).toContain("Intro");
    });

    it("keeps a closed mermaid block, and renders table followed by text", () => {
        const input =
            "Intro\n\n```mermaid\ngraph TD\nA --> B\n```\n\n| X | Y |\n| --- | --- |\n\nDone";
        const result = sanitize(input);
        // Mermaid is closed → kept
        expect(result).toContain("mermaid");
        expect(result).toContain("graph TD");
        // Table is followed by "Done" → rendered
        expect(result).toContain("| X | Y |");
        expect(result).toContain("Done");
    });

    // ── Edge cases ─────────────────────────────────────────────────────────

    it("returns empty string unchanged", () => {
        expect(sanitize("")).toBe("");
    });

    it("preserves content before mermaid block", () => {
        const input = "## Heading\n\nSome paragraph text.\n\n```mermaid\ngraph TD\n";
        const result = sanitize(input);
        expect(result).toContain("## Heading");
        expect(result).toContain("Some paragraph text");
        expect(result).not.toContain("mermaid");
    });

    it("handles mermaid opener with leading whitespace", () => {
        const input = "Text\n\n   ```mermaid\ngraph TD\nA --> B\n";
        const result = sanitize(input);
        expect(result).not.toContain("mermaid");
        expect(result).not.toContain("graph TD");
        expect(result).toContain("Text");
    });

    it("handles closing fence with trailing whitespace", () => {
        const input = "```mermaid\ngraph TD\nA --> B\n```   \n\nDone";
        const result = sanitize(input);
        // Closing ``` with trailing whitespace should still close the block
        expect(result).toContain("mermaid");
        expect(result).toContain("graph TD");
        expect(result).toContain("Done");
    });
});
