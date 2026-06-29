import { describe, it, expect } from 'vitest';
import {
    selectMatchingSubAgents,
    refineMatchingSubAgentsSync,
    buildSubAgentCandidateTexts,
} from '../src/services/sub-agent-router';
import { buildDelegationSystemPrompt } from '../src/services/prompts/session-prompts';
import type { SubAgentConfig } from '../src/services/sub-agent';

// ─── Helpers ───────────────────────────────────────────────

function makeConfig(
    name: string,
    description: string,
    keywords: string[] = [],
): SubAgentConfig {
    return {
        name,
        description,
        systemPrompt: `You are ${name}.`,
        tools: [],
        routingKeywords: keywords,
    };
}

const VAULT = makeConfig(
    'vault_inspector',
    'Read-only Obsidian vault inspector. Reads notes, searches by content/path/tag, lists folders, gets metadata, computes overview.',
    ['note', 'notes', 'file', 'files', 'vault', 'read', 'search', 'tag', 'metadata', 'overview', '笔记', '文件', '搜索'],
);

const EDITOR = makeConfig(
    'vault_editor',
    'Rewrites the body of one existing markdown file (reformat, translate, restructure).',
    ['reformat', 'rewrite', 'translate', 'paraphrase', 'polish', '翻译', '改写', '润色'],
);

const WEB = makeConfig(
    'web',
    'Handles web searches, fetching web page content, and internet-based information retrieval.',
    ['search', 'web', 'internet', 'google', 'fetch', 'url', 'website', '网络', '搜索', '网页'],
);

const CODE = makeConfig(
    'code',
    'Handles JavaScript code execution and computation tasks in a sandboxed environment.',
    ['code', 'execute', 'javascript', 'calculate', 'compute', '代码', '执行', '计算'],
);

const ALL = [VAULT, EDITOR, WEB, CODE];

// ─── selectMatchingSubAgents ───────────────────────────────

describe('selectMatchingSubAgents', () => {
    it('returns empty list when no sub-agents are configured', async () => {
        const out = await selectMatchingSubAgents('search the web for X', [], { topK: 2 });
        expect(out).toEqual([]);
    });

    it('drops sub-agents that have no lexical signal in BM25-only mode', async () => {
        // No embedding config supplied → router falls back to BM25.
        // "search the web" has strong hits on the `web` sub-agent
        // ("search" + "web" keywords) and a partial hit on
        // `vault_inspector` ("search"); `vault_editor` and `code` get
        // no hit at all and should drop out at topK=2.
        const out = await selectMatchingSubAgents('search the web for cats', ALL, {
            topK: 2,
        });
        const names = out.map(c => c.name);
        expect(names).toContain('web');
        expect(names).not.toContain('code');
        expect(names.length).toBeLessThanOrEqual(2);
    });

    it('respects the topK cap', async () => {
        const out = await selectMatchingSubAgents('search notes file vault tag metadata', ALL, {
            topK: 1,
        });
        expect(out.length).toBe(1);
        expect(out[0]!.name).toBe('vault_inspector');
    });

    it('unions sticky-on-history names back into the shortlist', async () => {
        // Query matches "web", but vault_inspector has been used
        // earlier in this conversation → must come back regardless of
        // the router's ranking. The retriever-picked candidates come
        // first (so the model sees them at the top), sticky entries
        // are appended afterward.
        const out = await selectMatchingSubAgents('search the web for cats', ALL, {
            topK: 1,
            stickyAgentNames: new Set(['vault_inspector']),
        });
        const names = out.map(c => c.name);
        expect(names).toContain('web');
        expect(names).toContain('vault_inspector');
        // Retriever output must come BEFORE sticky additions so the
        // model's attention is drawn to the most relevant first.
        expect(names.indexOf('web')).toBeLessThan(names.indexOf('vault_inspector'));
    });

    it('does not duplicate when sticky and ranker pick the same agent', async () => {
        const out = await selectMatchingSubAgents('translate this note', ALL, {
            topK: 2,
            stickyAgentNames: new Set(['vault_editor']),
        });
        const names = out.map(c => c.name);
        expect(names.filter(n => n === 'vault_editor').length).toBe(1);
    });

    it('uses the fallback shortlist on short / signal-poor queries', async () => {
        // `isQueryTooShort` is sensitive to character length; a one-
        // character continuation is the canonical short query.
        const lastTurnShortlist = [WEB];
        const out = await selectMatchingSubAgents('y', ALL, {
            topK: 2,
            fallbackOnShortQuery: lastTurnShortlist,
        });
        expect(out.map(c => c.name)).toEqual(['web']);
    });

    it('returns only sticky agents on a short query when no last turn cached', async () => {
        const out = await selectMatchingSubAgents('y', ALL, { topK: 2 });
        // With no prior shortlist and no sticky agents, a short query
        // now returns an empty set rather than the full set — injecting
        // every DELEGATION block on a first-turn "hello" is wasteful.
        expect(out.length).toBe(0);
    });

    it('applies sticky union even on short-query fallback', async () => {
        const out = await selectMatchingSubAgents('y', ALL, {
            topK: 2,
            fallbackOnShortQuery: [WEB],
            stickyAgentNames: new Set(['vault_inspector']),
        });
        const names = out.map(c => c.name);
        expect(names).toContain('web');
        expect(names).toContain('vault_inspector');
    });

    it('clamps topK into the [1, available.length] range', async () => {
        // topK=0 should clamp to 1, topK=999 to ALL.length.
        const clampedLow = await selectMatchingSubAgents('search notes', ALL, { topK: 0 });
        expect(clampedLow.length).toBe(1);

        const clampedHigh = await selectMatchingSubAgents('search notes file vault tag metadata', ALL, {
            topK: 999,
        });
        expect(clampedHigh.length).toBeLessThanOrEqual(ALL.length);
    });

    it('returns the full set in BM25-only mode when zero candidates score', async () => {
        // A query with no overlap with ANY keyword should fall back to
        // the full set in BM25-only mode (no embedding) — dropping all
        // sub-agents on a lexical miss would be too aggressive when
        // we have no semantic signal to confirm the negative.
        const out = await selectMatchingSubAgents('xyzzyyzyzyzx unknown opaque', ALL, {
            topK: 2,
        });
        expect(out.length).toBe(ALL.length);
    });
});

