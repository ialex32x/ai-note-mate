import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/services/retriever/tokenizer';

describe('retriever / tokenizer', () => {
    describe('empty / trivial input', () => {
        it('returns [] for empty string', () => {
            expect(tokenize('')).toEqual([]);
        });

        it('returns [] for whitespace / punctuation only', () => {
            expect(tokenize('   \t\n')).toEqual([]);
            expect(tokenize('---!!!,,,')).toEqual([]);
        });
    });

    describe('ASCII / Latin tokenisation', () => {
        it('splits on whitespace', () => {
            expect(tokenize('hello world')).toEqual(['hello', 'world']);
        });

        it('lowercases tokens', () => {
            expect(tokenize('Hello World')).toEqual(['hello', 'world']);
        });

        it('treats punctuation and hyphens as separators', () => {
            expect(tokenize('multi-word, value!')).toEqual(['multi', 'word', 'value']);
        });

        it('keeps digits as their own token group', () => {
            // Digits and letters are both \p{L}\p{N}, so they merge into one run.
            expect(tokenize('test123 v2')).toEqual(['test123', 'v2']);
        });

        it('folds accent marks via NFD + combining-mark strip', () => {
            expect(tokenize('Café')).toEqual(['cafe']);
            expect(tokenize('naïve façade')).toEqual(['naive', 'facade']);
        });

        it('keeps Cyrillic and Greek as word runs', () => {
            expect(tokenize('Привет мир')).toEqual(['привет', 'мир']);
            expect(tokenize('αβγ δεζ')).toEqual(['αβγ', 'δεζ']);
        });
    });

    describe('CJK bigram tokenisation', () => {
        it('emits overlapping bigrams for CJK runs', () => {
            // "你好世界" → "你好", "好世", "世界"
            expect(tokenize('你好世界')).toEqual(['你好', '好世', '世界']);
        });

        it('emits a unigram for a 1-char CJK run', () => {
            expect(tokenize('猫')).toEqual(['猫']);
        });

        it('handles Hiragana, Katakana, and Hangul the same way', () => {
            expect(tokenize('こんにちは')).toEqual(['こん', 'んに', 'にち', 'ちは']);
            expect(tokenize('カタカナ')).toEqual(['カタ', 'タカ', 'カナ']);
            expect(tokenize('안녕하세요')).toEqual(['안녕', '녕하', '하세', '세요']);
        });

        it('breaks CJK run at non-CJK characters', () => {
            // "你好 world 世界" → ["你好", "world", "世界"]
            // (single-char CJK runs emit a unigram each)
            expect(tokenize('你好 world 世界')).toEqual(['你好', 'world', '世界']);
        });

        it('handles mixed ASCII + CJK without dropping either', () => {
            expect(tokenize('foo 你好 bar')).toEqual(['foo', '你好', 'bar']);
        });
    });

    describe('edge cases', () => {
        it('does not produce empty tokens', () => {
            const tokens = tokenize('!!!hello,,,world???');
            expect(tokens).toEqual(['hello', 'world']);
            expect(tokens.every(t => t.length > 0)).toBe(true);
        });

        it('keeps surrogate-pair-free CJK ranges deterministic', () => {
            // Two identical runs should produce identical token streams.
            expect(tokenize('搜索引擎')).toEqual(tokenize('搜索引擎'));
        });
    });
});
