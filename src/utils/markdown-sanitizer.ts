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

// ── Mermaid block detection ────────────────────────────────────────────────

/**
 * Check whether the content ends inside an unclosed mermaid fenced code block.
 * Only counts ```mermaid openers; other language fences are ignored.
 */
function isInsideMermaidBlock(content: string): boolean {
    const lines = content.split('\n');
    let insideMermaid = false;
    for (const line of lines) {
        const trimmed = line.trimStart();
        // Match ```mermaid and ``` mermaid (CommonMark allows space after fence)
        if (/^```\s*mermaid/.test(trimmed)) {
            insideMermaid = true;
        } else if (insideMermaid && /^```\s*$/.test(trimmed)) {
            insideMermaid = false;
        }
    }
    return insideMermaid;
}

// ── P1: Trailing mermaid block deferral ────────────────────────────────────

/**
 * Defer trailing mermaid code blocks to prevent syntax-error flicker
 * during streaming.
 *
 * While a mermaid block is still receiving content (the closing ``` has not
 * arrived yet), Obsidian's Mermaid renderer sees incomplete syntax and
 * displays a transient error.  We defer the **entire** mermaid block —
 * from the ```mermaid opener to the end of content — until the closing
 * ``` is received.  At that point the block is no longer unclosed and
 * will be rendered in one piece with valid syntax.
 *
 * Unlike the general {@link closeFencedCodeBlock} sanitizer (which appends
 * a closing fence to any open code block), this function *strips* the
 * pending mermaid block entirely.  Appending a closing fence would trigger
 * the Mermaid renderer on partial syntax, causing the exact flash of
 * error messages we want to avoid.
 *
 * Must run BEFORE {@link closeFencedCodeBlock} in the pipeline — once the
 * mermaid block is stripped, {@link closeFencedCodeBlock} no longer sees
 * an open fence and will not append its own closing ```.
 */
function deferTrailingMermaidBlock(content: string): string {
    if (!isInsideMermaidBlock(content)) return content;

    // Find the last unclosed ```mermaid opener and strip from there
    const lines = content.split('\n');
    let insideMermaid = false;
    let mermaidStartIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trimStart();
        if (/^```\s*mermaid/.test(trimmed)) {
            insideMermaid = true;
            mermaidStartIdx = i;
        } else if (insideMermaid && /^```\s*$/.test(trimmed)) {
            insideMermaid = false;
            mermaidStartIdx = -1;
        }
    }

    if (insideMermaid && mermaidStartIdx >= 0) {
        // Strip everything from the opening ```mermaid to end
        return lines.slice(0, mermaidStartIdx).join('\n');
    }

    return content;
}

// ── Dataview block detection ───────────────────────────────────────────────

/**
 * Check whether the content ends inside an unclosed dataview fenced code block.
 * Only counts ```dataview openers; other language fences are ignored.
 */
function isInsideDataviewBlock(content: string): boolean {
    const lines = content.split('\n');
    let insideDataview = false;
    for (const line of lines) {
        const trimmed = line.trimStart();
        // Match ```dataview and ``` dataview (CommonMark allows space after fence)
        if (/^```\s*dataview/.test(trimmed)) {
            insideDataview = true;
        } else if (insideDataview && /^```\s*$/.test(trimmed)) {
            insideDataview = false;
        }
    }
    return insideDataview;
}

// ── P1: Trailing dataview block deferral ───────────────────────────────────

/**
 * Defer trailing dataview code blocks to prevent rendering incomplete queries
 * during streaming.
 *
 * Dataview code blocks are executed by Obsidian's Dataview plugin. During
 * streaming, an incomplete dataview query would be evaluated — potentially
 * producing empty results, error messages, or unexpected output that then
 * gets replaced as more content arrives, causing visual flicker.
 *
 * The same strategy as mermaid blocks: strip the entire unclosed dataview
 * block from the ```dataview opener to the end of content until the closing
 * ``` arrives, at which point the block is rendered in one piece.
 *
 * Must run BEFORE {@link closeFencedCodeBlock} in the pipeline — once the
 * dataview block is stripped, {@link closeFencedCodeBlock} no longer sees
 * an open fence and will not append its own closing ```.
 */
