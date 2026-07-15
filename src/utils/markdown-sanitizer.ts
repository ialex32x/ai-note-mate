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

// ── P1: Deferred-language block deferral ───────────────────────────────────

/**
 * Languages whose **trailing unclosed** fenced code blocks should be stripped
 * during streaming.
 *
 * These are languages where showing an incomplete block would cause the
 * associated renderer to produce errors or flicker:
 *
 * - **mermaid**: An incomplete mermaid diagram triggers render errors.
 *   Complete mermaid blocks are kept so they can be rendered immediately when
 *   the closing fence arrives; the streaming controller handles SVG caching
 *   to prevent per-tick flicker.
 *
 * To add a new language with this behavior, add its name here.
 */
const TRAILING_DEFER_LANGUAGES: readonly string[] = ['mermaid'];

/**
 * Languages whose **all** fenced code blocks (complete or not) should be
 * stripped during streaming.
 *
 * These are languages where even a complete block must not be evaluated
 * mid-stream because the content may change and the side-effects of
 * evaluation are visible (e.g. query results, empty tables):
 *
 * - **dataview / dataviewjs**: Incomplete or changing queries are evaluated
 *   by the Dataview plugin, producing empty results or error messages that
 *   flicker as more content arrives.
 *
 * To add a new language with this behavior, add its name here.
 */
const FULL_DEFER_LANGUAGES: readonly string[] = ['dataview'];

/**
 * Strip a trailing **unclosed** fenced code block for the given language.
 *
 * While the block is still receiving content (the closing ``` has not
 * arrived yet), the entire block — from the ```<language> opener to the
 * end of content — is stripped.  Once the closing ``` is received the
 * block is left intact so it can be rendered immediately.
 *
 * Unlike {@link closeFencedCodeBlock} (which appends a closing fence),
 * this function *strips* the pending block entirely because appending a
 * closing fence would trigger the associated plugin on incomplete content.
 *
 * Must run BEFORE {@link closeFencedCodeBlock} — once the block is
 * stripped, {@link closeFencedCodeBlock} no longer sees an open fence
 * and will not append its own closing ```.
 */
