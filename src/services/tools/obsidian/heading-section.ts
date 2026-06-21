/**
 * Heading-path → section line range resolution.
 *
 * Shared between:
 *   - `read_section`     (read.ts)            — resolve a section to read its body
 *   - `grep_file`        (grep.ts)            — optional section scoping
 *   - `insert_text`      (edit/insert-text)   — heading-anchored insertion
 *   - `set_section`      (edit/set-section)   — hash-gated section replacement
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
 * Successful resolution: `start_line` is 1-based inclusive (heading line),
 * `end_line` is the 0-based line of the next heading / boundary
 * (equivalently the exclusive upper bound for `lines.slice(start_line - 1, end_line)`),
 * plus the matched heading's level and text.
 */
export interface ResolvedSection {
    start_line: number;
    end_line: number;
    level: number;
    heading: string;
    /** When the heading_path matched multiple headings and onAmbiguous='first' was used. */
    ambiguous?: boolean;
    /** Number of ambiguous matches (populated when ambiguous=true). */
    ambiguous_match_count?: number;
    /** When exact match failed but case-insensitive fallback succeeded. */
    case_insensitive_match?: boolean;
}

export type FindSectionError =
    | { kind: "no_headings" }
    | { kind: "not_found"; available: string[]; didYouMean?: string }
    | { kind: "ambiguous"; matches: Array<{ index: number; line: number; level: number; ancestors: string[] }> }
    | { kind: "empty_path" };

export type FindSectionResult =
    | { ok: true; section: ResolvedSection }
    | { ok: false; error: FindSectionError };

export type NormalizeHeadingPathResult =
    | { ok: true; value: string[] | null }
    | { ok: false; message: string };

/**
 * Normalize a tool-call `heading_path` argument from common model shapes.
 *
 * Canonical parameter name is `heading_path`. Models frequently emit the alias
 * `heading` (or occasionally `headings`) instead — accept those silently so
 * the first call succeeds without a wasted retry. Legacy `section` is
 * rejected with a concrete migration hint (same wording as `grep_file`).
 *
 * A single string is coerced to a one-element array (common when the model
 * targets one leaf heading).
 */
export function normalizeHeadingPathArg(
    args: Record<string, unknown>,
    options: { required?: boolean; label?: string } = {},
): NormalizeHeadingPathResult {
    const { required = false, label = "heading_path" } = options;

    const canonical = args["heading_path"];
    const aliasHeading = args["heading"];
    const aliasHeadings = args["headings"];
    const raw = canonical ?? aliasHeading ?? aliasHeadings;
    const usedAlias = canonical === undefined && (aliasHeading !== undefined || aliasHeadings !== undefined);

    if (args["section"] !== undefined && raw === undefined) {
        return {
            ok: false,
            message:
                "`section` is no longer accepted; use `heading_path` (an array of heading titles, " +
                "outermost → innermost, e.g. ['Chapter 2', 'Background']).",
        };
    }

    if (raw === undefined) {
        if (required) {
            return {
                ok: false,
                message: `${label} must be a non-empty array of heading titles (outermost → innermost).`,
            };
        }
        return { ok: true, value: null };
    }

    let items: unknown[];
    if (typeof raw === "string") {
        items = [raw];
    } else if (Array.isArray(raw)) {
        items = raw;
    } else {
        const hint = usedAlias ? ` Parameter name is \`${label}\` (not \`heading\`).` : "";
        return {
            ok: false,
            message: `${label} must be a non-empty array of heading titles (outermost → innermost).${hint}`,
        };
    }

    if (items.length === 0) {
        const hint = usedAlias ? ` Use parameter name \`${label}\`.` : "";
        return {
            ok: false,
            message: `${label} must be a non-empty array of heading titles (outermost → innermost).${hint}`,
        };
    }

    const value: string[] = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (typeof item !== "string") {
            return {
                ok: false,
                message: `${label}[${i}] must be a string.`,
            };
        }
        value.push(item);
    }

    return { ok: true, value };
}

