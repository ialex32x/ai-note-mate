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
});