// ─── buildDelegationSystemPrompt ───────────────────────────

describe('buildDelegationSystemPrompt', () => {
    it('returns empty string when no sub-agents are shortlisted', () => {
        expect(buildDelegationSystemPrompt([])).toBe('');
    });

    it('emits the DELEGATION header and lists shortlisted sub-agents', () => {
        const out = buildDelegationSystemPrompt([
            { name: 'web', description: 'Web search agent' },
        ]);
        expect(out).toContain('## DELEGATION');
        expect(out).toContain('- **web**: Web search agent');
    });

    it('does NOT mention sub-agents that are not in the shortlist', () => {
        const out = buildDelegationSystemPrompt([
            { name: 'web', description: 'Web search agent' },
        ]);
        // vault_inspector / vault_editor specific tip blocks must be
        // omitted entirely when their owning sub-agent isn't picked.
        expect(out).not.toContain('vault_inspector delegation tips');
        expect(out).not.toContain('Whole-file body rewrites');
        expect(out).not.toContain('locate-first SOP');
    });

    it('includes vault_inspector-specific tips when vault_inspector is shortlisted', () => {
        const out = buildDelegationSystemPrompt([
            { name: 'vault_inspector', description: 'Read-only vault inspector' },
        ]);
        expect(out).toContain('locate first');
        expect(out).toContain('digest');
        expect(out).toContain('Vault inspector delegation tips');
    });

    it('includes vault_editor-specific tips when vault_editor is shortlisted', () => {
        const out = buildDelegationSystemPrompt([
            { name: 'vault_editor', description: 'Rewrites a single file body' },
        ]);
        expect(out).toContain('vault_editor');
        expect(out).toContain('Whole-file body rewrites');
    });

    it('always includes the shared handoff/envelope reference block when any sub-agent is shortlisted', () => {
        const out = buildDelegationSystemPrompt([
            { name: 'code', description: 'JavaScript execution agent' },
        ]);
        expect(out).toContain('### Passing structured data');
        expect(out).toContain('### Reading delegate_task results');
        expect(out).toContain('__kind');
    });
});

// ─── refineMatchingSubAgentsSync ───────────────────────────

