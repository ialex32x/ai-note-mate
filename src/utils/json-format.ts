/**
 * Helpers for presenting JSON text to the user (display / clipboard).
 *
 * These are UI-facing formatters, not on-wire serializers. For
 * serialization safety (lone surrogates, UTF-8 validity, etc.) see
 * `string-safe.ts`.
 */

/**
 * If `text` is a valid JSON document representing an object or array,
 * return its pretty-printed form (2-space indent). Otherwise return the
 * original text unchanged.
 *
 * Design notes:
 *  - Only inputs whose first non-whitespace character is `{` or `[` are
 *    considered candidates. Primitive JSON values (bare strings, numbers,
 *    `true`/`false`/`null`) are intentionally left as-is so we don't strip
 *    surrounding quotes the user likely wants to keep visible.
 *  - Inputs that merely contain JSON somewhere inside them (e.g.
 *    `Error: {"code":1}`) are left alone: partial reformatting would
 *    rewrite content the caller didn't ask us to touch.
 *  - Parse failures fall through silently — the goal is best-effort
 *    prettify for display, not validation.
 *
 * Typical callers: "copy tool result" menu, error bubble rendering.
 */
export function prettifyIfJson(text: string): string {
    if (!text) return text;
    const trimmed = text.trim();
    if (!trimmed) return text;
    const first = trimmed[0];
    if (first !== '{' && first !== '[') return text;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object') {
            return JSON.stringify(parsed, null, 2);
        }
    } catch {
        // Not valid JSON — fall through and return the original text.
    }
    return text;
}
