/**
 * Excerpt utilities — context-window snapshots around a text span.
 *
 * Originally extracted from {@link ../services/tools/obsidian/edit/replace-text.ts}.
 */

export const EXCERPT_CONTEXT_CHARS = 30;
export const EXCERPT_HARD_CAP = 240;

/**
 * Build before/after context excerpts centred on a replaced span.
 *
 * @param original  Pre-edit content.
 * @param modified  Post-edit content.
 * @param from      Inclusive start of the replaced span in `original`.
 * @param to        Exclusive end of the replaced span in `original`.
 * @param newFrom   Inclusive start of the replacement in `modified`.
 * @param newTo     Exclusive end of the replacement in `modified`.
 */
export function buildSpanExcerpts(
    original: string,
    modified: string,
    from: number,
    to: number,
    newFrom: number,
    newTo: number,
): { before: string; after: string; truncated: boolean } {
    const beforeStart = Math.max(0, from - EXCERPT_CONTEXT_CHARS);
    const beforeEnd = Math.min(original.length, to + EXCERPT_CONTEXT_CHARS);
    const afterStart = Math.max(0, newFrom - EXCERPT_CONTEXT_CHARS);
    const afterEnd = Math.min(modified.length, newTo + EXCERPT_CONTEXT_CHARS);

    let before = original.substring(beforeStart, beforeEnd);
    let after = modified.substring(afterStart, afterEnd);
    let truncated = false;
    if (before.length > EXCERPT_HARD_CAP) {
        before = before.substring(0, EXCERPT_HARD_CAP);
        truncated = true;
    }
    if (after.length > EXCERPT_HARD_CAP) {
        after = after.substring(0, EXCERPT_HARD_CAP);
        truncated = true;
    }
    return { before, after, truncated };
}
