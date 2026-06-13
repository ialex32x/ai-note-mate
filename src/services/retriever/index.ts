/**
 * Unified retriever entry point.
 *
 * Wraps the existing embedding cosine ranker with a BM25 ranker and
 * fuses the two via Reciprocal Rank Fusion (RRF). Three modes,
 * picked automatically from the inputs:
 *
 *   - **Hybrid (BM25 + embedding + RRF)**: when `embeddingConfig` is
 *     supplied AND the global embedder is initialised AND the
 *     embedding call succeeds. The fused ranking benefits from
 *     BM25's exact-name strengths (`obsidian_search`, `edit_lines`,
 *     proper nouns) and embedding's semantic generalisation.
 *   - **BM25 only**: when `embeddingConfig` is null / missing, or the
 *     embedder isn't ready, or the embedding call throws (network,
 *     auth, rate limit). The plugin can still rank candidates
 *     usefully without any network — a meaningful win for users
 *     who deliberately run without embedding.
 *   - **Embedding only**: never used in this code path. We always
 *     run BM25 first because it is local, cheap, and serves as a
 *     graceful fallback when the embedding call fails mid-flight.
 *
 * The function returns ALL candidates that any ranker scored,
 * sorted by fused score descending. Callers apply their own
 * `topK` / zero-pass fallbacks because each callsite has different
 * "what to do when no ranker matched" semantics (full set vs. first
 * N vs. top 3 highest).
 *
 * Cancellation: forwards `signal` to the embedder's HTTP call so
 * the round trip aborts cleanly mid-flight when the user hits
 * stop. BM25 itself is synchronous and short enough to not need a
 * cancellation surface.
 */

import type { MinimalModelConfig } from '../llm-provider';
import { getGlobalEmbedder } from '../embedder';
import { cosineSimilarity, isQueryTooShort } from '../text-embedding';
import { bm25Rank } from './bm25';
import { reciprocalRankFusion, type RankList } from './rrf';
import { isAbortError } from '../../utils/abortable-request';

/** Re-exported for convenience so callers don't need two imports. */
export { isQueryTooShort } from '../text-embedding';

/**
 * Per-candidate scoring details produced by {@link retrieve}.
 *
 * Each present sub-score is optional so the caller can tell which
 * ranker covered a given candidate. The `score` field is the
 * combined value used for the final ordering (RRF when both
 * rankers ran, the lone ranker's score otherwise).
 */
export interface RetrievalResult {
    /** Original index into the input `candidates` array. */
    index: number;
    /**
     * Final score used for ranking; higher = better. This is the
     * RRF score in hybrid mode and the lone ranker's contribution
     * otherwise. Note the scale differs across modes — never
     * threshold on this value, threshold on a sub-score with a
     * stable scale (e.g. {@link cosineSimilarity}).
     */
    score: number;
    /**
     * Cosine similarity between the query and the candidate
     * embedding. Present iff the embedding ranker contributed
     * (config supplied + embedder ready + call succeeded).
     */
    cosineSimilarity?: number;
    /** BM25 raw score. Present iff BM25 found any query-term match. */
    bm25Score?: number;
}

export interface RetrieveOptions {
    /**
     * Embedding provider config. `null` or `undefined` → BM25-only
     * mode. The retriever does not check that an API key is present
     * — it forwards the struct verbatim to the embedder, which
     * surfaces auth errors through its own status channel.
     */
    embeddingConfig?: MinimalModelConfig | null;
    /**
     * Forwarded to the embedder for user-initiated aborts. BM25 has
     * no asynchronous work and ignores this signal.
     */
    signal?: AbortSignal;
}

/**
 * Rank `candidates` against `query`.
 *
 * See the module docstring for the mode selection rules and the
 * sub-score semantics.
 *
 * @returns Results sorted by descending fused score. Candidates
 * that produced NO signal from any ranker (zero BM25 hits AND
 * embedding wasn't used / failed) are omitted; callers can detect
 * this by comparing `result.length` against `candidates.length`
 * and applying their own zero-pass fallback (e.g. retain top N
 * from natural order).
 */
