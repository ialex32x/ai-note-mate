import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Provider mocks ────────────────────────────────────────
//
// `ContextCompressor.compress` calls `summarizeConversation` →
// `createChatCompletion` → the OpenAI/Gemini provider. We stub both
// provider modules so the Level-2 path runs deterministically and
// offline. The summarizer always returns a fixed marker string.
const SUMMARIZER_OUTPUT = 'MERGED_L2_SUMMARY';

vi.mock('../src/services/providers/openai-provider', () => ({
    createOpenAICompletion: vi.fn(async () => SUMMARIZER_OUTPUT),
    OpenAIProvider: class {},
}));

vi.mock('../src/services/providers/gemini-provider', () => ({
    createGeminiCompletion: vi.fn(async () => SUMMARIZER_OUTPUT),
    GeminiProvider: class {},
}));

import { ContextCompressor, HistroyMessage, ConversationSummary } from '../src/services/context-compression';
import { createOpenAICompletion } from '../src/services/providers/openai-provider';

// ─── Helpers ───────────────────────────────────────────────

function user(content: string, id?: string): HistroyMessage {
    return { role: 'user', content, id };
}

function assistant(content: string, id?: string): HistroyMessage {
    return { role: 'assistant', content, id };
}

/** Minimal OpenAI-shaped model config; the provider call is mocked. */
const MODEL_CONFIG = { type: 'openai', baseURL: '', apiKey: '', model: 'gpt-test' } as any;
const PROMPT = { content: 'summarizer system prompt' };

/** Build N first-level summaries, each covering nothing of rawMessages (lastMessageIndex 0). */
function makeLevel1Summaries(n: number): ConversationSummary[] {
    return Array.from({ length: n }, (_, i) => ({
        content: `[Conversation Summary]\nold summary ${i}`,
        level: 1,
        createdAt: 1000 + i,
        lastMessageIndex: 0,
    }));
}

const L1_PREFIX = '[Conversation Summary]';
const L2_PREFIX = '[Summary of Previous Summaries (Level 2)]';

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── Tests ─────────────────────────────────────────────────
//
// Regression coverage for Bug 1 (docs/context-compression-bug-report.md §2):
// the Level-2 merge path used to (a) drop the recent raw window — including
// the CURRENT user turn — (b) re-send every old summary instead of replacing
// them, and (d) mis-record the coverage index. These tests pin the fixed
// contract.
describe('ContextCompressor.compress — Level-2 merge', () => {
    it('keeps the current user turn and the recent raw window when Level-2 triggers', async () => {
        const summaries = makeLevel1Summaries(8); // == default maxSummaries → needsLevel2
        const rawMessages: HistroyMessage[] = [
            user('recent question 1', 'u1'),
            assistant('recent answer 1', 'a1'),
            user('CURRENT QUESTION', 'u2'),
        ];

        const result = await ContextCompressor.compress(
            MODEL_CONFIG,
            PROMPT,
            rawMessages,
            summaries,
            // Huge threshold so `overThreshold` is false: the ONLY trigger is
            // needsLevel2 (summaries.length >= maxSummaries default 8).
            { compressionThreshold: 10_000_000 },
        );

        // The summarizer must have actually run (Level-2 produces a summary).
        expect(createOpenAICompletion).toHaveBeenCalledTimes(1);

        // (a) The current user turn must reach the LLM. Before the fix the
        // recent window was dropped entirely and the prompt ended on an
        // assistant archive note.
        const last = result.messagesToSend[result.messagesToSend.length - 1]!;
        expect(last.role).toBe('user');
        expect(last.content).toBe('CURRENT QUESTION');

        // The whole recent raw window survives.
        const contents = result.messagesToSend.map(m => m.content);
        expect(contents).toContain('recent question 1');
        expect(contents).toContain('recent answer 1');
    });

    it('replaces old summaries with a single Level-2 summary (not append)', async () => {
        const summaries = makeLevel1Summaries(8);
        const rawMessages: HistroyMessage[] = [user('CURRENT QUESTION', 'u1')];

        const result = await ContextCompressor.compress(
            MODEL_CONFIG,
            PROMPT,
            rawMessages,
            summaries,
            { compressionThreshold: 10_000_000 },
        );

        // (b) Persistence contract: Level-2 returns a replacement set, NOT a
        // single appended summary.
        expect(result.newSummary).toBeNull();
        expect(result.summariesReplacement).not.toBeNull();
        expect(result.summariesReplacement).toHaveLength(1);
        const merged = result.summariesReplacement![0]!;
        expect(merged.level).toBe(2);
        expect(merged.content).toContain(L2_PREFIX);
        expect(merged.content).toContain(SUMMARIZER_OUTPUT);

        // The prompt must NOT re-include the 8 old Level-1 summaries; only the
        // new Level-2 summary block is present.
        const summaryBlocks = result.messagesToSend.filter(
            m => typeof m.content === 'string' && m.content.includes(L1_PREFIX),
        );
        expect(summaryBlocks).toHaveLength(0);
        const l2Blocks = result.messagesToSend.filter(
            m => typeof m.content === 'string' && m.content.includes(L2_PREFIX),
        );
        expect(l2Blocks).toHaveLength(1);
    });

    it('records coverage at the existing cutoff, not the array end (no recent-message loss)', async () => {
        const summaries = makeLevel1Summaries(8); // all lastMessageIndex 0 → cutoffIndex 0
        const rawMessages: HistroyMessage[] = [
            user('recent question', 'u1'),
            assistant('recent answer', 'a1'),
        ];

        const result = await ContextCompressor.compress(
            MODEL_CONFIG,
            PROMPT,
            rawMessages,
            summaries,
            { compressionThreshold: 10_000_000 },
        );

        // (d) The merged summary covers only what the L1 summaries covered
        // (cutoffIndex === 0 here). If this were nonSystemMessages.length the
        // recent raw messages would be flagged as already-summarized and lost
        // on the next turn.
        expect(result.lastMessageIndex).toBe(0);
        expect(result.summariesReplacement![0]!.lastMessageIndex).toBe(0);
    });

    it('converges: applying the replacement collapses the summary count and stops re-triggering Level-2', async () => {
        let summaries = makeLevel1Summaries(8);
        const rawMessages: HistroyMessage[] = [user('CURRENT QUESTION', 'u1')];

        // Turn 1 — Level-2 triggers, merges 8 → 1.
        const r1 = await ContextCompressor.compress(
            MODEL_CONFIG, PROMPT, rawMessages, summaries, { compressionThreshold: 10_000_000 },
        );
        expect(r1.summariesReplacement).toHaveLength(1);
        // Simulate the caller (chat-stream) applying the replacement.
        summaries = r1.summariesReplacement!;
        expect(summaries).toHaveLength(1);

        // Turn 2 — only 1 summary now (< maxSummaries) so Level-2 must NOT
        // re-fire; the count stays bounded instead of growing every turn.
        const callsBefore = (createOpenAICompletion as any).mock.calls.length;
        const r2 = await ContextCompressor.compress(
            MODEL_CONFIG, PROMPT, rawMessages, summaries, { compressionThreshold: 10_000_000 },
        );
        expect(r2.summariesReplacement ?? null).toBeNull();
        // No new summarization round (no over-threshold, no Level-2).
        expect((createOpenAICompletion as any).mock.calls.length).toBe(callsBefore);
    });
});