function deferTrailingLanguageBlock(content: string, language: string): string {
    const openerRe = new RegExp(`^\`\`\`\\s*${language}`);
    const lines = content.split('\n');
    let inside = false;
    let startIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trimStart();
        if (openerRe.test(trimmed)) {
            inside = true;
            startIdx = i;
        } else if (inside && /^```\s*$/.test(trimmed)) {
            inside = false;
            startIdx = -1;
        }
    }

    if (inside && startIdx >= 0) {
        return lines.slice(0, startIdx).join('\n');
    }

    return content;
}

/**
 * Strip ALL fenced code blocks for the given language from `content`.
 *
 * Both complete blocks (opening + closing fence present) and trailing
 * unclosed blocks are removed.  Used for languages like dataview where
 * even a complete block must not be evaluated mid-stream because the
 * query content may still change.
 *
 * Must run BEFORE {@link closeFencedCodeBlock} — once the blocks are
 * stripped, {@link closeFencedCodeBlock} no longer sees an open fence
 * and will not append its own closing ```.
 */
function deferAllLanguageBlocks(content: string, language: string): string {
    const openerRe = new RegExp(`^\`\`\`\\s*${language}`, 'i');
    const lines = content.split('\n');
    const result: string[] = [];
    let inside = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trimStart();
        if (!inside && openerRe.test(trimmed)) {
            inside = true;
            // Remove a trailing blank line that was already pushed so the
            // block does not leave an orphan blank line after stripping.
            if (result.length > 0 && result[result.length - 1]!.trim() === '') {
                result.pop();
            }
        } else if (inside && /^```\s*$/.test(trimmed)) {
            // Closing fence — block is complete, discard it and exit.
            inside = false;
        }
        // While inside a block, skip every line (strip the block).
        // Outside a block, keep every line.
        if (!inside) {
            result.push(lines[i]!);
        }
    }

    return result.join('\n');
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

    // P1a: Strip trailing unclosed blocks for languages where showing an
    // incomplete block causes render errors (e.g. mermaid syntax errors).
    // Complete blocks are kept — the streaming controller handles SVG caching.
    // Must run before closeFencedCodeBlock so stripped blocks don't get a
    // spurious closing fence appended.
    for (const language of TRAILING_DEFER_LANGUAGES) {
        result = deferTrailingLanguageBlock(result, language);
    }

    // P1b: Strip ALL blocks (complete or not) for languages where even a
    // complete block must not be evaluated mid-stream (e.g. dataview queries).
    for (const language of FULL_DEFER_LANGUAGES) {
        result = deferAllLanguageBlocks(result, language);
    }

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

// ── Mermaid source extraction & SVG substitution ─────────────────────────

/**
 * Extract the source code of every closed ```mermaid fenced code block
 * from raw (un-sanitized) markdown.
 *
 * Only returns sources for blocks that have a matching closing fence —
 * unclosed blocks are silently skipped.  This is safe to call on streaming
 * content; it will return an empty array until the closing ``` arrives.
 *
 * @param markdown - Raw markdown content (NOT sanitized streaming output)
 * @returns Array of mermaid source strings, one per closed block, in
 *   document order.
 */
export function extractMermaidSources(markdown: string): string[] {
    const sources: string[] = [];
    const re = /```mermaid\s*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(markdown)) !== null) {
        sources.push(match[1]!.trim());
    }
    return sources;
}

/**
 * Compute a short, stable key for a mermaid source string.
 *
 * Used to tag pre-rendered-diagram placeholders (`data-mermaid-key`) so the
 * streaming controller can match a placeholder in the freshly-rendered DOM
 * back to its cached SVG node.  A djb2 hash rendered in base36, prefixed with
 * `m` so it is always a valid attribute value / CSS-safe token.
 */
export function mermaidSourceKey(source: string): string {
    let h = 5381;
    for (let i = 0; i < source.length; i++) {
        h = ((h << 5) + h + source.charCodeAt(i)) | 0;
    }
    return 'm' + (h >>> 0).toString(36);
}

/**
 * Replace closed ```mermaid blocks in `markdown` with an empty placeholder
 * `<div class="mermaid" data-mermaid-key="…">` for every block whose source
 * is already rendered (its key is in `cachedKeys`), and return the list of
 * sources that are NOT yet cached (i.e. still need rendering).
 *
 * The placeholder is intentionally EMPTY: the streaming controller injects the
 * cached SVG *DOM node* into it after Obsidian's MarkdownRenderer runs.  We do
 * NOT inline the SVG markup as a string, because serializing a mermaid SVG and
 * re-parsing it as HTML loses the `<foreignObject>` node labels (Obsidian's
 * HTML sanitizer strips their contents), leaving diagrams with empty shapes.
 * Cloning the live DOM node preserves the labels intact.
 *
 * `data-processed="true"` is mermaid.js's standard guard attribute — it stops
 * mermaid's DOM scanner from treating the (empty) placeholder as an unrendered
 * diagram and clearing / re-rendering it.
 *
 * Only closed blocks (opening + closing fence both present) are considered.
 * Unclosed trailing blocks have already been stripped by
 * {@link sanitizeStreamingMarkdown} before this function is called.
 *
 * @param markdown    - Sanitized streaming markdown (unclosed mermaid already stripped)
 * @param cachedKeys  - Set of {@link mermaidSourceKey} values already in the SVG cache
 * @returns `{ result, pending }` where `result` is the substituted markdown and
 *   `pending` is the array of source strings that still need to be rendered.
 */
export function substituteMermaidSvgs(
    markdown: string,
    cachedKeys: ReadonlySet<string>,
): { result: string; pending: string[] } {
    const pending: string[] = [];
    const result = markdown.replace(
        /```mermaid\s*\n([\s\S]*?)```/g,
        (_match, body: string) => {
            const source = body.trim();
            const key = mermaidSourceKey(source);
            if (cachedKeys.has(key)) {
                // Empty placeholder — the controller fills it with the cached
                // SVG DOM node after rendering.
                return `<div class="mermaid" data-mermaid-key="${key}" data-processed="true"></div>`;
            }
            pending.push(source);
            // Keep the original fence — the controller will not swap it out
            // until the SVG is ready.  On the next render tick after the
            // async pre-render resolves, the cache will have an entry and this
            // block will be substituted with a placeholder.
            return _match;
        },
    );
    return { result, pending };
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
