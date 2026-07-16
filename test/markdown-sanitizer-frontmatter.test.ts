import { describe, it, expect } from "vitest";
import {
    sanitizeStreamingMarkdown,
    normalizeMarkdownForObsidian,
} from "../src/utils/markdown-sanitizer";

// ─────────────────────────────────────────────────────────────────────────────
// Leading frontmatter-fence neutralization.
//
// Obsidian's MarkdownRenderer treats a `---` line at the very start of the
// content as the opening fence of YAML frontmatter. When an AI reply itself
// begins with a thematic break (`---`) and later emits another `---` line,
// Obsidian swallows everything between the two fences as (hidden) frontmatter,
// so the rendered bubble abruptly loses its entire front half once the closing
// `---` arrives.
//
// Both the streaming sanitizer and the final normalizer rewrite a leading
// `---` to the equivalent `***` horizontal rule, which renders identically but
// is never parsed as a frontmatter fence.
// ─────────────────────────────────────────────────────────────────────────────

describe("leading frontmatter-fence neutralization", () => {
    it("rewrites a leading --- to *** in the final normalizer", () => {
        const input = "---\n\n# Title\n\nBody paragraph.\n\n---\n\nTail.";
        const result = normalizeMarkdownForObsidian(input);
        expect(result.startsWith("***")).toBe(true);
        // The mid-document horizontal rule must be left untouched.
        expect(result).toContain("\n---\n");
        // Front content survives.
        expect(result).toContain("# Title");
        expect(result).toContain("Body paragraph.");
    });

    it("rewrites a leading --- to *** in the streaming sanitizer", () => {
        const input = "---\n\nSome streamed content\n\n---\n\nmore";
        const result = sanitizeStreamingMarkdown(input);
        expect(result.startsWith("***")).toBe(true);
        expect(result).toContain("Some streamed content");
    });

    it("handles a --- that is the entire content", () => {
        // Final normalizer: exact `***` thematic break.
        expect(normalizeMarkdownForObsidian("---")).toBe("***");
        // Streaming sanitizer: the leading `---` is first rewritten to `***`;
        // because it is also the last paragraph, closeBoldItalic appends a
        // closing `***` (→ `******`). Both forms render as a horizontal rule
        // and — crucially — neither is parsed as a frontmatter fence.
        expect(sanitizeStreamingMarkdown("---").startsWith("***")).toBe(true);
        expect(sanitizeStreamingMarkdown("---")).not.toContain("---");
    });

    it("does not touch --- that is not on the first line", () => {
        const input = "Intro paragraph.\n\n---\n\nAfter rule.";
        expect(normalizeMarkdownForObsidian(input)).toBe(input);
        expect(sanitizeStreamingMarkdown(input)).toBe(input);
    });

    it("does not touch a leading blank line followed by ---", () => {
        const input = "\n---\n\nBody.";
        // First line is empty, so frontmatter is not triggered — leave as-is.
        expect(normalizeMarkdownForObsidian(input)).toBe(input);
    });

    it("neutralizes a leading four-dash thematic break too", () => {
        const input = "----\n\nBody.";
        expect(normalizeMarkdownForObsidian(input).startsWith("***")).toBe(true);
    });
});