function deferTrailingDataviewBlock(content: string): string {
    if (!isInsideDataviewBlock(content)) return content;

    // Find the last unclosed ```dataview opener and strip from there
    const lines = content.split('\n');
    let insideDataview = false;
    let dataviewStartIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trimStart();
        if (/^```\s*dataview/.test(trimmed)) {
            insideDataview = true;
            dataviewStartIdx = i;
        } else if (insideDataview && /^```\s*$/.test(trimmed)) {
            insideDataview = false;
            dataviewStartIdx = -1;
        }
    }

    if (insideDataview && dataviewStartIdx >= 0) {
        // Strip everything from the opening ```dataview to end
        return lines.slice(0, dataviewStartIdx).join('\n');
    }

    return content;
}

// ── P0: Fenced code block ────────────────────────────────────────────────────

/**
 * If the content has an unclosed fenced code block, append a closing fence.
 *
 * Note: mermaid fenced code blocks are handled separately by
 * {@link deferTrailingMermaidBlock} which runs earlier in the pipeline.
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

// ── Shared table detection helpers ────────────────────────────────────────────

/**
 * Check whether a line looks like a table row (starts and ends with `|`).
 * Uses full trim() to handle indented table rows (e.g. `  | Col |`).
 */
function isTableRow(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith('|') && trimmed.endsWith('|');
}

/**
 * Check whether a line is a table separator row (`| --- | --- |` pattern,
 * with optional alignment colons).
 */
function isTableSep(line: string): boolean {
    const trimmed = line.trim();
    return /^\|[\s:]*-{3,}[\s:]*(\|[\s:]*-{3,}[\s:]*)*\|$/.test(trimmed);
}

// ── P1: Trailing table deferral ──────────────────────────────────────────────

/**
 * Defer trailing table content to prevent layout jumps during streaming.
 *
 * During streaming, a table that is still receiving new rows causes the
 * Markdown renderer to rebuild the entire `<table>` DOM on every row,
 * triggering column-width recalculations and layout jumps.  We defer the
 * **entire** table block — including header, separator, and all data rows —
 * until the table is no longer at the end of content (i.e. a non-table,
 * non-blank line appears after it, or the stream ends).
 *
 * Handles four cases:
 * 1. Last line is an incomplete table row (starts with `|` but doesn't
 *    end with `|`) — truncate that line.
 * 2. Table has only a header row (no separator yet) — defer the entire
 *    pending table block, because without the separator the renderer treats
 *    it as plain text (then suddenly re-renders as a table once the
 *    separator appears → big layout jump).
 * 3. Table has header + something, but the second line is NOT a valid
 *    separator row — same as case 2.
 * 4. Table has header + separator (+ data rows) but the table block
 *    extends to the end of content — defer the entire table block to avoid
 *    incremental DOM rebuilds.  The table is only rendered when it is
 *    complete (followed by non-table content or the stream ends).
 *
 * Skipped when inside a fenced code block.
 *
 * NOTE: The inline table-row checks below use trimEnd() semantics rather
 * than isTableRow() because during streaming, leading whitespace on a
 * table line is more likely to be a formatting artifact than an intentional
 * indented table — deferring would strip it unnecessarily.
 */
