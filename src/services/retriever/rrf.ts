/**
 * Reciprocal Rank Fusion (Cormack, Clarke, Buettcher 2009).
 *
 *   RRF(d) = Σ_r ∈ R   1 / (k + rank_r(d))
 *
 * For each ranking r in the input list set, a document d contributes
 * `1 / (k + position-in-r)` where position is 1-based. Documents
 * absent from a list contribute 0 to that list.
 *
 * Why RRF over linear combination of scores:
 *   - Score-scale agnostic: BM25 is unbounded, cosine ∈ [-1, 1].
 *     Linear combination requires normalising one of them, and every
 *     normalisation scheme has pathological inputs that flip the
 *     ranking. RRF only needs ranks.
 *   - Robust to ranker disagreement: a doc ranked top-1 by one
 *     ranker and absent from the other still scores well; this is
 *     the typical pattern when BM25 catches an exact-name match
 *     that cosine misses.
 *   - One knob (k). Standard default is k=60, which we use.
 *
 * The function is pure — no internal state, no allocations beyond
 * the result array — and is the only fusion strategy the retriever
 * exposes.
 */

const DEFAULT_K = 60;

/**
 * Ordered ranking from a single retriever. `indices` is a list of
 * original document indices in BEST-FIRST order. Documents not
 * present in `indices` are treated as unranked (contribute 0 to
 * the fused score from this list).
 */
export interface RankList {
    indices: readonly number[];
}

/** Fused score along with the original document index. */
export interface RRFResult {
    index: number;
    score: number;
}

/**
 * Fuse `lists` via Reciprocal Rank Fusion.
 *
 * Returns documents that appeared in at least one list, sorted by
 * descending fused score. Documents absent from every list are
 * omitted (callers can detect them by comparing `result.length`
 * against the total candidate count).
 *
 * @param lists One ordered list per ranker.
 * @param k     RRF damping constant. Higher = flatter score curve;
 *              lower = sharper preference for top-ranked items.
 *              Defaults to the standard 60.
 */
export function reciprocalRankFusion(
    lists: readonly RankList[],
    k: number = DEFAULT_K,
): RRFResult[] {
    const scores = new Map<number, number>();
    for (const list of lists) {
        for (let rank = 0; rank < list.indices.length; rank++) {
            const idx = list.indices[rank]!;
            const contribution = 1 / (k + rank + 1);
            scores.set(idx, (scores.get(idx) ?? 0) + contribution);
        }
    }
    const out: RRFResult[] = [];
    for (const [index, score] of scores) {
        out.push({ index, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
}
