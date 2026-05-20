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
    it('does not treat YAML tag lists inside fenced blocks as follow-ups', () => {
        const md = [
            '已搞定。`summary` 已添加到 frontmatter：',
            '',
            '```yaml',
            '---',
            'tags:',
            '  - app/p4',
            '  - topic/tech',
            'summary: Perforce 核心概念速查（面向 Git 迁移者）：Changelist 是全局递增整数的原子提交单位（无本地 commit）；Shelve 相当于服务端 stash 可跨 workspace；Stream 是推荐的声明式分支方案（按类型+层级约束 merge 方向）；父→子用 p4 merge、子→父用 p4 copy。',
            '---',
            '```',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([]);
    });

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

    it('does not treat descriptive "标签说明：" glossaries as follow-ups', () => {
        const md = [
            '已更新 frontmatter。',
            '',
            '标签说明：',
            '',
            '- resources/food — 饮食类资源笔记',
            '- topic/culture — 饮食文化主题',
            '- topic/tcm — 涉及中医寒性食物、驱寒等概念',
            '- location/shanghai — 以上海为核心的江南时令文化',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([]);
    });

    it('still extracts colon-led lists when the intro invites a next step', () => {
        const md = [
            '正文结束。',
            '',
            '你可以尝试：',
            '',
            '- 按季节整理一版索引',
            '- 把相关笔记链到这篇',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: '按季节整理一版索引', prompt: '按季节整理一版索引' },
            { label: '把相关笔记链到这篇', prompt: '把相关笔记链到这篇' },
        ]);
    });
});

describe('extractSuggestions / closing-question splitter', () => {
    it('splits a "需要我 A，或者 B 吗?" offer into two parallel options', () => {
        const md = [
            '这是回答正文。',
            '',
            '需要我帮你整理成笔记，或者继续生成更多内容吗？',
        ].join('\n');

        const out = extractSuggestions(md, { allowStructured: true });
        // The chip label keeps the AI-facing "帮你 …" phrasing so it reads
        // as a proposal; the outgoing prompt is rewritten to first person
        // ("帮我 …") so when sent back to the model it reads as the user
        // accepting / instructing, not echoing the AI's question.
        expect(out).toEqual([
            { label: '帮你整理成笔记', prompt: '帮我整理成笔记' },
            { label: '继续生成更多内容', prompt: '继续生成更多内容' },
        ]);
    });

    it('handles the "或者" connector without a leading comma', () => {
        const md = '要不要我先列大纲或者直接展开正文呢？';

        const out = extractSuggestions(md, { allowStructured: true });
        // No 2nd-person pronouns to swap → label and prompt stay identical.
        expect(out).toEqual([
            { label: '先列大纲', prompt: '先列大纲' },
            { label: '直接展开正文', prompt: '直接展开正文' },
        ]);
    });

    it('splits on "还是" as an or-choice connector inside an offer', () => {
        const md = '要不要我先整理大纲还是直接展开正文？';

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: '先整理大纲', prompt: '先整理大纲' },
            { label: '直接展开正文', prompt: '直接展开正文' },
        ]);
    });

    it('splits an English "Should I A, or B?" offer', () => {
        const md = 'Should I summarize the article, or generate more content?';

        const out = extractSuggestions(md, { allowStructured: true });
        // No "you/your" inside either option → label and prompt stay
        // identical for both.
        expect(out).toEqual([
            { label: 'summarize the article', prompt: 'summarize the article' },
            { label: 'generate more content', prompt: 'generate more content' },
        ]);
    });

    it('cleans a single-suggestion fallback by stripping the offer prefix and yes/no tail', () => {
        const md = '需要我先帮你整理大纲吗？';

        const out = extractSuggestions(md, { allowStructured: true });
        // Single-suggestion path now strips the recognised "需要我" prefix
        // and the trailing "吗？", and swaps "你" → "我" in the prompt so
        // the outgoing message reads as the user instructing the assistant.
        expect(out).toEqual([
            { label: '先帮你整理大纲', prompt: '先帮我整理大纲' },
        ]);
    });

    it('cleans the user-supplied food-recommendation offer (regression)', () => {
        // Regression for the original example that motivated the prompt
        // rewrite: both the leading "帮你" and the possessive "你附近" should
        // flip to "帮我" / "我附近" in the outgoing prompt so the model gets
        // a clean first-person instruction rather than an echoed question.
        const md = '要不要我帮你整理一份你附近值得一试的生煎/小馄饨推荐？';

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            {
                label: '帮你整理一份你附近值得一试的生煎/小馄饨推荐',
                prompt: '帮我整理一份我附近值得一试的生煎/小馄饨推荐',
            },
        ]);
    });

    it('cleans an English single-suggestion fallback and swaps you/your', () => {
        const md = 'Would you like me to summarize your meeting notes?';

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            {
                label: 'summarize your meeting notes',
                prompt: 'summarize my meeting notes',
            },
        ]);
    });

    it('swaps multiple 2nd-person references inside a single offer (你的 + 你 …)', () => {
        // Both the leading "帮你" and the inner possessive "你的" should flip
        // to first person in the outgoing prompt.
        const md = '需要我帮你检查你的代码吗？';

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: '帮你检查你的代码', prompt: '帮我检查我的代码' },
        ]);
    });

    it('keeps the whole sentence when the offer prefix does not sit at the start', () => {
        // "对了" is filler, not a recognised offer prefix — the candidate no
        // longer starts with `需要我`, so the splitter bails and the
        // single-suggestion path can't safely identify the action portion,
        // so it preserves the original sentence verbatim for both fields.
        const md = '对了，需要我帮你整理成笔记，或者继续生成更多内容吗？';

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            {
                label: '对了，需要我帮你整理成笔记，或者继续生成更多内容吗？',
                prompt: '对了，需要我帮你整理成笔记，或者继续生成更多内容吗？',
            },
        ]);
    });

    it('keeps Japanese sentence-final offers as a verbatim single suggestion', () => {
        // `しましょうか` is in SINGLE_QUESTION_HINTS but intentionally not in
        // OFFER_PREFIXES_AT_START (it sits at the end, not the start), so the
        // splitter must not fire here. Without a strippable prefix the
        // single-suggestion path also can't safely clean the action portion,
        // so the verbatim fallback applies and label === prompt.
        const md = '整理しましょうか？';

        const out = extractSuggestions(md, { allowStructured: true });
        expect(out).toEqual([
            { label: '整理しましょうか？', prompt: '整理しましょうか？' },
        ]);
    });

    it('still rejects ambiguous "A？或者 B？" closers with multiple question marks', () => {
        const md = '需要我帮你整理成笔记？或者继续生成更多内容？';

        const out = extractSuggestions(md, { allowStructured: true });
        // Two question marks → original guard rejects the candidate entirely.
        expect(out).toEqual([]);
    });
});