/**
 * Locate a heading in `headings` whose ancestor chain (outermost → innermost)
 * is matched by `headingPath` (case-sensitive, trimmed comparison).
 *
 * ## Matching semantics — tail subsequence
 *
 * `headingPath` matches a heading H iff `headingPath` equals the **trailing
 * contiguous slice** of H's ancestor chain (root → … → H itself). In other
 * words: the path is anchored at the heading's bottom and may omit any number
 * of leading ancestors, but must NOT skip intermediates.
 *
 * Examples — given `Chapter 1 > Body > Background`:
 *   - `["Chapter 1", "Body", "Background"]`   → matches (full chain)
 *   - `["Body", "Background"]`                → matches (tail, length 2)
 *   - `["Background"]`                        → matches (tail, length 1)
 *   - `["Chapter 1", "Background"]`           → does NOT match (skips "Body")
 *
 * ## Why tail subsequence rather than strict full chain
 *
 * In practice LLMs frequently submit just the leaf heading (and reasonably
 * so — that's what users say in natural language). Strict full-chain matching
 * forced costly re-reads and confusing "structure changed" retries even when
 * the file had not changed at all. Accepting any unique tail is precise
 * (mid-chain skips remain rejected) yet ergonomic.
 *
 * Safety is preserved by collision detection: if more than one heading shares
 * the requested tail (in particular, when the same leaf name appears in
 * multiple branches), we return `ambiguous` and force the caller to add more
 * ancestors. So a short path is accepted ONLY when it resolves uniquely.
 *
 * ## Tie-break note
 *
 * Strict full-chain matches are conceptually equivalent to "tail of length =
 * full chain depth", and naturally fall out of the same algorithm. There is
 * no special preference for longer matches: the caller's path length is
 * authoritative — multiple headings with the same tail-of-that-length are
 * ambiguous regardless of whether one of them happens to be a full chain.
 *
 * @returns
 *   - `{ ok: true, index, ancestorsAtMatch }` when there is exactly one match.
 *      `ancestorsAtMatch` is the FULL ancestor chain (excluding the matched
 *      heading itself), so callers can echo a fully-qualified path back to
 *      the LLM even when it submitted a short tail.
 *   - `{ ok: false, error: { kind: "no_headings" } }` if the supplied heading
 *     list is empty (caller has no outline to search — not necessarily that the
 *     file lacks markdown headings).
 *   - `{ ok: false, error: { kind: "empty_path" } }` if `headingPath` is empty.
 *   - `{ ok: false, error: { kind: "not_found", available } }` if zero matches.
 *      `available` lists distinct ancestor-chain strings for diagnostics
 *      (capped to keep the error message bounded).
 *   - `{ ok: false, error: { kind: "ambiguous", matches } }` if 2+ matches.
 */