describe('refineMatchingSubAgentsSync', () => {
    const candidateTexts = buildSubAgentCandidateTexts(ALL);

    it('returns empty list when no sub-agents are configured', () => {
        const out = refineMatchingSubAgentsSync('anything', [], [], {
            topK: 2,
            baselineShortlist: [],
        });
        expect(out).toEqual([]);
    });

    it('preserves baseline order and never removes entries on a no-shift iteration', () => {
        // userInput-only enriched query (lastAssistantText empty case)
        // that already matches the baseline → no new BM25 hits beyond it.
        const out = refineMatchingSubAgentsSync('search notes file vault tag metadata', ALL, candidateTexts, {
            topK: 2,
            baselineShortlist: [VAULT],
        });
        const names = out.map(c => c.name);
        expect(names[0]).toBe('vault_inspector');
        expect(names).toContain('vault_inspector');
    });

    it('adds a mid-turn sub-agent that becomes relevant via lastAssistantText', () => {
        // Plan-B canonical case: turn started as a vault query
        // (baseline = vault_inspector only). The assistant has since
        // narrated "I should also search the web for authoritative
        // sources" — the enriched query now mentions web + search +
        // internet, BM25 should hit `web` and append it.
        const enrichedQuery = 'find notes about cats\nI should also search the web for authoritative sources';
        const out = refineMatchingSubAgentsSync(enrichedQuery, ALL, candidateTexts, {
            topK: 2,
            baselineShortlist: [VAULT],
        });
        const names = out.map(c => c.name);
        // Baseline preserved at the front:
        expect(names[0]).toBe('vault_inspector');
        // New BM25 hit appended:
        expect(names).toContain('web');
    });

    it('skips the BM25 step on short queries and returns baseline + sticky only', () => {
        const out = refineMatchingSubAgentsSync('y', ALL, candidateTexts, {
            topK: 2,
            baselineShortlist: [WEB],
            stickyAgentNames: new Set(['vault_inspector']),
        });
        const names = out.map(c => c.name);
        // Baseline first, then sticky union:
        expect(names[0]).toBe('web');
        expect(names).toContain('vault_inspector');
        // No spurious additions just because BM25 might tokenise 'y':
        expect(names.length).toBe(2);
    });

    it('respects topK as a NEW-additions cap rather than a total-list cap', () => {
        // topK=1 means "at most 1 BM25-new entry beyond the baseline".
        // The baseline itself can already be larger than topK.
        const enrichedQuery = 'search the web translate code execute javascript';
        const out = refineMatchingSubAgentsSync(enrichedQuery, ALL, candidateTexts, {
            topK: 1,
            baselineShortlist: [VAULT, EDITOR],
        });
        const names = out.map(c => c.name);
        expect(names.slice(0, 2)).toEqual(['vault_inspector', 'vault_editor']);
        // Exactly one BM25 addition past the baseline:
        expect(names.length).toBe(3);
    });

    it('does not duplicate when a BM25 hit is already in the baseline', () => {
        const enrichedQuery = 'search the web for cats';
        const out = refineMatchingSubAgentsSync(enrichedQuery, ALL, candidateTexts, {
            topK: 2,
            baselineShortlist: [WEB],
        });
        const names = out.map(c => c.name);
        expect(names.filter(n => n === 'web').length).toBe(1);
    });

    it('applies sticky-on-history union after BM25 additions', () => {
        const enrichedQuery = 'find notes about cats\nI should also search the web';
        const out = refineMatchingSubAgentsSync(enrichedQuery, ALL, candidateTexts, {
            topK: 1,
            baselineShortlist: [VAULT],
            stickyAgentNames: new Set(['code']),
        });
        const names = out.map(c => c.name);
        expect(names).toContain('vault_inspector');
        expect(names).toContain('web');
        expect(names).toContain('code');
        // Sticky must come AFTER baseline + BM25 additions.
        expect(names.indexOf('code')).toBeGreaterThan(names.indexOf('vault_inspector'));
        expect(names.indexOf('code')).toBeGreaterThan(names.indexOf('web'));
    });

    it('clamps topK into the [1, available.length] range', () => {
        const enrichedQuery = 'search the web translate code execute javascript';
        const clampedLow = refineMatchingSubAgentsSync(enrichedQuery, ALL, candidateTexts, {
            topK: 0,
            baselineShortlist: [VAULT],
        });
        // topK=0 → clamps to 1, so exactly one BM25-new addition.
        expect(clampedLow.length).toBe(2);

        const clampedHigh = refineMatchingSubAgentsSync(enrichedQuery, ALL, candidateTexts, {
            topK: 999,
            baselineShortlist: [VAULT],
        });
        // topK=999 → clamps to ALL.length, but unique-union still caps
        // the result at ALL.length total.
        expect(clampedHigh.length).toBeLessThanOrEqual(ALL.length);
    });
});

// ─── buildSubAgentCandidateTexts ───────────────────────────

describe('buildSubAgentCandidateTexts', () => {
    it('produces an index-parallel array', () => {
        const texts = buildSubAgentCandidateTexts(ALL);
        expect(texts.length).toBe(ALL.length);
        for (let i = 0; i < ALL.length; i++) {
            expect(texts[i]).toContain(ALL[i]!.name);
            expect(texts[i]).toContain(ALL[i]!.description);
        }
    });

    it('embeds routing keywords as a Triggers: line', () => {
        const texts = buildSubAgentCandidateTexts([WEB]);
        expect(texts[0]).toContain('Triggers:');
        expect(texts[0]).toContain('search');
        expect(texts[0]).toContain('web');
    });

    it('omits the Triggers: line when no keywords are configured', () => {
        const noKeywords = makeConfig('plain', 'A plain agent with no keywords');
        const texts = buildSubAgentCandidateTexts([noKeywords]);
        expect(texts[0]).not.toContain('Triggers:');
        expect(texts[0]).toContain('plain');
    });
});
