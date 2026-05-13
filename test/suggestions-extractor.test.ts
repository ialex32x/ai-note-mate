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

describe('extractSuggestions / structured block — client actions', () => {
    it('parses an open-note action with a plain path', () => {
        const md = [
            '<!--suggestions',
            '- label: Open Project plan',
            '  prompt: Open the note "Project plan".',
            '  action: open-note',
            '  path: Projects/Project plan.md',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            {
                label: 'Open Project plan',
                prompt: 'Open the note "Project plan".',
                action: { kind: 'open-note', path: 'Projects/Project plan.md' },
            },
        ]);
    });

    it('strips wiki-link and quote decorations from the path', () => {
        const md = [
            '<!--suggestions',
            '- label: Open wiki',
            '  prompt: Please open the wiki note.',
            '  action: open-note',
            '  path: [[Projects/Wiki|Display Alias]]',
            '- label: Open quoted',
            '  prompt: Please open the quoted note.',
            '  action: open-note',
            '  path: "My Note.md"',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out[0]?.action).toEqual({ kind: 'open-note', path: 'Projects/Wiki' });
        expect(out[1]?.action).toEqual({ kind: 'open-note', path: 'My Note.md' });
    });

    it('accepts action/path in any order before or after prompt', () => {
        const md = [
            '<!--suggestions',
            '- label: Open note A',
            '  action: open-note',
            '  path: Notes/A.md',
            '  prompt: Open note A please.',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            {
                label: 'Open note A',
                prompt: 'Open note A please.',
                action: { kind: 'open-note', path: 'Notes/A.md' },
            },
        ]);
    });

    it('is case-insensitive for the action kind and tolerates variants', () => {
        const md = [
            '<!--suggestions',
            '- label: Open A',
            '  prompt: Please open note A.',
            '  action: Open-Note',
            '  path: A.md',
            '- label: Open B',
            '  prompt: Please open note B.',
            '  action: open_note',
            '  path: B.md',
            '- label: Open C',
            '  prompt: Please open note C.',
            '  action: OPENNOTE',
            '  path: C.md',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toHaveLength(3);
        expect(out[0]?.action).toEqual({ kind: 'open-note', path: 'A.md' });
        expect(out[1]?.action).toEqual({ kind: 'open-note', path: 'B.md' });
        expect(out[2]?.action).toEqual({ kind: 'open-note', path: 'C.md' });
    });

    it('falls back to prompt-only entry when action kind is unknown', () => {
        const md = [
            '<!--suggestions',
            '- label: Do magic',
            '  prompt: Please do some magic.',
            '  action: run-unknown-thing',
            '  path: whatever.md',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: 'Do magic', prompt: 'Please do some magic.' },
        ]);
    });

    it('falls back to prompt-only entry when path is missing for open-note', () => {
        const md = [
            '<!--suggestions',
            '- label: Open something',
            '  prompt: Please open something.',
            '  action: open-note',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: 'Open something', prompt: 'Please open something.' },
        ]);
    });

    it('preserves spaces inside paths and does not strip wiki-link inner alias', () => {
        const md = [
            '<!--suggestions',
            '- label: Open note',
            '  prompt: Open the note.',
            '  action: open-note',
            '  path: Daily notes/2025-01-02.md',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out[0]?.action).toEqual({
            kind: 'open-note',
            path: 'Daily notes/2025-01-02.md',
        });
    });

    it('does not emit an action field when none is specified', () => {
        const md = [
            '<!--suggestions',
            '- label: Summarize',
            '  prompt: Please summarize the content above.',
            '-->',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: 'Summarize', prompt: 'Please summarize the content above.' },
        ]);
        // Explicit guard: the `action` key must be absent, not just `undefined`,
        // so serialization stays clean.
        expect('action' in (out[0] ?? {})).toBe(false);
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
