/**
 * Truncate `s` to at most `max` characters, appending an ellipsis (`…`) when
 * the string is cut. The ellipsis character itself counts toward `max`, so
 * the returned string's `length` is always ≤ `max`.
 *
 * Trailing whitespace introduced by the cut is trimmed so results like
 * `"hello …"` don't appear. Empty / short strings are returned unchanged.
 *
 * If the cut would land in the middle of a UTF-16 surrogate pair (e.g.
 * splitting an emoji like 🔧), the trailing high surrogate is dropped so
 * the result never contains a lone surrogate. This keeps the output
 * visually clean and also safe to JSON-serialize. Note: this helper is
 * intended for UI/log strings. For payloads sent to strict JSON parsers
 * (e.g. an OpenAI-compatible gateway), use the dedicated helpers in
 * `string-safe.ts`.
 */
export function truncate(s: string, max: number): string {
    if (max <= 0) return "";
    if (s.length <= max) return s;
    let end = max - 1;
    // Avoid splitting a surrogate pair at the cut boundary.
    const code = s.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    return s.slice(0, end).trimEnd() + "…";
}
