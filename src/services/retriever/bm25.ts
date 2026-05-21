/**
 * Okapi BM25 scorer.
 *
 * Stateless, allocation-light implementation. We do NOT maintain a
 * persistent inverted index — at our candidate scales (tens to a few
 * hundreds of short documents) building the per-call counts inline
 * costs sub-millisecond per query, far less than the embedding round
 * trip we used to gate on. Avoiding persistence also means the index
 * cannot drift out of sync with the candidate set, simplifying every
 * caller (tools, skills, memory) that re-derives the candidate list
 * on every turn.
 *
 * Parameter defaults:
 *   - k1 = 1.5: standard "moderate term-frequency saturation". Higher
 *     values reward repeated terms more; lower values flatten the
 *     contribution of repeats. 1.5 sits in the middle of the typical
 *     `[1.2, 2.0]` range and matches Elasticsearch's default.
 *   - b = 0.75: standard length normalization. 0 disables length
 *     compensation, 1 fully normalizes; 0.75 is the BM25 paper's
 *     recommendation and is the default in every major IR system.
 *
 * These knobs are intentionally NOT exposed in the plugin settings —
 * tuning them is a deep-IR concern and the defaults work well across
 * our document mix.
 */

import { tokenize } from './tokenizer';

/** A single document's BM25 score along with its original index. */
export interface BM25Result {
    index: number;
    score: number;
}

export interface BM25Options {
    k1?: number;
    b?: number;
}

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

/**
 * Rank `documents` against `query` by BM25.
 *
 * Returns one entry per document in DESCENDING score order. Documents
 * that share no query terms get a score of 0 and are omitted from
 * the result (callers can detect zero coverage by `result.length <
 * documents.length`).
 *
 * Tokenization for both sides goes through {@link tokenize} so query
 * "Café" matches doc "cafe", and CJK runs use overlapping bigrams.
 */
export function bm25Rank(
    query: string,
    documents: readonly string[],
    opts: BM25Options = {},
): BM25Result[] {
    const k1 = opts.k1 ?? DEFAULT_K1;
    const b = opts.b ?? DEFAULT_B;

    if (documents.length === 0) return [];

    // Dedupe query terms — repeated terms in the query do not boost
    // their contribution under standard BM25, only repeated terms in
    // the document do. Deduping keeps the inner loop tight without
    // changing the score.
    const queryTerms = Array.from(new Set(tokenize(query)));
    if (queryTerms.length === 0) return [];

    // Per-doc token list + term-frequency map. Memoised once so the
    // df / scoring passes don't re-tokenize.
    const docTokens = documents.map(d => tokenize(d));
    const docTermFreqs: Map<string, number>[] = docTokens.map(tokens => {
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        return tf;
    });
    const docLengths = docTokens.map(t => t.length);
    const totalLength = docLengths.reduce((a, b) => a + b, 0);
    // Guard against degenerate empty corpus (no tokens anywhere) so
    // we never divide by zero in the length normaliser below.
    const avgdl = totalLength === 0 ? 1 : totalLength / documents.length;

    // Document frequency per query term. We only need df for terms
    // that actually appear in the query, so this is cheap.
    const docFreqs = new Map<string, number>();
    for (const term of queryTerms) {
        let df = 0;
        for (const tf of docTermFreqs) {
            if (tf.has(term)) df++;
        }
        docFreqs.set(term, df);
    }

    const N = documents.length;
    const results: BM25Result[] = [];
    for (let i = 0; i < N; i++) {
        let score = 0;
        const tf = docTermFreqs[i]!;
        const dl = docLengths[i]!;
        // BM25 length normalisation: docs shorter than avgdl get a
        // small boost, longer docs a small penalty. b controls the
        // strength.
        const lenNorm = 1 - b + b * (dl / avgdl);
        for (const term of queryTerms) {
            const f = tf.get(term);
            if (!f) continue;
            const df = docFreqs.get(term) ?? 0;
            // BM25+1 IDF variant (always non-negative), avoids the
            // pathological negative scores that the classic Robertson-
            // Sparck-Jones form produces when df > N/2.
            const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
            score += idf * (f * (k1 + 1)) / (f + k1 * lenNorm);
        }
        if (score > 0) {
            results.push({ index: i, score });
        }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
}
