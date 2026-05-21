import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../src/services/retriever/rrf';

describe('retriever / RRF', () => {
    describe('degenerate input', () => {
        it('returns [] for an empty list set', () => {
            expect(reciprocalRankFusion([])).toEqual([]);
        });

        it('returns [] when every list is empty', () => {
            expect(reciprocalRankFusion([{ indices: [] }, { indices: [] }])).toEqual([]);
        });
    });

    describe('single-list passthrough', () => {
        it('preserves order when only one ranker contributed', () => {
            const out = reciprocalRankFusion([
                { indices: [3, 1, 4, 5, 2] },
            ]);
            // Sole list → fused score collapses to 1/(60+rank), which
            // is monotonically decreasing in rank → original order
            // preserved.
            expect(out.map(r => r.index)).toEqual([3, 1, 4, 5, 2]);
        });

        it('accumulates contributions when an index appears multiple times', () => {
            // Pathological but valid input: same index listed twice in
            // the same ranker. Each occurrence adds its own
            // 1/(k+rank) contribution, so the duplicated index ends
            // up with a higher fused score than its first-occurrence
            // rank alone would suggest.
            const out = reciprocalRankFusion([
                { indices: [3, 1, 4, 1, 5] },
            ]);
            const map = new Map(out.map(r => [r.index, r.score]));
            // index 3: rank 0 → 1/61
            // index 1: rank 1 + rank 3 → 1/62 + 1/64
            // index 4: rank 2 → 1/63
            // index 5: rank 4 → 1/65
            expect(map.get(1)).toBeCloseTo(1 / 62 + 1 / 64, 6);
            expect(map.get(3)).toBeCloseTo(1 / 61, 6);
            expect(out[0]!.index).toBe(1); // duplicated index ranks highest
        });

        it('uses 1-based rank in the scoring formula', () => {
            // With a single list of length 1, score = 1/(60+1) = ~0.0164
            const out = reciprocalRankFusion([{ indices: [42] }]);
            expect(out).toHaveLength(1);
            expect(out[0]!.index).toBe(42);
            expect(out[0]!.score).toBeCloseTo(1 / 61, 6);
        });
    });

    describe('multi-list fusion', () => {
        it('sums contributions across lists', () => {
            // Doc 0 is rank 1 in both lists → 2 * 1/61
            // Doc 1 is rank 2 in both lists → 2 * 1/62
            // Doc 2 is rank 3 in list A and absent from list B → 1/63
            const out = reciprocalRankFusion([
                { indices: [0, 1, 2] },
                { indices: [0, 1] },
            ]);
            const map = new Map(out.map(r => [r.index, r.score]));
            expect(map.get(0)).toBeCloseTo(2 / 61, 6);
            expect(map.get(1)).toBeCloseTo(2 / 62, 6);
            expect(map.get(2)).toBeCloseTo(1 / 63, 6);
        });

        it('orders results by descending fused score', () => {
            const out = reciprocalRankFusion([
                { indices: [10, 20, 30] },
                { indices: [30, 20, 10] },
            ]);
            // Doc 10: 1/61 + 1/63 ≈ 0.03228
            // Doc 20: 1/62 + 1/62 ≈ 0.03226 — symmetric
            // Doc 30: 1/63 + 1/61 ≈ 0.03228 — same as 10 by symmetry
            for (let i = 0; i < out.length - 1; i++) {
                expect(out[i]!.score).toBeGreaterThanOrEqual(out[i + 1]!.score);
            }
        });

        it('includes docs present in only one ranker', () => {
            const out = reciprocalRankFusion([
                { indices: [1, 2, 3] },
                { indices: [4, 5, 6] },
            ]);
            const indices = out.map(r => r.index).sort();
            expect(indices).toEqual([1, 2, 3, 4, 5, 6]);
        });

        it('lets a "ranked top in one + missing in other" doc compete with "ranked mid in both"', () => {
            // RRF strength: an exact-name match (BM25 #1, cosine absent)
            // shouldn't get drowned out by a doc both rankers agree on
            // mid-list.
            const out = reciprocalRankFusion([
                { indices: [0, 1, 2, 3, 4] }, // BM25
                { indices: [9, 8, 7, 6, 5] }, // cosine — completely disjoint
            ]);
            // Top result should be the rank-1 from either list.
            const topScore = out[0]!.score;
            expect(topScore).toBeCloseTo(1 / 61, 6);
            // First two results should be the two #1s from each list.
            const top2 = out.slice(0, 2).map(r => r.index).sort();
            expect(top2).toEqual([0, 9]);
        });
    });

    describe('custom k parameter', () => {
        it('higher k flattens the score curve', () => {
            const list = [{ indices: [0, 1, 2, 3, 4] }];
            const k60 = reciprocalRankFusion(list, 60);
            const k1000 = reciprocalRankFusion(list, 1000);
            // Gap between rank 1 and rank 5 should be smaller for k=1000.
            const gap60 = k60[0]!.score - k60[4]!.score;
            const gap1000 = k1000[0]!.score - k1000[4]!.score;
            expect(gap60).toBeGreaterThan(gap1000);
        });

        it('k=0 reduces to harmonic-rank scoring (1/rank)', () => {
            const out = reciprocalRankFusion([{ indices: [0, 1, 2] }], 0);
            expect(out[0]!.score).toBeCloseTo(1, 6);     // 1/(0+1)
            expect(out[1]!.score).toBeCloseTo(1 / 2, 6); // 1/(0+2)
            expect(out[2]!.score).toBeCloseTo(1 / 3, 6); // 1/(0+3)
        });
    });
});
