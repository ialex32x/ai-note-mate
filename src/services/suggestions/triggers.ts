/**
 * Multi-language trigger phrases that indicate a follow-up suggestion block
 * is about to appear in the assistant's reply.
 *
 * These are recognition rules (not user-facing strings) and therefore live
 * outside of the i18n system on purpose.
 */

/**
 * Header / opener phrases. Presence of any of these in the tail of the
 * message is a strong signal that the following list items are proposed
 * next actions.
 *
 * Stored lowercased for case-insensitive matching.
 */
export const FOLLOWUP_HEADERS: readonly string[] = [
    // zh-cn / zh-tw
    '下一步', '后续', '後續', '接下来', '接下來',
    '要不要', '要不要我', '需要我', '是否需要',
    '你希望', '您希望', '要我帮', '要我幫',
    '可以继续', '可以繼續', '是否要', '是否继续', '是否繼續',

    // en
    'next steps', 'next step',
    'would you like', 'shall i', 'do you want', 'do you need',
    'should i', 'want me to', 'let me know if',

    // ja
    '次のステップ', '次は', 'しましょうか', 'しますか',
    '続けますか', 'ご希望であれば',

    // ko
    '다음 단계', '원하시면', '원하시나요',
    '해드릴까요', '계속할까요',
];

/**
 * Inline single-question closers. When the message ends with such a
 * phrase followed by `?`/`？` we treat it as a single-action suggestion.
 *
 * Each entry is a lowercased prefix that, when found in the last
 * sentence of the reply, qualifies it as a follow-up question.
 */
export const SINGLE_QUESTION_HINTS: readonly string[] = [
    '要不要我', '需要我', '是否需要我', '要我帮', '要我幫',
    'would you like me to', 'shall i', 'do you want me to', 'should i',
    'しましょうか', 'しますか',
    '해드릴까요', '원하시면',
];

/**
 * Sentence-leading offer prefixes used when splitting a closing question
 * like "需要我 A，或者 B 吗?" into multiple parallel suggestions.
 *
 * Only the prefixes that naturally appear at the *start* of the offer
 * (subject-verb form) are listed here. Japanese sentence-final markers
 * such as "しましょうか" and Korean "해드릴까요" are deliberately excluded
 * because they sit at the *end* of the verb phrase and don't fit the
 * "strip-prefix-then-split" model used by `splitOrChoiceQuestion`.
 * Those forms still produce a single-suggestion follow-up via the
 * regular `SINGLE_QUESTION_HINTS` path.
 *
 * Stored lowercased for case-insensitive matching.
 */
export const OFFER_PREFIXES_AT_START: readonly string[] = [
    '需要我', '要不要我', '是否需要我', '要我帮', '要我幫',
    'would you like me to', 'do you want me to', 'shall i', 'should i',
];

/**
 * "Or"-style separators used to break a single closing question into
 * parallel options. Accepts an optional CJK / Western comma before the
 * connector (e.g. `"整理 A，或者 B"` or `"整理 A 或者 B"`) and the bare
 * ` or ` conjunction in English. Intentionally case-insensitive so that
 * sentence-cased English (`" Or "`) still matches.
 */
export const OR_CHOICE_SEPARATORS: RegExp =
    /[,，、]?\s*(?:或者|或是|还是|還是)\s*|\s+or\s+/i;
