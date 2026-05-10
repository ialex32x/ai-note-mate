/**
 * String safety helpers for content that will be JSON-serialized and sent
 * to a strict server-side parser (e.g. OpenAI-compatible gateways implemented
 * in Go that use `encoding/json`).
 *
 * Background
 * ----------
 * JavaScript strings are sequences of UTF-16 code units. A non-BMP character
 * (e.g. most emoji like 🔧 / 📝) is represented as a surrogate pair: a high
 * surrogate (U+D800..U+DBFF) followed by a low surrogate (U+DC00..U+DFFF).
 *
 * `String.prototype.slice(start, end)` cuts on UTF-16 code units, so it can
 * leave a "lone surrogate" — half of a surrogate pair — in the resulting
 * string. `JSON.stringify` will faithfully encode that lone surrogate as a
 * literal `\uD83D` escape. The resulting JSON is technically syntactically
 * valid for permissive parsers, but a strict UTF-8-validating parser (such as
 * Go's `encoding/json`) will reject it with errors like:
 *
 *     unexpected end of hex escape
 *
 * To prevent that we:
 *   1. Provide surrogate-aware truncation helpers (`safeSliceHead`,
 *      `safeSliceTail`).
 *   2. Provide a final sanitizer (`stripLoneSurrogates`) that drops any
 *      unpaired surrogates as a defensive last line of defense, regardless
 *      of where the bad byte was introduced upstream (streaming chunk
 *      splits, third-party libraries, etc.).
 */

/**
 * Take the first `n` UTF-16 code units of `s`, but never leave a lone
 * surrogate at the tail.
 *
 * If the cut would land between a high and a low surrogate, the trailing
 * high surrogate is dropped (so the returned string is one code unit
 * shorter than `n`).
 */
export function safeSliceHead(s: string, n: number): string {
    if (n <= 0) return "";
    if (s.length <= n) return s;
    const code = s.charCodeAt(n - 1);
    // High surrogate at the boundary → drop it to avoid splitting a pair.
    if (code >= 0xd800 && code <= 0xdbff) {
        return s.slice(0, n - 1);
    }
    return s.slice(0, n);
}

/**
 * Take the last `n` UTF-16 code units of `s`, but never leave a lone
 * surrogate at the head.
 *
 * If the cut would land between a high and a low surrogate, the leading
 * low surrogate is dropped.
 */
export function safeSliceTail(s: string, n: number): string {
    if (n <= 0) return "";
    if (s.length <= n) return s;
    const start = s.length - n;
    const code = s.charCodeAt(start);
    // Low surrogate at the boundary → drop it to avoid splitting a pair.
    if (code >= 0xdc00 && code <= 0xdfff) {
        return s.slice(start + 1);
    }
    return s.slice(start);
}

/**
 * Remove any unpaired UTF-16 surrogate code units from `s`.
 *
 * This is a defensive sanitizer for any string that will be sent to a
 * strict JSON parser. It is safe to call on already-clean strings (it is
 * a no-op when no lone surrogates are present) and is reasonably cheap.
 */
export function stripLoneSurrogates(s: string): string {
    if (!s) return s;
    // Fast path: no surrogate code units at all.
    let hasSurrogate = false;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdfff) {
            hasSurrogate = true;
            break;
        }
    }
    if (!hasSurrogate) return s;

    let out = "";
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            // High surrogate — must be followed by a low surrogate.
            const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
            if (next >= 0xdc00 && next <= 0xdfff) {
                out += s.charAt(i) + s.charAt(i + 1);
                i++;
            }
            // else: drop the lone high surrogate.
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            // Lone low surrogate — drop it.
        } else {
            out += s.charAt(i);
        }
    }
    return out;
}
