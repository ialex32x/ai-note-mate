import { describe, it, expect } from 'vitest';
import {
    findAllOccurrences,
    findAllOccurrencesRegex,
    findAllRegexMatches,
    replaceWithGroups,
    looksLikeRegex,
    looksLikeHarmlessBrackets,
    regexHintForLiteral,
} from '../src/utils/regex-utils';

describe('findAllOccurrences', () => {
    it('should find all non-overlapping literal occurrences', () => {
        expect(findAllOccurrences('hello hello hello', 'hello')).toEqual([0, 6, 12]);
    });

    it('should skip overlapping occurrences', () => {
        expect(findAllOccurrences('aaaa', 'aa')).toEqual([0, 2]);
    });

    it('should return empty array when not found', () => {
        expect(findAllOccurrences('hello world', 'xyz')).toEqual([]);
    });

    it('should handle empty haystack', () => {
        expect(findAllOccurrences('', 'a')).toEqual([]);
    });

    it('should handle empty needle', () => {
        expect(findAllOccurrences('hello', '')).toEqual([]);
    });

    it('should find single occurrence at start', () => {
        expect(findAllOccurrences('abc', 'ab')).toEqual([0]);
    });

    it('should find single occurrence at end', () => {
        expect(findAllOccurrences('abc', 'bc')).toEqual([1]);
    });

    it('should handle case-sensitive matching', () => {
        expect(findAllOccurrences('Hello hello', 'hello')).toEqual([6]);
    });
});

describe('findAllOccurrencesRegex', () => {
    it('should find all regex matches', () => {
        const result = findAllOccurrencesRegex('hello world hello', 'hello');
        expect(result).toEqual([{ start: 0, end: 5 }, { start: 12, end: 17 }]);
    });

    it('should skip zero-length matches', () => {
        const result = findAllOccurrencesRegex('abc', '');
        expect(result).toEqual([]);
    });

    it('should handle multiline strings', () => {
        const result = findAllOccurrencesRegex('line1\nline2\nline3', '^line');
        expect(result).toHaveLength(3);
    });

    it('should return empty array for no matches', () => {
        expect(findAllOccurrencesRegex('hello', 'xyz')).toEqual([]);
    });

    it('should handle special regex characters', () => {
        const result = findAllOccurrencesRegex('a.b a.b', 'a\\.b');
        expect(result).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
    });
});

describe('findAllRegexMatches', () => {
    it('should find matches with captured groups', () => {
        const result = findAllRegexMatches('hello 42 world', '(\\d+)');
        expect(result).toHaveLength(1);
        expect(result[0]!.start).toBe(6);
        expect(result[0]!.end).toBe(8);
        expect(result[0]!.groups[0]).toBe('42');
        expect(result[0]!.groups[1]).toBe('42');
    });

    it('should capture multiple groups', () => {
        const result = findAllRegexMatches('2024-01-15', '(\\d{4})-(\\d{2})-(\\d{2})');
        expect(result).toHaveLength(1);
        expect(result[0]!.groups[1]).toBe('2024');
        expect(result[0]!.groups[2]).toBe('01');
        expect(result[0]!.groups[3]).toBe('15');
    });

    it('should skip zero-length matches', () => {
        const result = findAllRegexMatches('abc', '');
        expect(result).toEqual([]);
    });
});

describe('replaceWithGroups', () => {
    it('should replace $1 with first capture group', () => {
        const match = { start: 0, end: 3, groups: ['foo', 'foo'] };
        expect(replaceWithGroups('($1)', 'foo bar', match)).toBe('(foo)');
    });

    it('should replace $& with full match', () => {
        const match = { start: 0, end: 5, groups: ['hello'] };
        expect(replaceWithGroups('found: $&', 'hello world', match)).toBe('found: hello');
    });

    it('should replace $` with text before match', () => {
        const match = { start: 6, end: 11, groups: ['world'] };
        expect(replaceWithGroups("before: $`", 'hello world', match)).toBe('before: hello ');
    });

    it("should replace $' with text after match", () => {
        const match = { start: 0, end: 5, groups: ['hello'] };
        expect(replaceWithGroups("after: $'", 'hello world', match)).toBe('after:  world');
    });

    it('should replace $$ with literal $', () => {
        const match = { start: 0, end: 5, groups: ['hello'] };
        expect(replaceWithGroups('price: $$5', 'hello world', match)).toBe('price: $5');
    });

    it('should handle undefined groups as empty string', () => {
        const match = { start: 0, end: 3, groups: ['abc', 'abc', undefined] };
        expect(replaceWithGroups('$1-$2', 'abc def', match)).toBe('abc-');
    });

    it('should replace multiple $ references', () => {
        const match = { start: 0, end: 5, groups: ['hello', 'hello'] };
        expect(replaceWithGroups('$1 world', 'hello world', match)).toBe('hello world');
    });
});