function deferTrailingTable(content: string): string {
    if (isInsideFencedCodeBlock(content)) return content;

    // Strip trailing newlines so that the "last line" detection works
    // correctly on streaming content where each row ends with \n.
    // The trailing newlines are re-appended to the result so callers
    // don't see a different number of blank lines.
    const trailingNewlines = (content.match(/\n+$/) ?? [''])[0];
    const work = trailingNewlines
        ? content.slice(0, -trailingNewlines.length)
        : content;

    if (!work) return content; // all trailing newlines — nothing to defer

    const lastNewline = work.lastIndexOf('\n');
    if (lastNewline === -1) return content;

    const lastLine = work.slice(lastNewline + 1).trimEnd();

    // Case 1: last line is an incomplete table row — truncate it and
    // recurse so any trailing table exposed by truncation is also deferred.
    if (lastLine.startsWith('|') && !lastLine.endsWith('|')) {
        return deferTrailingTable(
            work.slice(0, lastNewline) + trailingNewlines,
        );
    }

    // If the last line is not a table row at all, nothing to do
    if (!lastLine.startsWith('|')) return content;

    // The last line is a complete table row.  Walk backwards to find the
    // start of the table block and check whether it has a separator row.
    const lines = work.split('\n');
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
        return lines.slice(0, tableStartIdx).join('\n') + trailingNewlines;
    }

    // Case 3: table has header + something, but the second line is NOT a
    // valid separator row — the table is structurally incomplete, defer it.
    if (!isTableSep(tableLines[1]!)) {
        return lines.slice(0, tableStartIdx).join('\n') + trailingNewlines;
    }

    // Case 4: table has header + separator (+ possibly data rows).
    // If the table block extends to the end of content, it is still
    // receiving new rows — defer the entire block to avoid incremental
    // DOM rebuilds that cause column-width recalculations and layout jumps.
    // The table will be rendered when a non-table line appears after it,
    // or when the stream ends (finalize renders the raw, un-sanitized content).
    if (tableStartIdx + tableLines.length === lines.length) {
        return lines.slice(0, tableStartIdx).join('\n') + trailingNewlines;
    }

    // Table has ended (followed by non-table content) — keep it.
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

    // P1: Mermaid block (must be before closeFencedCodeBlock — a trailing
    // unclosed mermaid block should be stripped, not closed with ```)
    result = deferTrailingMermaidBlock(result);

    // P1: Dataview block (same strategy as mermaid — defer unclosed dataview
    // blocks to prevent rendering incomplete queries during streaming)
    result = deferTrailingDataviewBlock(result);

    // P0: Fenced code block (must be first — affects all subsequent checks)
    result = closeFencedCodeBlock(result);

    // P0: Inline code
    result = closeInlineCode(result);

    // P1: Bold / Italic
    result = closeBoldItalic(result);

    // P1: Incomplete table (truncation — defers incomplete rows and
    // structurally incomplete tables that lack a separator row)
    result = deferTrailingTable(result);

    // P1: Math block
    result = closeMathBlock(result);

    // P2: Incomplete link / image (truncation)
    result = truncateIncompleteLink(result);

    return result;
}

// ── Final normalizer: blank lines around tables ────────────────────────────

/**
 * Normalize markdown content so that Obsidian's renderer handles it correctly.
 *
 * Currently handles one common issue:
 * - **Tables without surrounding blank lines**: Obsidian's Markdown renderer
 *   may fail to recognize a table if it is not separated from adjacent content
 *   by blank lines.  This function inserts a missing blank line before and
 *   after every table block when one is absent.
 *
 * Existing blank lines (including multiple consecutive ones) are preserved —
 * only missing separators are added.
 *
 * Tables inside fenced code blocks are intentionally left unchanged — backtick
 * content is literal and must not be altered.
 *
 * @param content - Raw markdown (typically the final, complete AI response)
 * @returns Normalized markdown suitable for Obsidian rendering
 */
export function normalizeMarkdownForObsidian(content: string): string {
    if (!content) return content;

    const lines = content.split('\n');
    const result: string[] = [];
    let insideCodeBlock = false;
    let i = 0;

    while (i < lines.length) {
        const trimmedStart = lines[i]!.trimStart();

        // Track fenced code block boundaries in a single pass so we never
        // re-scan for each table (avoids O(n²) for multi-table documents).
        if (/^(`{3,}|~{3,})/.test(trimmedStart)) {
            insideCodeBlock = !insideCodeBlock;
            result.push(lines[i]!);
            i++;
            continue;
        }

        // Detect a table block: current line is a table row AND the next
        // line is a separator row.  Skip if inside a fenced code block.
        if (
            !insideCodeBlock &&
            i + 1 < lines.length &&
            isTableRow(lines[i]!) &&
            isTableSep(lines[i + 1]!)
        ) {
            const tableStart = i;
            i += 2; // skip header + separator
            while (i < lines.length && isTableRow(lines[i]!)) {
                // If this line is followed by a separator row, it is the
                // header of a *new* table — stop here so the next iteration
                // picks it up.
                if (i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
                    break;
                }
                i++;
            }
            const tableEnd = i;

            // ── Ensure blank line BEFORE the table ──
            // Only insert a blank line when there isn't one already.
            if (
                result.length > 0 &&
                result[result.length - 1]!.trim() !== ''
            ) {
                result.push('');
            }

            // ── Add table lines ──
            for (let j = tableStart; j < tableEnd; j++) {
                result.push(lines[j]!);
            }

            // ── Ensure blank line AFTER the table ──
            // Only insert a blank line when the next content line isn't
            // already blank (preserving any existing blank lines).
            if (i < lines.length && lines[i]!.trim() !== '') {
                result.push('');
            }
        } else {
            result.push(lines[i]!);
            i++;
        }
    }

    return result.join('\n');
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
    result = result.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m: string, path: string, alias?: string) => alias || path);

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
