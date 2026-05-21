import { describe, it, expect } from 'vitest';
import { bm25Rank } from '../src/services/retriever/bm25';

describe('retriever / BM25', () => {
    describe('degenerate input', () => {
        it('returns [] for empty document set', () => {
            expect(bm25Rank('hello', [])).toEqual([]);
        });

        it('returns [] for empty query', () => {
            expect(bm25Rank('', ['hello world'])).toEqual([]);
        });

        it('returns [] when query has no token matches in any doc', () => {
            const docs = ['apple banana', 'cherry date'];
            expect(bm25Rank('zzz', docs)).toEqual([]);
        });

        it('handles a single-document corpus', () => {
            const out = bm25Rank('hello', ['hello world']);
            expect(out).toHaveLength(1);
            expect(out[0]!.index).toBe(0);
            expect(out[0]!.score).toBeGreaterThan(0);
        });
    });

    describe('ranking semantics', () => {
        it('ranks term-overlap docs above non-overlap docs', () => {
            const docs = [
                'fix tags on my project notes',
                'unrelated content about cooking',
                'tagged with custom labels for notes',
            ];
            const out = bm25Rank('tags notes', docs);
            // Docs 0 and 2 should outrank doc 1 (which has zero overlap
            // and is therefore omitted entirely).
            expect(out.find(r => r.index === 1)).toBeUndefined();
            const ranked = out.map(r => r.index);
            expect(ranked).toContain(0);
            expect(ranked).toContain(2);
        });

        it('orders results by descending score', () => {
            const docs = [
                'apple', // 1 occurrence
                'apple apple apple', // 3 occurrences
                'apple apple', // 2 occurrences
            ];
            const out = bm25Rank('apple', docs);
            // Same query term, varying TF and document length. BM25
            // length normalisation means highest TF doesn't strictly
            // mean highest score, but the sort order should be DESC.
            for (let i = 0; i < out.length - 1; i++) {
                expect(out[i]!.score).toBeGreaterThanOrEqual(out[i + 1]!.score);
            }
        });

        it('omits documents with zero score from the result', () => {
            const docs = ['hello world', 'foo bar', 'hello universe'];
            const out = bm25Rank('hello', docs);
            // Only doc 0 and doc 2 have "hello".
            const indices = out.map(r => r.index).sort();
            expect(indices).toEqual([0, 2]);
        });
    });

    describe('IDF properties', () => {
        it('produces non-negative scores even when df > N/2', () => {
            // Classic Robertson-Sparck-Jones IDF would go negative here;
            // we use the BM25+1 variant which clamps to non-negative.
            const docs = [
                'common word here',
                'common word there',
                'common word everywhere',
                'something else entirely',
            ];
            const out = bm25Rank('common', docs);
            for (const r of out) {
                expect(r.score).toBeGreaterThanOrEqual(0);
            }
        });

        it('rewards rare terms more than common ones', () => {
            // "rare" appears only in doc A; "common" appears in all docs.
            const docs = [
                'rare token here',     // contains both
                'common across all',   // contains only "common"
                'common token also',   // contains only "common"
                'common term again',   // contains only "common"
            ];
            const rareScore = bm25Rank('rare', docs);
            const commonScore = bm25Rank('common', docs);
            expect(rareScore[0]!.score).toBeGreaterThan(commonScore[0]!.score);
        });
    });

    describe('multilingual coverage', () => {
        it('matches CJK candidates via bigram tokenisation', () => {
            const docs = [
                '整理项目笔记的标签',
                '不相关的内容关于烹饪',
                '为笔记添加自定义标签',
            ];
            const out = bm25Rank('标签 笔记', docs);
            // Docs 0 and 2 share bigrams with the query; doc 1 should
            // not appear in the result.
            const indices = out.map(r => r.index);
            expect(indices).toContain(0);
            expect(indices).toContain(2);
            expect(indices).not.toContain(1);
        });

        it('matches mixed CJK + ASCII queries', () => {
            const docs = [
                'fix tags 标签 on project notes',
                'unrelated cooking 烹饪 article',
            ];
            const out = bm25Rank('标签 tags', docs);
            expect(out[0]!.index).toBe(0);
        });
    });

    describe('parameter knobs', () => {
        it('honours custom k1 and b', () => {
            const docs = ['hello world', 'hello hello world'];
            const baseline = bm25Rank('hello', docs);
            // With b=0 (no length normalisation) and high k1, TF
            // dominates and doc 1 should clearly outrank doc 0.
            const tuned = bm25Rank('hello', docs, { k1: 3.0, b: 0 });
            // Compare the score gap between docs 0 and 1 in baseline vs tuned.
            const baseGap = Math.abs(baseline[0]!.score - baseline[1]!.score);
            const tunedGap = Math.abs(tuned[0]!.score - tuned[1]!.score);
            expect(tunedGap).toBeGreaterThan(baseGap);
        });
    });
});