describe('looksLikeHarmlessBrackets', () => {
    it('should detect [[wikilinks]]', () => {
        expect(looksLikeHarmlessBrackets('[[note title]]')).toBe(true);
    });

    it('should detect [text](url) markdown links', () => {
        expect(looksLikeHarmlessBrackets('[click here](https://example.com)')).toBe(true);
    });

    it('should detect Obsidian callouts', () => {
        expect(looksLikeHarmlessBrackets('> [!note]')).toBe(true);
        expect(looksLikeHarmlessBrackets('> [!warning]+')).toBe(true);
    });

    it('should detect task checkboxes', () => {
        expect(looksLikeHarmlessBrackets('- [ ] task')).toBe(true);
        expect(looksLikeHarmlessBrackets('- [x] done')).toBe(true);
        expect(looksLikeHarmlessBrackets('* [ ] item')).toBe(true);
        expect(looksLikeHarmlessBrackets('1. [x] completed')).toBe(true);
    });

    it('should detect YAML arrays', () => {
        expect(looksLikeHarmlessBrackets('[a, b, c]')).toBe(true);
    });

    it('should return false for regex-like bracket usage', () => {
        expect(looksLikeHarmlessBrackets('[abc]')).toBe(false);
        expect(looksLikeHarmlessBrackets('[^x]')).toBe(false);
    });
});

describe('looksLikeRegex', () => {
    it('should detect escaped character classes', () => {
        expect(looksLikeRegex('\\d+')).toBe(true);
        expect(looksLikeRegex('\\w+')).toBe(true);
        expect(looksLikeRegex('\\s*')).toBe(true);
    });

    it('should detect escaped brackets/parens', () => {
        expect(looksLikeRegex('\\(DevRoot\\)')).toBe(true);
        expect(looksLikeRegex('\\[section\\]')).toBe(true);
    });

    it('should detect escaped metacharacters', () => {
        expect(looksLikeRegex('\\+')).toBe(true);
        expect(looksLikeRegex('\\*')).toBe(true);
        expect(looksLikeRegex('\\.')).toBe(true);
    });

    it('should detect lazy quantifiers', () => {
        expect(looksLikeRegex('.*?')).toBe(true);
        expect(looksLikeRegex('.+?')).toBe(true);
    });

    it('should detect bare character classes (non-harmless)', () => {
        expect(looksLikeRegex('[abc]')).toBe(true);
        expect(looksLikeRegex('[^xyz]')).toBe(true);
    });

    it('should return false for harmless bracket usage', () => {
        expect(looksLikeRegex('[[wikilink]]')).toBe(false);
        expect(looksLikeRegex('[text](url)')).toBe(false);
        expect(looksLikeRegex('- [ ] task')).toBe(false);
    });

    it('should return false for plain text', () => {
        expect(looksLikeRegex('hello world')).toBe(false);
        expect(looksLikeRegex('TODO')).toBe(false);
    });

    it('should return false for numbers and simple punctuation', () => {
        expect(looksLikeRegex('42')).toBe(false);
        expect(looksLikeRegex('1.5')).toBe(false); // standalone dot not escaped
    });
});

describe('regexHintForLiteral', () => {
    it('should return empty string for non-regex patterns', () => {
        expect(regexHintForLiteral('hello')).toBe('');
    });

    it('should return a hint for regex-like patterns', () => {
        const hint = regexHintForLiteral('\\d+');
        expect(hint).toContain('HINT');
        expect(hint).toContain('use_regex');
    });

    it('should mention detected constructs', () => {
        const hint = regexHintForLiteral('\\(DevRoot\\)');
        expect(hint).toContain('escaped brackets');
    });

    it('should mention character class when detected', () => {
        const hint = regexHintForLiteral('[abc]');
        expect(hint).toContain('character class');
    });
});
