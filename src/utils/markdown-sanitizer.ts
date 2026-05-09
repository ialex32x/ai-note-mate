/**
 * Markdown sanitizer for streaming content.
 *
 * During streaming, partial markdown may contain unclosed syntax elements
 * (e.g. fenced code blocks, inline code, bold/italic markers, math blocks).
 * This module provides a lightweight, append-only sanitizer that temporarily
 * closes such elements so the markdown renderer produces correct output.
 *
 * The sanitizer NEVER modifies the original content — it only appends
 * closing markers at the end.  The final render (when streaming completes)
 * should use the raw, un-sanitized content.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 */
function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        count++;
        pos += needle.length;
    }
    return count;
}

/**
 * Check whether the given position is inside a fenced code block.
 * A fenced code block is opened/closed by a line starting with ``` (possibly indented up to 3 spaces).
 */
function isInsideFencedCodeBlock(content: string): boolean {
    const lines = content.split('\n');
    let insideCodeBlock = false;
    for (const line of lines) {
        const trimmed = line.trimStart();
        // A fence line starts with at least 3 backticks or 3 tildes
        if (/^(`{3,}|~{3,})/.test(trimmed)) {
            insideCodeBlock = !insideCodeBlock;
        }
    }
    return insideCodeBlock;
}

// ── P0: Fenced code block ────────────────────────────────────────────────────

/**
 * If the content has an unclosed fenced code block, append a closing fence.
 */
function closeFencedCodeBlock(content: string): string {
    if (isInsideFencedCodeBlock(content)) {
        // Only prepend \n if content doesn't already end with one;
        // never append a trailing \n — it creates an extra empty paragraph.
        return content + (content.endsWith('\n') ? '```' : '\n```');
    }
    return content;
}

// ── P0: Inline code ──────────────────────────────────────────────────────────

/**
 * If the last line has an odd number of single backticks (excluding fenced
 * code markers), append a closing backtick.
 *
 * This only operates on the last line because inline code cannot span lines.
 * Also skips processing if we are inside a fenced code block (the backticks
 * there are literal content, not inline code markers).
 */
function closeInlineCode(content: string): string {
    // If inside a fenced code block, inline backticks are literal — skip
    if (isInsideFencedCodeBlock(content)) return content;

    const lastNewline = content.lastIndexOf('\n');
    const lastLine = lastNewline === -1 ? content : content.slice(lastNewline + 1);

    // Remove triple-backtick sequences so they don't interfere with counting
    const cleaned = lastLine.replace(/```/g, '');
    const backtickCount = countOccurrences(cleaned, '`');

    if (backtickCount % 2 !== 0) {
        return content + '`';
    }
    return content;
}

// ── P1: Bold / Italic ────────────────────────────────────────────────────────

/**
 * Close unclosed bold (`**`) and italic (`*`) markers in the last paragraph.
 *
 * Strategy: scan the last paragraph (text after the last blank line) for
 * `***`, `**`, and `*` markers that are not paired.  Append the necessary
 * closing markers.
 *
 * Skipped when inside a fenced code block.
 */
function closeBoldItalic(content: string): string {
    if (isInsideFencedCodeBlock(content)) return content;

    // Work on the last paragraph only (after the last blank line)
    const lastBlankLine = content.lastIndexOf('\n\n');
    const paragraph = lastBlankLine === -1 ? content : content.slice(lastBlankLine + 2);

    // Remove inline code spans so their contents don't interfere
    const noInlineCode = paragraph.replace(/`[^`]*`/g, '');

    // Count markers — process longest first to avoid double-counting
    let text = noInlineCode;
    let boldItalicCount = 0;
    let boldCount = 0;
    let italicCount = 0;

    // Count *** (bold-italic)
    const tripleMatches = text.match(/\*{3}/g);
    boldItalicCount = tripleMatches ? tripleMatches.length : 0;
    text = text.replace(/\*{3}/g, '');

    // Count ** (bold)
    const doubleMatches = text.match(/\*{2}/g);
    boldCount = doubleMatches ? doubleMatches.length : 0;
    text = text.replace(/\*{2}/g, '');

    // Count * (italic) — only standalone asterisks
    const singleMatches = text.match(/\*/g);
    italicCount = singleMatches ? singleMatches.length : 0;

    let suffix = '';

    // Odd *** means one unclosed bold-italic
    if (boldItalicCount % 2 !== 0) {
        suffix += '***';
    }
    // Odd ** means one unclosed bold
    if (boldCount % 2 !== 0) {
        suffix += '**';
    }
    // Odd * means one unclosed italic
    if (italicCount % 2 !== 0) {
        suffix += '*';
    }

    return suffix ? content + suffix : content;
}

// ── P1: Incomplete table ─────────────────────────────────────────────────────

/** A complete table row starts and ends with `|`. */
function isCompleteTableRow(line: string): boolean {
    const trimmed = line.trimEnd();
    return trimmed.startsWith('|') && trimmed.endsWith('|');
}

/** A table separator row matches `| --- | --- | ...` pattern. */
function isTableSeparatorRow(line: string): boolean {
    const trimmed = line.trim();
    return /^\|[\s:]*-{3,}[\s:]*(\|[\s:]*-{3,}[\s:]*)*\|$/.test(trimmed);
}

/**
 * Defer incomplete table content to prevent layout jumps during streaming.
 *
 * Handles three cases:
 * 1. The last line is an incomplete table row (starts with `|` but doesn't
 *    end with `|`) — truncate that line.
 * 2. The table has a header row but the separator row hasn't arrived yet —
 *    truncate the entire pending table block, because without the separator
 *    the renderer treats it as plain text (then suddenly re-renders as a
 *    table once the separator appears → big layout jump).
 * 3. The table has header + separator but the first data row is incomplete —
 *    same truncation as case 1.
 *
 * Skipped when inside a fenced code block.
 */
function truncateIncompleteTable(content: string): string {
    if (isInsideFencedCodeBlock(content)) return content;

    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline === -1) return content;

    const lastLine = content.slice(lastNewline + 1).trimEnd();

    // Case 1: last line is an incomplete table row — truncate it
    if (lastLine.startsWith('|') && !lastLine.endsWith('|')) {
        return content.slice(0, lastNewline);
    }

    // If the last line is not a table row at all, nothing to do
    if (!lastLine.startsWith('|')) return content;

    // The last line is a complete table row.  Walk backwards to find the
    // start of the table block and check whether it has a separator row.
    const lines = content.split('\n');
    let tableStartIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i]!.trimEnd();
        if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
            tableStartIdx = i;
        } else {
            break;
        }
    }

    if (tableStartIdx < 0) return content;

    const tableLines = lines.slice(tableStartIdx);

    // Case 2: table has only a header row (no separator yet) — defer the
    // entire table block.
    if (tableLines.length < 2) {
        // Only the header row exists; truncate it
        return lines.slice(0, tableStartIdx).join('\n');
    }

    // Case 3: table has header + something, but the second line is NOT a
    // valid separator row — the table is structurally incomplete, defer it.
    if (!isTableSeparatorRow(tableLines[1]!)) {
        return lines.slice(0, tableStartIdx).join('\n');
    }

    // Table has header + separator (+ possibly data rows).  It's valid.
    return content;
}

// ── P1: Math block ($$ ... $$) ───────────────────────────────────────────────

/**
 * If there is an unclosed display math block (`$$`), append a closing `$$`.
 *
 * Only counts `$$` that appear at the start of a line (standard convention).
 * Skipped when inside a fenced code block.
 */
function closeMathBlock(content: string): string {
    if (isInsideFencedCodeBlock(content)) return content;

    // Count $$ that appear as standalone tokens (not part of longer $ sequences)
    // We look for $$ on their own line or surrounded by non-$ characters
    const matches = content.match(/(?:^|\n)\s*\$\$/g);
    const count = matches ? matches.length : 0;

    if (count % 2 !== 0) {
        // Only prepend \n if content doesn't already end with one;
        // never append a trailing \n — it creates an extra empty paragraph.
        return content + (content.endsWith('\n') ? '$$' : '\n$$');
    }
    return content;
}

// ── P2: Incomplete link / image syntax ───────────────────────────────────────

/**
 * If the last line contains an incomplete link or image syntax, truncate
 * to the last complete line.
 *
 * Detects patterns like:
 * - `[text` (no closing `]`)
 * - `[text](url` (no closing `)`)
 * - `![alt](url` (no closing `)`)
 *
 * Skipped when inside a fenced code block.
 */
function truncateIncompleteLink(content: string): string {
    if (isInsideFencedCodeBlock(content)) return content;

    const lastNewline = content.lastIndexOf('\n');
    if (lastNewline === -1) return content;

    const lastLine = content.slice(lastNewline + 1);

    // Check for unclosed [ without matching ](...) on the same line
    // Simple heuristic: if there's an unmatched [ or an unmatched (
    const openBrackets = countOccurrences(lastLine, '[');
    const closeBrackets = countOccurrences(lastLine, ']');

    if (openBrackets > closeBrackets) {
        return content.slice(0, lastNewline);
    }

    // Check for ]( without closing )
    const linkOpenCount = countOccurrences(lastLine, '](');
    const parenCloseCount = countOccurrences(lastLine, ')');
    if (linkOpenCount > 0 && linkOpenCount > parenCloseCount) {
        return content.slice(0, lastNewline);
    }

    return content;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Sanitize streaming markdown content by closing unclosed syntax elements.
 * This is a lightweight, append-only operation that does not modify the
 * original content (except for truncation of incomplete table rows and links).
 *
 * @param content - The raw streaming markdown content
 * @returns The sanitized content with unclosed elements temporarily closed
 */
export function sanitizeStreamingMarkdown(content: string): string {
    if (!content) return content;

    let result = content;

    // P0: Fenced code block (must be first — affects all subsequent checks)
    result = closeFencedCodeBlock(result);

    // P0: Inline code
    result = closeInlineCode(result);

    // P1: Bold / Italic
    result = closeBoldItalic(result);

    // P1: Incomplete table (truncation — defers incomplete rows and
    // structurally incomplete tables that lack a separator row)
    result = truncateIncompleteTable(result);

    // P1: Math block
    result = closeMathBlock(result);

    // P2: Incomplete link / image (truncation)
    result = truncateIncompleteLink(result);

    return result;
}

/**
 * Strip common markdown syntax and HTML markup from a short piece of text
 * and return a plain-text version suitable for single-line display such as
 * a session title, notification, or tooltip.
 *
 * This is intentionally conservative: it only removes formatting markers
 * while keeping the underlying textual content. For example:
 *   `**hello**`        -> `hello`
 *   `` `code` ``       -> `code`
 *   `[text](url)`      -> `text`
 *   `![alt](url)`      -> `alt`
 *   `## Heading`       -> `Heading`
 *   `> quoted`         -> `quoted`
 *   `- item`           -> `item`
 *   `"wrapped"`        -> `wrapped`
 *
 * It is NOT a general-purpose markdown-to-text converter — code blocks and
 * tables are collapsed rather than preserved, because this helper targets
 * short, single-line outputs.
 *
 * @param text - Raw text that may contain markdown / HTML formatting
 * @returns A plain-text version with formatting markers removed
 */
export function stripMarkdownToPlainText(text: string): string {
    if (!text) return '';

    let result = text;

    // Remove HTML comments (e.g. <!-- ... -->)
    result = result.replace(/<!--[\s\S]*?-->/g, '');
    // Remove HTML tags
    result = result.replace(/<[^>]+>/g, '');

    // Collapse fenced code blocks — keep their inner text, drop the fences
    result = result.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');

    // Images: keep alt text
    result = result.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    // Links: keep link text
    result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    // Reference-style links: [text][ref] -> text
    result = result.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
    // Obsidian wiki-links: [[path|alias]] or [[path]]
    result = result.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, path, alias) => alias || path);

    // Inline code: `code`
    result = result.replace(/`+([^`]+)`+/g, '$1');

    // Bold / italic markers — order matters (longest first)
    result = result.replace(/\*{3}([^*]+)\*{3}/g, '$1');
    result = result.replace(/_{3}([^_]+)_{3}/g, '$1');
    result = result.replace(/\*{2}([^*]+)\*{2}/g, '$1');
    result = result.replace(/_{2}([^_]+)_{2}/g, '$1');
    result = result.replace(/(?<![\w*])\*([^*\n]+)\*(?!\w)/g, '$1');
    result = result.replace(/(?<![\w_])_([^_\n]+)_(?!\w)/g, '$1');
    // Strikethrough
    result = result.replace(/~~([^~]+)~~/g, '$1');

    // Heading markers at line start: "### Title" -> "Title"
    result = result.replace(/^\s{0,3}#{1,6}\s+/gm, '');
    // Blockquote markers
    result = result.replace(/^\s{0,3}>\s?/gm, '');
    // Unordered list markers
    result = result.replace(/^\s{0,3}[-*+]\s+/gm, '');
    // Ordered list markers
    result = result.replace(/^\s{0,3}\d+\.\s+/gm, '');
    // Horizontal rules on their own line
    result = result.replace(/^\s{0,3}[-*_]{3,}\s*$/gm, '');

    // LaTeX math delimiters — keep inner text
    result = result.replace(/\$\$([\s\S]*?)\$\$/g, '$1');
    result = result.replace(/\$([^$\n]+)\$/g, '$1');

    // Collapse any remaining table pipes to spaces
    result = result.replace(/\|/g, ' ');

    // Whitespace normalization: newlines -> space, collapse spaces
    result = result.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // Strip a matching pair of wrapping quotes (straight or CJK) if the
    // whole string is quoted as a unit. Apply at most once per quote style.
    const quotePairs: Array<[string, string]> = [
        ['"', '"'],
        ["'", "'"],
        ['`', '`'],
        ['“', '”'],
        ['‘', '’'],
        ['「', '」'],
        ['『', '』'],
        ['《', '》'],
    ];
    for (const [open, close] of quotePairs) {
        if (result.length >= 2 && result.startsWith(open) && result.endsWith(close)) {
            result = result.slice(open.length, result.length - close.length).trim();
            break;
        }
    }

    return result;
}
