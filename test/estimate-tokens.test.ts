import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../src/services/context-compression';

describe('estimateTokens', () => {
    it('should estimate tokens for pure Latin text (~4 chars per token)', () => {
        const text = 'Hello world'; // 11 chars → ceil(11/4) = 3
        expect(estimateTokens(text)).toBe(3);
    });

    it('should estimate tokens for pure CJK text (~1.5 chars per token)', () => {
        const text = '你好世界'; // 4 CJK chars → ceil(4/1.5) = 3
        expect(estimateTokens(text)).toBe(3);
    });

    it('should handle mixed Latin and CJK text', () => {
        const text = 'Hello你好'; // 5 Latin + 2 CJK → ceil(2/1.5 + 5/4) = ceil(1.33 + 1.25) = 3
        expect(estimateTokens(text)).toBe(3);
    });

    it('should return 0 for empty string', () => {
        expect(estimateTokens('')).toBe(0);
    });

    it('should handle long text proportionally', () => {
        const text = 'a'.repeat(4000); // 4000 Latin chars → ceil(4000/4) = 1000
        expect(estimateTokens(text)).toBe(1000);
    });

    // The following cases pin the character classification boundaries so
    // future changes to `estimateTokens` (e.g. the single-pass rewrite that
    // replaced the three-regex implementation) cannot silently drift.
    it('should ignore whitespace including tabs, CRLF, and NBSP', () => {
        // 4 CJK chars + assorted whitespace → whitespace contributes 0
        const text = '你\t好\r\n世 界\u00A0';
        expect(estimateTokens(text)).toBe(3); // ceil(4/1.5) = 3
    });

    it('should count Hiragana and Katakana as CJK', () => {
        const text = 'こんにちはカタカナ'; // 9 kana → ceil(9/1.5) = 6
        expect(estimateTokens(text)).toBe(6);
    });

    it('should count Hangul syllables as CJK', () => {
        const text = '안녕하세요'; // 5 Hangul → ceil(5/1.5) = 4
        expect(estimateTokens(text)).toBe(4);
    });

    it('should count each punctuation/symbol as one token', () => {
        const text = '!?.,;:'; // 6 punct chars → 6 tokens
        expect(estimateTokens(text)).toBe(6);
    });

    it('should count each surrogate half of an emoji as punctuation', () => {
        // Matches the pre-existing regex behaviour: `[^...cjk...alnum...ws]`
        // matches both halves of the surrogate pair individually.
        const text = '😀'; // 2 UTF-16 code units, neither is CJK/alnum/ws → 2 tokens
        expect(estimateTokens(text)).toBe(2);
    });
});
