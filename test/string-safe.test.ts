import { describe, it, expect } from 'vitest';
import { safeSliceHead, safeSliceTail, stripLoneSurrogates } from '../src/utils/string-safe';

// 🔧 is U+1F527 → surrogate pair: \uD83D\uDD27
const EMOJI = '🔧';
const EMOJI_LEN = 2; // surrogate pair length in UTF-16

describe('safeSliceHead', () => {
    it('should return first n characters for a simple ASCII string', () => {
        expect(safeSliceHead('hello world', 5)).toBe('hello');
    });

    it('should return the whole string when shorter than n', () => {
        expect(safeSliceHead('hi', 10)).toBe('hi');
    });

    it('should return empty string when n <= 0', () => {
        expect(safeSliceHead('hello', 0)).toBe('');
        expect(safeSliceHead('hello', -1)).toBe('');
    });

    it('should handle empty string', () => {
        expect(safeSliceHead('', 5)).toBe('');
    });

    it('should drop the high surrogate when cut lands in the middle of a pair', () => {
        // 'a' + emoji = length 3
        const s = 'a' + EMOJI;
        expect(s.length).toBe(1 + EMOJI_LEN);

        // Cut at n=2 would land on the high surrogate → drop it, return 'a'
        const result = safeSliceHead(s, 2);
        expect(result).toBe('a');
    });

    it('should include the full surrogate pair when cut lands after it', () => {
        const s = 'a' + EMOJI + 'b';
        // n=4 includes everything
        const result = safeSliceHead(s, 4);
        expect(result).toBe(s);
    });

    it('should include the full surrogate pair when cut is exactly at pair end', () => {
        const s = 'a' + EMOJI;
        // n=3: a + emoji pair = 3, fits exactly
        const result = safeSliceHead(s, 3);
        expect(result).toBe(s);
    });

    it('should handle multiple emoji characters', () => {
        const s = EMOJI + EMOJI + 'abc';
        // n=4: first emoji(2) + second emoji high surrogate(1) = 3 → return first emoji + ... 
        // Actually n=4: indexes 0,1=first emoji, 2,3=second emoji high surrogate at index 2
        // charCodeAt(3) = low surrogate (0xDD27), not high surrogate → no adjustment
        // Wait, let me be more careful:
        // EMOJI = \uD83D\uDD27 (2 code units)
        // s = \uD83D\uDD27\uD83D\uDD27abc (length = 2+2+3 = 7)
        // n=4: s.charCodeAt(3) = 0xDD27 which is 0xDC00-0xDFFF (LOW surrogate), not high
        // So it returns s.slice(0, 4) = '\uD83D\uDD27\uD83D' which has a lone high surrogate!
        // This is expected behavior - safeSliceHead only protects against HIGH surrogate
        // at the boundary (n-1 index). The low surrogate at n-1 position (index 3) doesn't trigger.
        // Actually wait, let me re-read: the function checks charCodeAt(n-1) for being a HIGH surrogate.
        // n=4, n-1=3, charCodeAt(3)=0xDD27 which is LOW surrogate (0xDC00-0xDFFF)
        // The check is: code >= 0xd800 && code <= 0xdbff → false for low surrogate
        // So it returns slice(0,4) which splits the pair. 
        // Hmm, this is a test that reveals the function's design. The function intentionally only
        // protects against cutting AFTER a high surrogate (i.e., the high surrogate being the last
        // code unit of the slice). A low surrogate at the boundary means the slice starts with
        // a full pair that we preserve.
        // Let me fix the test to match actual behavior.
        const s2 = EMOJI + EMOJI + 'abc';
        // s2[0..1] = first emoji (full pair)
        // s2[2..3] = second emoji (full pair) 
        // s2[4..6] = 'abc'
        // When n=4: charCodeAt(3) = \uDD27 = low surrogate → not high → no adjustment
        // returns slice(0,4) = first emoji(0-1) + second emoji(2-3) = both emoji
        const result = safeSliceHead(s2, 4);
        expect(result).toBe(EMOJI + EMOJI);
    });

    it('should handle CJK characters (not affected by surrogate logic)', () => {
        // CJK characters are in the BMP, no surrogate pairs
        const s = '你好世界';
        expect(s.length).toBe(4);
        expect(safeSliceHead(s, 2)).toBe('你好');
    });
});

