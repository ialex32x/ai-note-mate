/**
 * Parse a markdown file's text into a list of memory entries.
 *
 * Each `## Section` block at level {@link MEMORY_ENTRY_LEVEL} is one
 * entry. The body spans from the line immediately after the heading up
 * to (but not including) the next `##` heading, OR EOF. Anything before
 * the first `##` heading (the file's `#` title, intro text, etc.) is
 * ignored.
 *
 * Headings nested deeper than the entry level (`###`, `####`, …) are
 * treated as part of the current entry's body — they are NOT promoted to
 * their own entry. This matches the spec: storage stays flat at `##`.
 *
 * The parser is fenced-code aware: a `## ` line inside a triple-backtick
 * fence does NOT open a new entry. This keeps memories that document
 * snippets containing literal `## …` lines intact.
 */

import { CRITICAL_HEADING_SUFFIX, MEMORY_ENTRY_LEVEL } from './constants';
import { formatFileHeading, isCriticalHeading, stripCriticalSuffix } from './heading-format';

/**
 * One memory section, as it lives in the source file.
 *
 * `startLine` / `endLine` are 1-based inclusive line numbers (matching
 * the convention used by `read_section` / `edit_lines` in the rest of
 * the codebase) so writers can splice directly without translating.
 */
export interface MemoryEntry {
    /** Logical heading, with the trailing ` [!]` marker stripped. */
    logicalHeading: string;
    /** Verbatim heading text as it appears in the file (no `##` prefix). */
    fileHeading: string;
    /** True when the file heading carries the critical suffix. */
    critical: boolean;
    /** Body text (lines after the heading, before the next `##` / EOF). */
    body: string;
    /** 1-based inclusive line number of the heading line. */
    startLine: number;
    /**
     * 1-based inclusive line number of the entry's last line (body's
     * last line, or the heading line itself when the body is empty).
     */
    endLine: number;
}

/** Parsed view of the whole memory note. */
export interface ParsedMemoryNote {
    /** All `##` entries in document order. */
    entries: MemoryEntry[];
    /** Total line count of the source content (1-based). */
    totalLines: number;
    /** Lines of the source content (zero-indexed; same indexing as `split("\n")`). */
    lines: string[];
}

const HEADING_REGEX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_REGEX = /^(\s*)(```+|~~~+)/;

/**
 * Parse the raw text of the memory note into structured entries.
 *
 * Idempotent and stateless — callers may invoke this on every access if
 * caching is undesirable. {@link MemoryStore} layers an mtime-keyed
 * cache on top for the hot path.
 */
export function parseMemoryNote(content: string): ParsedMemoryNote {
    const lines = content.split('\n');
    const entries: MemoryEntry[] = [];

    let currentStart = -1;
    let currentLevel = -1;
    let currentFileHeading = '';
    let bodyStart = -1;

    let inFence = false;
    let fenceMarker = '';

    const flush = (endLineExclusive: number) => {
        if (currentStart < 0) return;
        // bodyStart is 0-based; trim trailing blank lines from body
        const rawBody = lines.slice(bodyStart, endLineExclusive).join('\n');
        const body = trimTrailingBlankLines(rawBody);
        const logical = stripCriticalSuffix(currentFileHeading);
        const critical = isCriticalHeading(currentFileHeading);
        const endLine = Math.max(currentStart + 1, endLineExclusive); // 1-based inclusive
        entries.push({
            logicalHeading: logical,
            fileHeading: currentFileHeading,
            critical,
            body,
            startLine: currentStart + 1,
            endLine,
        });
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;

        // Track fenced code blocks so a `## something` inside a fence
        // doesn't open a new entry.
        const fenceMatch = FENCE_REGEX.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[2]!;
            if (!inFence) {
                inFence = true;
                fenceMarker = marker[0]!; // ``` or ~
            } else if (marker[0] === fenceMarker) {
                inFence = false;
                fenceMarker = '';
            }
            continue;
        }
        if (inFence) continue;

        const m = HEADING_REGEX.exec(line);
        if (!m) continue;

        const level = m[1]!.length;
        // Only entry-level headings open / close an entry. Deeper
        // headings (### …) belong to the current entry's body.
        if (level !== MEMORY_ENTRY_LEVEL) continue;

        // Close the previous entry (if any) before opening the new one.
        if (currentStart >= 0) {
            flush(i);
        }
        currentStart = i;
        currentLevel = level;
        currentFileHeading = m[2]!.trim();
        bodyStart = i + 1;
    }

    // Flush trailing entry.
    if (currentStart >= 0) {
        flush(lines.length);
    }

    void currentLevel; // retained for clarity even if not exported.

    return {
        entries,
        totalLines: lines.length,
        lines,
    };
}

/**
 * Render a single memory entry as the markdown lines that should land
 * on disk. Used by both the initial-template writer and any future
 * "render-only" path (settings UI preview, etc.).
 *
 * The body is normalised: trailing blank lines are stripped and a
 * single trailing newline is added so consecutive entries are visually
 * separated by exactly one blank line in the final file.
 */
export function renderMemoryEntry(logical: string, critical: boolean, body: string): string {
    const heading = formatFileHeading(logical, critical);
    const cleanedBody = trimTrailingBlankLines(body);
    if (!cleanedBody) {
        return `## ${heading}\n`;
    }
    return `## ${heading}\n${cleanedBody}\n`;
}

/**
 * Strip trailing blank / whitespace-only lines from a body block. We
 * keep leading blanks (rare, but the user might have authored them for
 * spacing) and only normalise the tail so successive entries don't pile
 * up empty lines on every rewrite.
 */
export function trimTrailingBlankLines(body: string): string {
    let end = body.length;
    while (end > 0) {
        const lastNewline = body.lastIndexOf('\n', end - 1);
        const line = body.slice(lastNewline + 1, end);
        if (line.trim().length > 0) break;
        end = lastNewline;
        if (end < 0) {
            end = 0;
            break;
        }
    }
    return body.slice(0, end);
}

/** Exported re-binding so other modules can pull the constants from one place. */
export { CRITICAL_HEADING_SUFFIX, MEMORY_ENTRY_LEVEL };
