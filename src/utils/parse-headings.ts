/**
 * ATX heading parser — fallback when Obsidian's metadata cache hasn't
 * indexed a file yet.
 *
 * Output shape matches `HeadingNode` from `heading-section.ts` (duck-typed),
 * so callers can pass the result directly to `resolveHeadingPathToRange`.
 */

export interface ParsedHeading {
    level: number;
    heading: string;
    /** 0-based line index in the source file. */
    line: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/**
 * Parse ATX headings (`# Title`, `## Section`, etc.) from raw lines.
 * Returns headings in document order with 0-based line indices.
 */
export function parseHeadingsFromLines(lines: readonly string[]): ParsedHeading[] {
    const headings: ParsedHeading[] = [];
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i]!.match(HEADING_RE);
        if (m) {
            headings.push({
                level: m[1]!.length,
                heading: m[2]!.trim(),
                line: i,
            });
        }
    }
    return headings;
}