describe('safeSliceTail', () => {
    it('should return last n characters for a simple ASCII string', () => {
        expect(safeSliceTail('hello world', 5)).toBe('world');
    });

    it('should return the whole string when shorter than n', () => {
        expect(safeSliceTail('hi', 10)).toBe('hi');
    });

    it('should return empty string when n <= 0', () => {
        expect(safeSliceTail('hello', 0)).toBe('');
        expect(safeSliceTail('hello', -1)).toBe('');
    });

    it('should handle empty string', () => {
        expect(safeSliceTail('', 5)).toBe('');
    });

    it('should drop the low surrogate when cut lands in the middle of a pair', () => {
        const s = EMOJI + 'b';
        // s = \uD83D\uDD27b (length 3), n=2
        // start = 3-2 = 1, charCodeAt(1) = 0xDD27 = low surrogate → drop it
        // returns slice(2) = 'b'
        const result = safeSliceTail(s, 2);
        expect(result).toBe('b');
    });

    it('should return the full pair when there is room', () => {
        const s = 'a' + EMOJI + 'b';
        // length = 4
        // n=3: start = 1, charCodeAt(1) = 0xDD27... wait, charCodeAt(1) = high surrogate
        // The check is: code >= 0xdc00 && code <= 0xdfff → false for high surrogate (0xD83D)
        // So no adjustment, returns slice(1) = emoji + 'b'

        // Let me think about this differently:
        // s = 'a\uD83D\uDD27b'  length = 4
        // n=3: start = 4-3 = 1
        // s.charCodeAt(1) = 0xD83D (HIGH surrogate) 
        // check: >= 0xDC00? false. So no adjustment.
        // returns s.slice(1) = '\uD83D\uDD27b' = emoji + 'b' ✓
        const result = safeSliceTail(s, 3);
        expect(result).toBe(EMOJI + 'b');
    });

    it('should include the full pair at the start', () => {
        const s = EMOJI + 'bc';
        // length = 4, n=4: returns whole string
        expect(safeSliceTail(s, 4)).toBe(s);
    });

    it('should handle CJK characters', () => {
        const s = '你好世界';
        expect(safeSliceTail(s, 2)).toBe('世界');
    });
});

describe('stripLoneSurrogates', () => {
    it('should leave a clean ASCII string unchanged', () => {
        expect(stripLoneSurrogates('hello world')).toBe('hello world');
    });

    it('should leave a valid surrogate pair (emoji) unchanged', () => {
        expect(stripLoneSurrogates('a' + EMOJI + 'b')).toBe('a' + EMOJI + 'b');
    });

    it('should strip a lone high surrogate', () => {
        const loneHigh = 'a\uD83Db'; // 'a' + high surrogate + 'b'
        expect(stripLoneSurrogates(loneHigh)).toBe('ab');
    });

    it('should strip a lone low surrogate', () => {
        const loneLow = 'a\uDEADb'; // 'a' + low surrogate + 'b'
        expect(stripLoneSurrogates(loneLow)).toBe('ab');
    });

    it('should handle multiple lone surrogates', () => {
        const s = '\uD83Da\uDEAD\uD83D\uDD27b\uDEAD';
        // \uD83D = lone high, a = 'a', \uDEAD = lone low,
        // \uD83D\uDD27 = valid emoji pair, b = 'b', \uDEAD = lone low
        const result = stripLoneSurrogates(s);
        expect(result).toBe('a' + EMOJI + 'b');
    });

    it('should handle empty string', () => {
        expect(stripLoneSurrogates('')).toBe('');
    });

    it('should keep a valid surrogate pair', () => {
        // \uD800\uDC00 = U+10000, a valid character (LINEAR B SYLLABLE B008 A)
        expect(stripLoneSurrogates('\uD800\uDC00')).toBe('\uD800\uDC00');
    });

    it('should strip lone high surrogate', () => {
        expect(stripLoneSurrogates('\uD800')).toBe('');
    });

    it('should strip lone low surrogate', () => {
        expect(stripLoneSurrogates('\uDC00')).toBe('');
    });

    it('should be a no-op on strings without any surrogates', () => {
        const s = 'Normal ASCII and CJK: 你好世界';
        expect(stripLoneSurrogates(s)).toBe(s);
    });

    it('should handle CJK (BMP) characters mixed with lone surrogates', () => {
        const s = '\uD83D你好\uDEAD世界';
        const result = stripLoneSurrogates(s);
        expect(result).toBe('你好世界');
    });
});
