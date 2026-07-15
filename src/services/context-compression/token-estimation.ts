import type { HistoryMessage } from "./types";

/**
 * Rough token count estimation.
 * Classifies characters into four buckets for a zero-dependency heuristic:
 *   - CJK (Hanzi/Kana/Hangul):    ~1.5 chars / token
 *   - Alphanumeric (a-zA-Z0-9):   ~4.0 chars / token
 *   - Punctuation/symbols:         ~1.0 token each
 *   - Whitespace:                  ignored (essentially free in most tokenizers)
 *
 * Compared to the previous uniform "non-CJK ÷ 4" approach this fixes two
 * systematic errors that mostly cancel out in prose but diverge badly in
 * structured text / code:
 *   1. Punctuation was underestimated (~4× too cheap).
 *   2. Whitespace was overestimated (~5× too expensive).
 *
 * The estimate is still intentionally conservative — actual token counts
 * vary by tokenizer — but the improved per-class ratios are good enough
 * for threshold comparison across a wider variety of content.
 *
 * Implementation note: the classification is done in a single `for` pass
 * over the string via `charCodeAt`, avoiding the ~3× allocation/scan cost
 * of the previous three-`match()` implementation. This matters when the
 * ContextCompressor tallies every historical message on every send —
 * with megabyte-scale tool_result payloads the regex approach was a
 * measurable main-thread hot spot.
 */
export function estimateTokens(text: string): number {
    let cjkCount = 0;
    let alphaCount = 0;
    let punctCount = 0;

    const len = text.length;
    for (let i = 0; i < len; i++) {
        const code = text.charCodeAt(i);

        // Alphanumeric: 0-9, A-Z, a-z
        if (
            (code >= 0x30 && code <= 0x39)
            || (code >= 0x41 && code <= 0x5A)
            || (code >= 0x61 && code <= 0x7A)
        ) {
            alphaCount++;
            continue;
        }

        // Whitespace — must match JS `\s` for parity with the previous
        // regex implementation. Common members enumerated explicitly to
        // stay cheap; anything else falls through to `punct`.
        if (
            (code >= 0x09 && code <= 0x0D)       // \t \n \v \f \r
            || code === 0x20                     // space
            || code === 0xA0                     // NBSP
            || (code >= 0x2000 && code <= 0x200A)
            || code === 0x2028
            || code === 0x2029
            || code === 0x202F
            || code === 0x205F
            || code === 0x3000
            || code === 0xFEFF
        ) {
            continue;
        }

        // CJK / Kana / Hangul — matches the union of ranges in the
        // previous regex:
        //   U+3040..U+309F  Hiragana
        //   U+30A0..U+30FF  Katakana
        //   U+3400..U+4DBF  CJK Unified Ideographs Ext A
        //   U+4E00..U+9FFF  CJK Unified Ideographs
        //   U+AC00..U+D7AF  Hangul syllables
        if (
            (code >= 0x3040 && code <= 0x309F)
            || (code >= 0x30A0 && code <= 0x30FF)
            || (code >= 0x3400 && code <= 0x4DBF)
            || (code >= 0x4E00 && code <= 0x9FFF)
            || (code >= 0xAC00 && code <= 0xD7AF)
        ) {
            cjkCount++;
            continue;
        }

        // Everything else (including surrogate halves, which the old
        // regex also counted individually) is punctuation/symbol.
        punctCount++;
    }

    return Math.ceil(cjkCount / 1.5 + alphaCount / 4 + punctCount);
}

/** Whether a cached shrink result is still valid for the current `content`. */
export function isValidBudgetHint(msg: HistoryMessage): boolean {
    return (
        msg.contentBudgetHint != null
        && msg.contentBudgetHintForLength != null
        && msg.contentBudgetHintForLength === msg.content.length
    );
}

/**
 * Text to use when estimating how many tokens a message contributes to the
 * outgoing prompt budget. Prefers a validated {@link HistoryMessage.contentBudgetHint}.
 */
export function messageBudgetText(msg: HistoryMessage): string {
    if (isValidBudgetHint(msg)) {
        return msg.contentBudgetHint!;
    }
    return msg.content;
}

/**
 * Per-message memoization for {@link estimateTokens} keyed by the exact
 * string reference returned from {@link messageBudgetText}. Strings are
 * immutable in JS, so identity comparison is sufficient — no need to hash
 * the text. Falls back to a fresh estimation when the message's budget
 * text is replaced (e.g. after `shrinkLargeToolResults` swaps in a hint,
 * or `content` is edited).
 *
 * A {@link WeakMap} keyed by the message object lets the entry be GC'd
 * together with the message, so we never leak across sessions.
 */
const perMessageTokenCache = new WeakMap<HistoryMessage, { textRef: string; tokens: number }>();

function estimateMessageTokensCached(msg: HistoryMessage): number {
    const text = messageBudgetText(msg);
    const hit = perMessageTokenCache.get(msg);
    if (hit && hit.textRef === text) return hit.tokens;
    const tokens = estimateTokens(text);
    perMessageTokenCache.set(msg, { textRef: text, tokens });
    return tokens;
}

/** Estimate total tokens for an array of messages. */
export function estimateMessagesTokens(messages: HistoryMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateMessageTokensCached(msg);
        if (msg.media?.length) {
            // Rough flat estimate per attachment. Image budget per OpenAI's
            // tile model averages ~170; audio/video/pdf vary widely so we use
            // the same flat factor as a placeholder until per-kind estimates
            // become a measurable problem.
            total += msg.media.length * 170;
        }
    }
    return total;
}
