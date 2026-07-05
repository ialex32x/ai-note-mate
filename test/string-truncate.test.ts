import { describe, it, expect } from 'vitest';
import { truncate } from '../src/utils/string-truncate';

describe('truncate', () => {
    it('should return the string unchanged when shorter than max', () => {
        expect(truncate('hello', 10)).toBe('hello');
    });

    it('should return the string unchanged when equal to max', () => {
        expect(truncate('hello', 5)).toBe('hello');
    });

    it('should truncate with ellipsis when longer than max', () => {
        const result = truncate('hello world', 8);
        expect(result).toHaveLength(8);
        expect(result).toMatch(/…$/); // ends with ellipsis
        expect(result).toBe('hello w…');
    });

    it('should trim trailing whitespace before ellipsis', () => {
        const result = truncate('hello world!!!', 10);
        expect(result).toBe('hello wor…');
    });

    it('should return empty string when max <= 0', () => {
        expect(truncate('hello', 0)).toBe('');
        expect(truncate('hello', -1)).toBe('');
    });

    it('should handle empty string', () => {
        expect(truncate('', 10)).toBe('');
    });

    it('should not split a surrogate pair (emoji)', () => {
        // 🔧 is U+1F527 (surrogate pair: \uD83D\uDD27)
        const emoji = '🔧';
        const s = 'a' + emoji + 'b'; // length 4 (1 + surrogate pair + 1)
        expect(s.length).toBe(4);

        // max=3: cut would land on the high surrogate → drop it
        const result = truncate(s, 3);
        expect(result.length).toBeLessThanOrEqual(3);
        // The 'a' stays, the emoji pair is dropped, 'b' is gone, ends with …
        expect(result).toBe('a…');
    });

    it('should handle CJK characters correctly', () => {
        const s = '你好世界'; // 4 CJK chars
        const result = truncate(s, 3);
        expect(result.length).toBe(3);
        expect(result).toBe('你好…');
    });

    it('should handle very short max', () => {
        const result = truncate('hello', 1);
        expect(result).toBe('…');
    });

    it('should handle max=1 with emoji', () => {
        // 🔧 is U+1F527 (length 2). max=1 → cut before high surrogate → empty + ellipsis
        const result = truncate('🔧x', 1);
        expect(result).toBe('…');
    });

    it('should handle emoji without splitting boundary when there is room', () => {
        const result = truncate('a🔧b', 4);
        // 'a' + emoji(surrogate pair) = 3 chars, fits in max=4 with ellipsis... 
        // Actually length 4 - 1 = 3, so it should be 'a' + emoji = 'a🔧'
        // Wait, let me think: s = 'a🔧b', s.length = 4 (a + \uD83D + \uDD27 + b)
        // max=4, s.length<=max so returns s unchanged
        expect(result).toBe('a🔧b');
    });

    it('should handle very long strings', () => {
        const longStr = 'x'.repeat(10000);
        const result = truncate(longStr, 100);
        expect(result.length).toBe(100);
        expect(result.charAt(98)).toBe('x');
        expect(result.charAt(99)).toBe('…');
    });
});
