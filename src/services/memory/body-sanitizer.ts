/**
 * Body sanitisers shared between the prompt-prefix builder and the
 * auto-extractor — anything that ships a {@link MemoryEntry.body} to a
 * model should run it through {@link stripCallouts} first.
 *
 * Why a separate module? Callout filtering is a *write/read boundary*
 * concern, not a parsing concern: the stored body intentionally keeps
 * callouts (the user authored them as private annotations and expects
 * to see them again in the note), but the LLM-facing copy must drop
 * them so they don't pollute the prompt or the embedding signal. Both
 * call sites (`memory-prompt.ts`, `memory-extractor.ts`) need the
 * exact same rule, so the implementation lives in one place.
 *
 * The function is intentionally tolerant: it only removes recognised
 * callout blocks (`> [!type] …` and their continuation lines) and
 * leaves plain blockquotes alone — those carry meaningful content
 * (e.g. "the user said …") that the model should still see.
 */

/**
 * Strip every Obsidian callout block from `body` and return the result.
 *
 * A callout block starts with a line matching `/^\s*>+\s*\[!type\][+-]?/`
 * and extends through any number of consecutive blockquote-prefixed
 * lines (`^\s*>`). The first blank or non-`>`-prefixed line terminates
 * the callout, matching how Obsidian's renderer scopes them.
 *
 * Nested callouts (`> > [!info]`) are swallowed as part of the outer
 * block because they also satisfy `^\s*>` continuation. A trailing
 * blank line directly after a stripped callout is collapsed when the
 * surrounding text would otherwise have two consecutive blanks — keeps
 * the rendered body compact without altering author-intended spacing.
 *
 * Returns the original string when no callouts are present (cheap
 * short-circuit) so the hot path stays allocation-free for the common
 * case where the user has authored no annotations.
 */
export function stripCallouts(body: string): string {
    if (!body) return body;
    // Fast bail-out: scanning for the marker is much cheaper than
    // splitting on newlines for the (very common) callout-free case.
    if (!/^\s*>+\s*\[!\w+\]/m.test(body)) return body;

    const lines = body.split('\n');
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;
        if (CALLOUT_OPEN_RE.test(line)) {
            // Drop the opening line and any continuation lines that
            // remain inside the blockquote. We deliberately accept
            // nested `>` depths — Obsidian treats them as the same
            // outer callout for layout purposes.
            i++;
            while (i < lines.length && QUOTE_LINE_RE.test(lines[i]!)) {
                i++;
            }
            // Collapse one trailing blank that would otherwise leave a
            // double blank (the previous line we emitted + a fresh
            // blank from the post-callout gap).
            if (
                i < lines.length
                && lines[i]!.trim() === ''
                && out.length > 0
                && out[out.length - 1]!.trim() === ''
            ) {
                i++;
            }
            continue;
        }
        out.push(line);
        i++;
    }
    // Drop trailing blank lines created by stripping a callout that
    // sat at the end of the body.
    while (out.length > 0 && out[out.length - 1]!.trim() === '') {
        out.pop();
    }
    return out.join('\n');
}

const CALLOUT_OPEN_RE = /^\s*>+\s*\[!\w+\][+-]?/;
const QUOTE_LINE_RE = /^\s*>/;