export function findHeadingByPath(
    headings: readonly HeadingNode[],
    headingPath: readonly string[],
): { ok: true; index: number; ancestorsAtMatch: string[]; caseInsensitiveMatch?: boolean }
    | { ok: false; error: FindSectionError } {
    if (headingPath.length === 0) {
        return { ok: false, error: { kind: "empty_path" } };
    }
    if (headings.length === 0) {
        return { ok: false, error: { kind: "no_headings" } };
    }

    const wantedTrimmed = headingPath.map((s) => s.trim());

    // Build ancestor chains and collect matches.
    type StackEntry = { level: number; heading: string };
    const stack: StackEntry[] = [];
    const matches: Array<{ index: number; ancestors: string[] }> = [];

    for (let i = 0; i < headings.length; i++) {
        const h = headings[i]!;
        while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
            stack.pop();
        }

        const fullChain = [...stack.map((e) => e.heading.trim()), h.heading.trim()];

        if (
            wantedTrimmed.length <= fullChain.length
            && pathsEqual(fullChain.slice(fullChain.length - wantedTrimmed.length), wantedTrimmed)
        ) {
            matches.push({ index: i, ancestors: stack.map((e) => e.heading) });
        }

        stack.push({ level: h.level, heading: h.heading });
    }

    if (matches.length === 1) {
        const m = matches[0]!;
        return { ok: true, index: m.index, ancestorsAtMatch: m.ancestors };
    }

    if (matches.length === 0) {
        // Layer 1: case-insensitive retry — LLMs occasionally flip casing.
        const ciResult = tryCaseInsensitiveMatch(headings, headingPath);
        if (ciResult?.match) {
            return {
                ok: true,
                index: ciResult.match.index,
                ancestorsAtMatch: ciResult.match.ancestors,
                caseInsensitiveMatch: true,
            };
        }

        const available = collectAvailableChains(headings);
        // Layer 2: "did you mean?" via edit-distance on chain strings.
        const didYouMean = ciResult?.fuzzy
            ?? findClosestHeadingChain(available, headingPath.join(" > "));

        return { ok: false, error: { kind: "not_found", available, didYouMean } };
    }

    return {
        ok: false,
        error: {
            kind: "ambiguous",
            matches: matches.map((m) => ({
                index: m.index,
                line: headings[m.index]!.line + 1,
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
 * @param onAmbiguous
 *   - `'error'` (default): return an `ambiguous` error when multiple headings
 *     share the same tail.
 *   - `'first'`: return the first match optimistically, with
 *     `section.ambiguous = true` and `section.ambiguous_match_count` set.
 */
export function resolveHeadingPathToRange(
    headings: readonly HeadingNode[],
    headingPath: readonly string[],
    totalLines: number,
    includeSubsections: boolean = true,
    onAmbiguous: "error" | "first" = "error",
): FindSectionResult {
    const lookup = findHeadingByPath(headings, headingPath);
    if (!lookup.ok) {
        if (lookup.error.kind === "ambiguous" && onAmbiguous === "first") {
            const first = lookup.error.matches[0]!;
            const target = headings[first.index]!;
            const startLine = target.line + 1;

            let endLine = totalLines;
            for (let i = first.index + 1; i < headings.length; i++) {
                const h = headings[i]!;
                const isBoundary = includeSubsections ? h.level <= target.level : true;
                if (isBoundary) {
                    endLine = h.line;
                    break;
                }
            }

            return {
                ok: true,
                section: {
                    start_line: startLine,
                    end_line: Math.max(startLine, endLine),
                    level: target.level,
                    heading: target.heading,
                    ambiguous: true,
                    ambiguous_match_count: lookup.error.matches.length,
                },
            };
        }
        return { ok: false, error: lookup.error };
    }

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
            case_insensitive_match: lookup.caseInsensitiveMatch,
        },
    };
}

/**
 * Render a `FindSectionError` as a single-line, model-friendly message.
 * Kept here (rather than at each tool call site) so the wording stays
 * consistent across `read_section`, `insert_text`, and `set_section`.
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
            return (
                `Cannot resolve heading_path ${pathStr}: the heading outline is empty ` +
                `(no headings indexed for this file). This does NOT necessarily mean the file ` +
                `lacks markdown headings — the index may be stale or not yet populated. ` +
                `Use get_metadata or read_section to inspect available headings, or use pattern mode.`
            );
        case "not_found": {
            const sample = error.available.slice(0, 20);
            const more = error.available.length > sample.length
                ? ` (and ${error.available.length - sample.length} more)`
                : "";
            const hint = error.didYouMean
                ? ` Did you mean ${JSON.stringify(error.didYouMean)}?`
                : "";
            return (
                `heading_path ${pathStr} not found.` + hint +
                ` heading_path matches a heading whose ancestor chain ENDS WITH the given titles ` +
                `(intermediates may NOT be skipped). ` +
                `Available ancestor chains (sample): ${sample.join(" | ") || "(none)"}${more}.`
            );
        }
        case "ambiguous": {
            const where = error.matches.map(
                (m) => `line ${m.line} (level ${m.level}${m.ancestors.length > 0 ? `, under ${m.ancestors.join(" > ")}` : ""})`,
            ).join("; ");
            return (
                `heading_path ${pathStr} is ambiguous — ${error.matches.length} headings end with this chain: ${where}. ` +
                `Prepend more ancestors to disambiguate.`
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

function pathsEqualInsensitive(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i]!.toLowerCase() !== b[i]!.toLowerCase()) return false;
    }
    return true;
}

/**
 * Attempt a case-insensitive match of `headingPath` against `headings`.
 * This is the first layer of fuzzy fallback — safe because case-only
 * collisions among heading paths are vanishingly rare.
 *
 * Returns `{ match }` on a unique case-insensitive match, or
 * `{ fuzzy }` with the single best candidate when there are 2+ matches
 * (so the caller can surface it as a "did you mean?" hint).
 */
function tryCaseInsensitiveMatch(
    headings: readonly HeadingNode[],
    headingPath: readonly string[],
): { match?: { index: number; ancestors: string[] }; fuzzy?: string } | null {
    type StackEntry = { level: number; heading: string };
    const stack: StackEntry[] = [];
    const wantedTrimmed = headingPath.map((s) => s.trim().toLowerCase());
    const matches: Array<{ index: number; ancestors: string[] }> = [];

    for (let i = 0; i < headings.length; i++) {
        const h = headings[i]!;
        while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
            stack.pop();
        }

        const fullChainLower = [...stack.map((e) => e.heading.trim().toLowerCase()), h.heading.trim().toLowerCase()];

        if (
            wantedTrimmed.length <= fullChainLower.length
            && pathsEqualInsensitive(fullChainLower.slice(fullChainLower.length - wantedTrimmed.length), wantedTrimmed)
        ) {
            matches.push({ index: i, ancestors: stack.map((e) => e.heading) });
        }

        stack.push({ level: h.level, heading: h.heading });
    }

    if (matches.length === 1) {
        return { match: matches[0] };
    }
    if (matches.length > 1) {
        // Ambiguous even case-insensitively — surface the first as a hint.
        const m = matches[0]!;
        const chainStr = [...m.ancestors, headings[m.index]!.heading].join(" > ");
        return { fuzzy: chainStr };
    }
    return null;
}

/**
 * Levenshtein (edit) distance between two strings.
 */
function levenshtein(a: string, b: string): number {
    const alen = a.length;
    const blen = b.length;
    if (alen === 0) return blen;
    if (blen === 0) return alen;

    let prev = new Uint16Array(blen + 1);
    let curr = new Uint16Array(blen + 1);
    for (let j = 0; j <= blen; j++) prev[j] = j;

    for (let i = 1; i <= alen; i++) {
        curr[0] = i;
        for (let j = 1; j <= blen; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j]! + 1,        // deletion
                curr[j - 1]! + 1,    // insertion
                prev[j - 1]! + cost, // substitution
            );
        }
        const tmp = prev;
        prev = curr;
        curr = tmp;
    }
    return prev[blen]!;
}

/**
 * Find the closest heading chain to `query` from `available` chains.
 * Returns `undefined` when no candidate is within a reasonable threshold.
 */
function findClosestHeadingChain(available: string[], query: string): string | undefined {
    const q = query.toLowerCase();
    let bestDist = Infinity;
    let best = "";
    for (const chain of available) {
        const dist = levenshtein(chain.toLowerCase(), q);
        // Only suggest if it's reasonably close: edit distance < half the query length
        // (e.g. "Backgroud" vs "Background" → dist=1, qlen=10 → accepted).
        if (dist < bestDist && dist < Math.ceil(q.length / 2)) {
            bestDist = dist;
            best = chain;
        }
    }
    return bestDist < Infinity ? best : undefined;
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
