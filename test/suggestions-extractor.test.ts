import { describe, it, expect } from 'vitest';
import { extractSuggestions } from '../src/services/suggestions/extractor';

describe('extractSuggestions / structured block', () => {
    it('keeps entries whose label and prompt differ', () => {
        const md = [
            'Some answer body.',
            '',
            '<!--suggestions',
            '- label: 总结要点',
            '  prompt: 请把上面的内容总结成 5 条要点',
            '- label: 翻译为英文',
            '  prompt: 请将以上中文内容翻译为英文',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: '总结要点', prompt: '请把上面的内容总结成 5 条要点' },
            { label: '翻译为英文', prompt: '请将以上中文内容翻译为英文' },
        ]);
    });

    it('drops entries where label and prompt are identical (format violation)', () => {
        const md = [
            '<!--suggestions',
            '- label: 以上就是今天的主要新闻',
            '  prompt: 以上就是今天的主要新闻',
            '- label: 总结要点',
            '  prompt: 请把上面的内容总结成 5 条要点',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: '总结要点', prompt: '请把上面的内容总结成 5 条要点' },
        ]);
    });

    it('treats label/prompt equality case- and whitespace-insensitively', () => {
        const md = [
            '<!--suggestions',
            '- label: Summarize Notes',
            '  prompt: summarize   notes',
            '- label: Translate',
            '  prompt: Please translate the text above',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: 'Translate', prompt: 'Please translate the text above' },
        ]);
    });

    it('returns empty list when every structured entry violates the format', () => {
        const md = [
            '<!--suggestions',
            '- label: 这是一段说明',
            '  prompt: 这是一段说明',
            '- label: 仅供参考',
            '  prompt: 仅供参考',
            '-->',
        ].join('\n');

        // Note: when structured parsing yields nothing the extractor falls back
        // to the heuristic path. The body above contains no follow-up header
        // and no list at the tail, so the fallback should also produce nothing.
        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([]);
    });
});

describe('extractSuggestions / heuristic fallback', () => {
    it('still allows label === prompt for list-based heuristics', () => {
        const md = [
            '这是回答正文。',
            '',
            '你接下来可能想：',
            '',
            '- 总结要点',
            '- 翻译为英文',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        // Heuristic path intentionally uses the same text for label and prompt;
        // the structured-only filter must not affect it.
        expect(out.length).toBeGreaterThanOrEqual(2);
        expect(out[0]).toEqual({ label: '总结要点', prompt: '总结要点' });
        expect(out[1]).toEqual({ label: '翻译为英文', prompt: '翻译为英文' });
    });
});
