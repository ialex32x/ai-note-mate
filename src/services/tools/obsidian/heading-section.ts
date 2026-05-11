/**
 * Heading-path → section line range resolution.
 *
 * Shared between:
 *   - `read_section`     (read.ts)            — resolve a section to read its body
 *   - `replace_text`     (edit/replace-text)  — anchor mode (P2)
 *
 * Why a dedicated module instead of inlining into each tool:
 *   1. The tools live on different agents (read-only vs mutation) but must
 *      agree on what "the Background subsection of Chapter 2" means. A
 *      single source of truth prevents the two from drifting (e.g. one
 *      including subsections by default, the other excluding them).
 *   2. Heading matching has several edge cases (duplicate ancestor chains,
 *      empty heading text, level-walking) that are easier to test as pure
 *      functions, decoupled from Obsidian's `App` / `MetadataCache`.
 *
 * The functions here operate on a minimal `HeadingNode[]` shape — the
 * caller is responsible for sourcing it (typically from
 * `app.metadataCache.getFileCache(file).headings`).
 */

/**
 * Minimal heading record. The shape intentionally mirrors what Obsidian's
 * `HeadingCache` exposes (level, heading text, 0-based start line) so the
 * adapter from `HeadingCache` is a no-op.
 */
export interface HeadingNode {
    /** Heading depth (1..6). */
    level: number;
    /** Heading text, as it appears in the file (no leading `#`s, raw spacing). */
    heading: string;
    /** 0-based line index of the heading line in the source file. */
    line: number;
}

/**
 * Successful resolution: a 1-based inclusive `[start_line, end_line]` window
 * plus the matched heading's level.
 */
export interface ResolvedSection {
    start_line: number;
    end_line: number;
    level: number;
    heading: string;
}

export type FindSectionError =
    | { kind: "no_headings" }
    | { kind: "not_found"; available: string[] }
    | { kind: "ambiguous"; matches: Array<{ line: number; level: number; ancestors: string[] }> }
    | { kind: "empty_path" };

export type FindSectionResult =
    | { ok: true; section: ResolvedSection }
    | { ok: false; error: FindSectionError };

/**
 * Locate a heading in `headings` whose ancestor chain (outermost → innermost)
 * matches `headingPath` exactly (case-sensitive, trimmed comparison).
 *
 * Algorithm: walk the headings array linearly, maintaining a stack of
 * currently-open ancestors keyed by level. For each heading, pop ancestors
 * with `level >= current.level`, then check whether
 * `[...stack.map(h => h.heading), current.heading]` matches `headingPath`.
 *
 * - "Matching is exact" — no fuzzy / case-insensitive matching: section
 *   anchoring is a hard scope constraint and silent widening to the wrong
 *   section would corrupt user data downstream (especially under the
 *   anchor-mode `replace_text` in P2).
 * - "Ambiguous" means two or more headings share the same ancestor chain.
 *   We do NOT auto-pick the first; we surface all candidates so the LLM
 *   can refine the path (e.g. add an extra ancestor or an index suffix
 *   we may add later).
 *
 * @returns
 *   - `{ ok: true, section }` when there is exactly one match.
 *   - `{ ok: false, error: { kind: "no_headings" } }` if the file has no headings.
 *   - `{ ok: false, error: { kind: "empty_path" } }` if `headingPath` is empty.
 *   - `{ ok: false, error: { kind: "not_found", available } }` if zero matches.
 *      `available` lists distinct ancestor-chain strings for diagnostics
 *      (capped to keep the error message bounded).
 *   - `{ ok: false, error: { kind: "ambiguous", matches } }` if 2+ matches.
 */
export function findHeadingByPath(
    headings: readonly HeadingNode[],
    headingPath: readonly string[],
): { ok: true; index: number; ancestorsAtMatch: string[] }
    | { ok: false; error: FindSectionError } {
    if (headingPath.length === 0) {
        return { ok: false, error: { kind: "empty_path" } };
    }
    if (headings.length === 0) {
        return { ok: false, error: { kind: "no_headings" } };
    }

    const wantedTrimmed = headingPath.map((s) => s.trim());

    // Stack of currently-open ancestor headings (in document order, by level).
    // We push every heading we visit and pop those whose level is >= the new
    // heading's level, mirroring how Markdown headings nest.
    type StackEntry = { level: number; heading: string };
    const stack: StackEntry[] = [];

    const matches: Array<{ index: number; ancestors: string[] }> = [];

    for (let i = 0; i < headings.length; i++) {
        const h = headings[i]!;
        // Close any open ancestors that are not actually ancestors of `h`.
        while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
            stack.pop();
        }

        // Build the would-be path for this heading.
        const path = [...stack.map((e) => e.heading.trim()), h.heading.trim()];
        if (pathsEqual(path, wantedTrimmed)) {
            matches.push({ index: i, ancestors: stack.map((e) => e.heading) });
        }

        // Now push self as a potential ancestor for following headings.
        stack.push({ level: h.level, heading: h.heading });
    }

    if (matches.length === 1) {
        const m = matches[0]!;
        return { ok: true, index: m.index, ancestorsAtMatch: m.ancestors };
    }

    if (matches.length === 0) {
        // Build a (bounded) list of available ancestor chains for diagnostics.
        const available = collectAvailableChains(headings);
        return { ok: false, error: { kind: "not_found", available } };
    }

    return {
        ok: false,
        error: {
            kind: "ambiguous",
            matches: matches.map((m) => ({
                line: headings[m.index]!.line + 1, // 1-based for user-facing errors
                level: headings[m.index]!.level,
                ancestors: m.ancestors,
            })),
        },
    };
}

