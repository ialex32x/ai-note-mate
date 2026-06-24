/**
 * Regex utilities — search, substitution, and heuristic detection.
 *
 * Originally extracted from {@link ../services/tools/obsidian/edit/replace-text.ts}
 * as a low-risk, high-reward decomposition step.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RegexHit {
    start: number;
    end: number;
}

export interface RegexMatch {
    start: number;
    end: number;
    groups: (string | undefined)[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find every non-overlapping literal occurrence of `needle` in `haystack`.
 *
 * After a hit we advance by `needle.length`, so
 * `findAllOccurrences("aaaa", "aa")` returns positions [0, 2], not [0, 1, 2].
 */
export function findAllOccurrences(haystack: string, needle: string): number[] {
    const out: number[] = [];
    let from = 0;
    while (true) {
        const idx = haystack.indexOf(needle, from);
        if (idx < 0) break;
        out.push(idx);
        from = idx + needle.length;
    }
    return out;
}

/**
 * Find every match of `regex` in `haystack`, returning `{ start, end }`
 * for each non-empty match.  Standard non-overlapping global scan.
 *
 * Zero-length matches are skipped (they would infinite-loop `exec`).
 * The regex is always applied with the `g` (global) flag regardless
 * of how the caller constructs it — this is intentional so that the
 * model can pass a simple `pattern` without worrying about the flag.
 */
export function findAllOccurrencesRegex(haystack: string, source: string): RegexHit[] {
    const out: RegexHit[] = [];
    const re = new RegExp(source, "gmu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
        if (m[0].length === 0) continue;
        out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
}

/** Like `findAllOccurrencesRegex` but also captures groups for `$N` substitution. */
export function findAllRegexMatches(haystack: string, source: string): RegexMatch[] {
    const out: RegexMatch[] = [];
    const re = new RegExp(source, "gmu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(haystack)) !== null) {
        if (m[0].length === 0) continue;
        // Slice to clone the sparse array; undefined entries stay undefined.
        const groups: (string | undefined)[] = [];
        for (let i = 0; i < m.length; i++) groups.push(m[i]);
        out.push({ start: m.index, end: m.index + m[0].length, groups });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Substitution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Substitute `$1`–`$99`, `$&`, `` $` ``, `$'`, and `$$` in `replacement`
 * using the captured groups from a regex match.
 *
 *   - `$&`       → full match (groups[0])
 *   - `$1`–`$99` → corresponding capture group
 *   - `` $` ``   → text in `original` before this match
 *   - `$'`       → text in `original` after this match
 *   - `$$`       → literal `$`
 *
 * Unmatched groups (undefined) become empty strings.
 */
export function replaceWithGroups(
    replacement: string,
    original: string,
    match: RegexMatch,
): string {
    return replacement.replace(
        /\$(?:([1-9]\d?)|([&`']))|\$\$/g,
        (_sub, digits, named) => {
            // $$ → literal $
            if (digits === undefined && named === undefined) return "$";
            // $`  $'  $&
            if (named !== undefined) {
                if (named === "&") return match.groups[0] ?? "";
                if (named === "`") return original.slice(0, match.start);
                if (named === "'") return original.slice(match.end);
            }
            // $1 – $99
            const idx = Number(digits);
            return match.groups[idx] ?? "";
        },
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic regex detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Heuristic: does `s` look like a regex pattern that was accidentally
 * passed as a literal?  Detects common regex escapes and metacharacters
 * that are virtually never present in literal Obsidian content.
 *
 * This lets us add a targeted hint to the "not found" error when a
 * model writes something like `\\(DevRoot\\)` expecting regex matching
 * but forgets to set `use_regex: true`.
 */
export function looksLikeRegex(s: string): boolean {
    // Escaped regex sequences: \\d \\w \\s \\b \\n \\t \\S \\W \\D \\B
    if (/\\[dwstnSWDB]/i.test(s)) return true;
    // Escaped brackets/parens/braces: \( \) \[ \] \{ \}
    if (/\\([()[\]{}])/.test(s)) return true;
    // Escaped metacharacters: \. \+ \* \? \| \^ \$
    if (/\\[.+*?|^$]/.test(s)) return true;
    // Common laziness quantifiers: .*? .+?
    if (/\.[*+]\?/.test(s)) return true;
    // Bare character classes: [abc] [^x] — but exclude common Markdown
    // constructs that also use brackets (links, wikilinks, callouts,
    // checkboxes, YAML arrays).
    if (/\[[^\]]+\]/.test(s) && !looksLikeHarmlessBrackets(s)) return true;
    return false;
}

/** Markdown constructs that use [] but are never regex. */
export function looksLikeHarmlessBrackets(s: string): boolean {
    // [[wikilinks]] and [text](url)
    if (/\[\[[^\]]*\]\]/.test(s) || /\[[^\]]*\]\([^)]*\)/.test(s)) return true;
    // Obsidian callouts: > [!note], > [!info]-, > [!warning]+ etc.
    if (/>\s*\[!/.test(s)) return true;
    // Task checkboxes: - [ ], - [x], * [ ], 1. [x] etc.
    if (/^[\s>-]*[-*+]\s*\[[\sx]\]/.test(s) || /^\d+\.\s*\[[\sx]\]/.test(s)) return true;
    // YAML array: [a, b, c] or ["a", "b"] — must contain at least one comma
    if (/^\[[\w"',. -]*,[\w"',. -]*\]$/.test(s)) return true;
    return false;
}

/**
 * Build a hint string when a literal pattern contains regex-looking
 * constructs — helps the model self-correct without re-reading the file.
 */
export function regexHintForLiteral(pattern: string): string {
    if (!looksLikeRegex(pattern)) return "";
    const found: string[] = [];
    if (/\\[dwstnSWDB]/i.test(pattern)) found.push("\\d \\w \\s \\n (escaped backslash sequences)");
    if (/\\[.+*?|^$]/.test(pattern)) found.push("\\ . \\ + \\ * \\ ? \\ | (escaped metacharacters)");
    if (/\\([()[\]{}])/.test(pattern)) found.push("\\( \\) \\[ \\] \\{ \\} (escaped brackets/parens/braces)");
    if (/\.[*+]\?/.test(pattern)) found.push(".*? .+? (lazy quantifiers)");
    if (/\[[^\]]+\]/.test(pattern) && !looksLikeHarmlessBrackets(pattern)) found.push("[...] (character class)");
    const summary = found.length > 0 ? ` Detected: ${found.join(", ")}.` : "";
    return (
        ` HINT: This pattern looks like a regex but use_regex is false (literal match mode).` +
        summary +
        ` Set "use_regex": true if regex matching was intended.`
    );
}
