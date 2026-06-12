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
 */
export function estimateTokens(text: string): number {
    const cjkRe = /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g;
    const alphaRe = /[a-zA-Z0-9]/g;
    const punctRe = /[^\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uac00-\ud7afa-zA-Z0-9\s]/g;

    const cjkCount = (text.match(cjkRe) || []).length;
    const alphaCount = (text.match(alphaRe) || []).length;
    const punctCount = (text.match(punctRe) || []).length;

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

/** Estimate total tokens for an array of messages. */
export function estimateMessagesTokens(messages: HistoryMessage[]): number {
    let total = 0;
    for (const msg of messages) {
        total += estimateTokens(messageBudgetText(msg));
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