export async function retrieve(
    query: string,
    candidates: readonly string[],
    opts: RetrieveOptions = {},
): Promise<RetrievalResult[]> {
    if (candidates.length === 0) return [];

    // ── BM25 (always) ──────────────────────────────────────────
    const bm25Results = bm25Rank(query, candidates);

    // ── Embedding (optional) ───────────────────────────────────
    //
    // Gate on a non-empty config; the embedder's own status surface
    // handles auth / network failures. We skip embedding when the
    // query is too short because cosine similarity over a 1–2-char
    // query is dominated by stylistic noise (every doc looks
    // mildly relevant). BM25 on the same input is also noisy but
    // its absolute scores are tiny, so it degrades gracefully.
    let embeddingScores: { index: number; cosine: number; }[] | null = null;
    if (opts.embeddingConfig && !isQueryTooShort(query)) {
        embeddingScores = await runEmbeddingRanker(query, candidates, opts);
    }

    // ── Build per-candidate result skeleton ────────────────────
    //
    // Both rankers may cover overlapping or disjoint subsets of
    // candidates. We accumulate every covered index into the map,
    // then attach an RRF score in a second pass.
    const resultMap = new Map<number, RetrievalResult>();

    for (const r of bm25Results) {
        resultMap.set(r.index, {
            index: r.index,
            score: 0,
            bm25Score: r.score,
        });
    }
    if (embeddingScores) {
        for (const e of embeddingScores) {
            const existing = resultMap.get(e.index);
            if (existing) {
                existing.cosineSimilarity = e.cosine;
            } else {
                resultMap.set(e.index, {
                    index: e.index,
                    score: 0,
                    cosineSimilarity: e.cosine,
                });
            }
        }
    }

    // ── Score via RRF ──────────────────────────────────────────
    //
    // RRF needs ordered index lists per ranker. We feed BM25 even
    // in embedding-only mode (and vice versa) so the fusion math
    // is uniform; with one list the RRF score collapses to
    // `1/(k+rank)` which preserves the ordering perfectly.
    const lists: RankList[] = [];
    if (bm25Results.length > 0) {
        lists.push({ indices: bm25Results.map(r => r.index) });
    }
    if (embeddingScores && embeddingScores.length > 0) {
        lists.push({ indices: embeddingScores.map(e => e.index) });
    }
    if (lists.length === 0) {
        // No ranker covered anything. Caller's zero-pass fallback
        // will take over.
        return [];
    }
    const fused = reciprocalRankFusion(lists);

    const out: RetrievalResult[] = [];
    for (const f of fused) {
        const entry = resultMap.get(f.index);
        if (!entry) continue;
        entry.score = f.score;
        out.push(entry);
    }
    return out;
}

/**
 * Run the embedding ranker, returning per-candidate cosine
 * similarities (sorted descending), or `null` when the call could
 * not produce a result. Aborts re-throw so the caller's chat turn
 * can cancel cleanly; all other failure modes degrade silently to
 * BM25-only (logged via the embedder's own status channel).
 */
async function runEmbeddingRanker(
    query: string,
    candidates: readonly string[],
    opts: RetrieveOptions,
): Promise<{ index: number; cosine: number; }[] | null> {
    const embedder = getGlobalEmbedder();
    if (!embedder) {
        console.warn('[Retriever] global embedder not initialised; falling back to BM25-only');
        return null;
    }
    try {
        await embedder.updateConfig(opts.embeddingConfig!);
        const texts = [query, ...candidates];
        const vectors = await embedder.embed(texts, opts.signal);
        const queryVec = vectors[0]!;
        const candVecs = vectors.slice(1);
        const scored = candVecs.map((vec, i) => ({
            index: i,
            cosine: cosineSimilarity(queryVec, vec),
        }));
        scored.sort((a, b) => b.cosine - a.cosine);
        return scored;
    } catch (err) {
        if (isAbortError(err)) throw err;
        // The embedder marked itself unavailable already; we just
        // degrade to BM25-only and surface the issue through the
        // existing status channel.
        console.warn('[Retriever] embedding ranker failed, falling back to BM25-only:', err);
        return null;
    }
}