/**
 * High-level: resolve a `heading_path` to an inclusive 1-based line window.
 *
 * @param headings  Document-order heading list (typically from MetadataCache).
 * @param headingPath  Outer→inner ancestor chain ending with the target heading.
 * @param totalLines  Total line count of the file (1-based; equals the last
 *                    valid line number).
 * @param includeSubsections
 *   - `true`  (default): the section spans up to the next heading of the SAME
 *     or SHALLOWER level (i.e. nested subsections are included). This is the
 *     "intuitive" notion of a section and is what authors usually mean by
 *     "the Background section".
 *   - `false`: the section stops at the very next heading of ANY level. Useful
 *     when the caller wants only the prose directly under the heading and
 *     intends to handle subsections separately.
 */
export function resolveHeadingPathToRange(
    headings: readonly HeadingNode[],
    headingPath: readonly string[],
    totalLines: number,
    includeSubsections: boolean = true,
): FindSectionResult {
    const lookup = findHeadingByPath(headings, headingPath);
    if (!lookup.ok) return { ok: false, error: lookup.error };

    const idx = lookup.index;
    const target = headings[idx]!;
    const startLine = target.line + 1; // 1-based, includes the heading line

    let endLine = totalLines;
    for (let i = idx + 1; i < headings.length; i++) {
        const h = headings[i]!;
        const isBoundary = includeSubsections ? h.level <= target.level : true;
        if (isBoundary) {
            // The next heading line itself is NOT part of the current section.
            // Convert 0-based heading line to 1-based-exclusive == h.line.
            endLine = h.line;
            break;
        }
    }

    // `endLine` here is exclusive of the next heading; clamp so a section
    // that immediately precedes another heading still reports a valid
    // (possibly heading-only) range.
    const inclusiveEnd = Math.max(startLine, endLine);

    return {
        ok: true,
        section: {
            start_line: startLine,
            end_line: inclusiveEnd,
            level: target.level,
            heading: target.heading,
        },
    };
}

/**
 * Render a `FindSectionError` as a single-line, model-friendly message.
 * Kept here (rather than at each tool call site) so the wording stays
 * consistent across `read_section` and `replace_text` anchor mode.
 */
export function formatFindSectionError(
    error: FindSectionError,
    headingPath: readonly string[],
): string {
    const pathStr = headingPath.map((s) => JSON.stringify(s)).join(" > ");
    switch (error.kind) {
        case "empty_path":
            return `heading_path must contain at least one element.`;
        case "no_headings":
            return `The file has no headings; cannot resolve heading_path ${pathStr}.`;
        case "not_found": {
            const sample = error.available.slice(0, 20);
            const more = error.available.length > sample.length
                ? ` (and ${error.available.length - sample.length} more)`
                : "";
            return (
                `heading_path ${pathStr} not found. ` +
                `Available ancestor chains (sample): ${sample.join(" | ") || "(none)"}${more}.`
            );
        }
        case "ambiguous": {
            const where = error.matches.map(
                (m) => `line ${m.line} (level ${m.level}${m.ancestors.length > 0 ? `, under ${m.ancestors.join(" > ")}` : ""})`,
            ).join("; ");
            return (
                `heading_path ${pathStr} is ambiguous — ${error.matches.length} headings share this ancestor chain: ${where}. ` +
                `Add another ancestor level to disambiguate.`
            );
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const MAX_AVAILABLE_CHAINS = 50;

/**
 * Walk the heading tree and emit each leaf's full ancestor chain (as
 * "A > B > C") for diagnostics on `not_found`. Capped to keep the error
 * message bounded on large files.
 */
function collectAvailableChains(headings: readonly HeadingNode[]): string[] {
    const stack: Array<{ level: number; heading: string }> = [];
    const chains: string[] = [];

    for (const h of headings) {
        while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
            stack.pop();
        }
        const chain = [...stack.map((e) => e.heading), h.heading].join(" > ");
        chains.push(chain);
        if (chains.length >= MAX_AVAILABLE_CHAINS) break;
        stack.push({ level: h.level, heading: h.heading });
    }
    return chains;
}
