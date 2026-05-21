/**
 * Multilingual tokenizer used by the BM25 ranker.
 *
 * Tokenization strategy (no external dependencies, mobile-safe):
 *
 *   - Normalize: lowercase + NFD + strip combining marks (accent-fold
 *     "café" → "cafe").
 *   - Latin / Cyrillic / Greek / digits etc.: split on Unicode word
 *     boundaries (`\p{L}+|\p{N}+`). Hyphens / punctuation act as
 *     separators.
 *   - CJK runs (Han, Hiragana, Katakana, Hangul): emit overlapping
 *     character bigrams. A run of length 1 emits one unigram.
 *
 * Why bigrams for CJK: there is no word boundary in CJK script and we
 * cannot afford to ship a real dictionary segmenter (multi-MB,
 * mostly Node-only). Lucene's standard CJK analyzer uses the same
 * bigram approach; it gives a good speed/quality trade-off for the
 * short, term-dense descriptions our use sites embed (tool names,
 * skill triggers, memory headings).
 *
 * The tokenizer is deterministic, side-effect-free, and cheap enough
 * to call inline per retrieval — at our candidate scales (tens to a
 * few hundreds) there is no value in pre-computing or caching the
 * token streams.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;
const WORD_CHAR_REGEX = /[\p{L}\p{N}]/u;

/**
 * Test whether a single character is in one of the CJK script blocks
 * we treat as needing bigram tokenization.
 *
 * Covers:
 *   - U+4E00–U+9FFF: CJK Unified Ideographs (most of Chinese, shared
 *     base for Japanese kanji + Korean hanja)
 *   - U+3040–U+309F: Hiragana
 *   - U+30A0–U+30FF: Katakana
 *   - U+AC00–U+D7AF: Hangul syllables
 *
 * Deliberately NOT included: CJK Extension blocks (rare ideographs),
 * Kangxi radicals, halfwidth/fullwidth forms. Adding them would
 * trade marginally better recall for additional branches; revisit if
 * users complain about missing matches for rare characters.
 */
function isCjk(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0x3040 && code <= 0x309f)
        || (code >= 0x30a0 && code <= 0x30ff)
        || (code >= 0xac00 && code <= 0xd7af);
}

/**
 * Normalize text before tokenization: lowercase + NFD + strip
 * combining marks + recompose via NFC. Folding accents
 * ("Café" ↔ "cafe") matches user expectations far more often than not
 * in the kinds of short descriptive blobs our callsites embed.
 *
 * The final NFC pass is essential for Hangul: NFD decomposes Hangul
 * syllables (U+AC00–U+D7AF) into Jamo components (U+1100–U+11FF),
 * which we want to recompose so the CJK bigram tokenizer sees one
 * character per syllable rather than 3 per syllable. Combining marks
 * (U+0300–U+036F, used by Latin accents) live in a different block and
 * have already been stripped above, so NFC is a no-op for those.
 */
function normalize(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFD')
        .replace(COMBINING_MARKS, '')
        .normalize('NFC');
}

/**
 * Tokenize `text` into an array of (lowercase, accent-folded) terms
 * suitable for BM25 indexing or query evaluation.
 *
 * Performance: O(n) over the input length, allocates one array; no
 * regex backtracking. Safe to call on arbitrarily long strings, but
 * called inline per candidate at our scale.
 */
export function tokenize(text: string): string[] {
    if (!text) return [];
    const normalized = normalize(text);
    const n = normalized.length;
    const tokens: string[] = [];
    let i = 0;
    while (i < n) {
        const ch = normalized[i]!;
        if (isCjk(ch)) {
            // Collect the longest CJK run starting at i.
            let j = i + 1;
            while (j < n && isCjk(normalized[j]!)) j++;
            const run = normalized.slice(i, j);
            if (run.length === 1) {
                tokens.push(run);
            } else {
                // Emit overlapping bigrams (Lucene CJKBigramFilter style).
                for (let k = 0; k < run.length - 1; k++) {
                    tokens.push(run.slice(k, k + 2));
                }
            }
            i = j;
        } else if (WORD_CHAR_REGEX.test(ch)) {
            // Collect a non-CJK letter/digit run.
            let j = i + 1;
            while (j < n && WORD_CHAR_REGEX.test(normalized[j]!) && !isCjk(normalized[j]!)) j++;
            tokens.push(normalized.slice(i, j));
            i = j;
        } else {
            // Whitespace / punctuation / symbols — treat as separator.
            i++;
        }
    }
    return tokens;
}
