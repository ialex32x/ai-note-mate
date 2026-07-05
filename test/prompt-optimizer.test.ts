import { describe, it, expect, vi, afterEach } from 'vitest';
import { optimizePrompt, PromptOptimizationError } from '../src/services/prompt-optimizer';

// Mock the LLM call — we control what the "model" returns to test
// unwrapResponse behavior indirectly through optimizePrompt.
vi.mock('../src/services/context-compression', () => ({
    createChatCompletion: vi.fn(),
}));

import { createChatCompletion } from '../src/services/context-compression';
const mockCreateChatCompletion = createChatCompletion as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
    vi.clearAllMocks();
});

function makeModelConfig() {
    return { provider: 'openai', model: 'gpt-4o-mini', maxTokens: 1024 } as any;
}

// ── optimizePrompt (through which we test unwrapResponse) ────────────────

describe('optimizePrompt / unwrapResponse', () => {
    it('should return the refined text when model returns plain text', async () => {
        mockCreateChatCompletion.mockResolvedValue('Generate an image of a cat');
        const result = await optimizePrompt(makeModelConfig(), { draft: 'kitty' });
        expect(result).toBe('Generate an image of a cat');
    });

    it('should strip outer ```fence``` from model response', async () => {
        mockCreateChatCompletion.mockResolvedValue(
            '```\nGenerate an image of a cat\n```',
        );
        const result = await optimizePrompt(makeModelConfig(), { draft: 'kitty' });
        expect(result).toBe('Generate an image of a cat');
    });

    it('should strip outer ```typescript fence from model response', async () => {
        mockCreateChatCompletion.mockResolvedValue(
            '```typescript\nconst x = 1;\n```',
        );
        const result = await optimizePrompt(makeModelConfig(), { draft: 'code' });
        expect(result).toBe('const x = 1;');
    });

    it('should strip outer ASCII quotes from model response', async () => {
        mockCreateChatCompletion.mockResolvedValue(
            '"Generate an image of a cat"',
        );
        const result = await optimizePrompt(makeModelConfig(), { draft: 'kitty' });
        expect(result).toBe('Generate an image of a cat');
    });

    it('should strip outer smart quotes from model response', async () => {
        mockCreateChatCompletion.mockResolvedValue(
            '\u201cGenerate an image of a cat\u201d',
        );
        const result = await optimizePrompt(makeModelConfig(), { draft: 'kitty' });
        expect(result).toBe('Generate an image of a cat');
    });

    it('should NOT strip quotes when interior contains same quote type', async () => {
        // "wraps the whole output in quotes" mode never produces interior quotes
        // of the same type — this test verifies the safety guard is correct.
        const interior = '"Hello" is a common greeting';
        mockCreateChatCompletion.mockResolvedValue(interior);
        const result = await optimizePrompt(makeModelConfig(), { draft: 'test' });
        expect(result).toBe(interior);
    });

    it('should strip fence first, then quotes (fence+quote combo)', async () => {
        mockCreateChatCompletion.mockResolvedValue(
            '```\n"He said hello"\n```',
        );
        const result = await optimizePrompt(makeModelConfig(), { draft: 'test' });
        // Fence is stripped first: `"He said hello"` then quotes are stripped
        expect(result).toBe('He said hello');
    });

    it('should NOT strip quotes when interior would be empty', async () => {
        mockCreateChatCompletion.mockResolvedValue('""');
        const result = await optimizePrompt(makeModelConfig(), { draft: 'test' });
        // Empty inner.trim() → keep original
        expect(result).toBe('""');
    });

    it('should NOT strip fence when only fence with no interior', async () => {
        mockCreateChatCompletion.mockResolvedValue('```\n```');
        const result = await optimizePrompt(makeModelConfig(), { draft: 'test' });
        // The regex requires content between fences to match, so empty fences
        // are returned unchanged (conservative: don't strip what you can't parse)
        expect(result).toBe('```\n```');
    });

    it('should throw PromptOptimizationError when model returns empty', async () => {
        mockCreateChatCompletion.mockResolvedValue('');
        await expect(
            optimizePrompt(makeModelConfig(), { draft: 'hello' }),
        ).rejects.toThrow(PromptOptimizationError);
        await expect(
            optimizePrompt(makeModelConfig(), { draft: 'hello' }),
        ).rejects.toThrow('Model returned empty refinement');
    });

    it('should throw PromptOptimizationError when model returns whitespace only', async () => {
        mockCreateChatCompletion.mockResolvedValue('   ');
        await expect(
            optimizePrompt(makeModelConfig(), { draft: 'hello' }),
        ).rejects.toThrow(PromptOptimizationError);
    });

    it('should throw PromptOptimizationError when draft is empty', async () => {
        await expect(
            optimizePrompt(makeModelConfig(), { draft: '' }),
        ).rejects.toThrow(PromptOptimizationError);
        await expect(
            optimizePrompt(makeModelConfig(), { draft: '' }),
        ).rejects.toThrow('Draft is empty');
    });

    it('should throw PromptOptimizationError when draft is whitespace', async () => {
        await expect(
            optimizePrompt(makeModelConfig(), { draft: '   ' }),
        ).rejects.toThrow(PromptOptimizationError);
    });

    it('should propagate AbortError from the LLM call', async () => {
        const abortError = new DOMException('Aborted', 'AbortError');
        mockCreateChatCompletion.mockRejectedValue(abortError);
        await expect(
            optimizePrompt(makeModelConfig(), { draft: 'hello' }),
        ).rejects.toThrow(abortError);
    });

    it('should truncate long draft to MAX_DRAFT_CHARS', async () => {
        const longDraft = 'x'.repeat(5000);
        mockCreateChatCompletion.mockResolvedValue('refined');
        await optimizePrompt(makeModelConfig(), { draft: longDraft });
        const callArg = mockCreateChatCompletion.mock.calls[0][1];
        const userMsg = callArg.find((m: any) => m.role === 'user');
        // Draft is truncated to 4000 chars + '\n…[truncated]' suffix = 4014 total
        expect(userMsg.content).toContain('[truncated]');
        expect(userMsg.content.length).toBeLessThan(4100);
        // The raw draft inside the message is the 4000-char truncated version
        const draftMatch = userMsg.content.match(/"""(.*?)"""/s);
        if (draftMatch) {
            expect(draftMatch[1]!.length).toBeLessThan(4100);
        }
    });
});

// ── buildRefineUserPrompt via integration ────────────────────────────────

describe('optimizePrompt / context integration', () => {
    it('should include PREVIOUS_TURN block when userMessage is provided', async () => {
        mockCreateChatCompletion.mockResolvedValue('refined');
        await optimizePrompt(makeModelConfig(), {
            draft: 'explain more',
            userMessage: 'What is AI?',
        });
        const callArg = mockCreateChatCompletion.mock.calls[0][1];
        const userMsg = callArg.find((m: any) => m.role === 'user');
        expect(userMsg.content).toContain('PREVIOUS_TURN');
        expect(userMsg.content).toContain('What is AI?');
    });

    it('should include assistantReply in PREVIOUS_TURN block', async () => {
        mockCreateChatCompletion.mockResolvedValue('refined');
        await optimizePrompt(makeModelConfig(), {
            draft: 'more details',
            assistantReply: 'AI stands for Artificial Intelligence',
        });
        const callArg = mockCreateChatCompletion.mock.calls[0][1];
        const userMsg = callArg.find((m: any) => m.role === 'user');
        expect(userMsg.content).toContain('AI stands for Artificial Intelligence');
    });

    it('should omit PREVIOUS_TURN block when neither context is provided', async () => {
        mockCreateChatCompletion.mockResolvedValue('refined');
        await optimizePrompt(makeModelConfig(), { draft: 'hello' });
        const callArg = mockCreateChatCompletion.mock.calls[0][1];
        const userMsg = callArg.find((m: any) => m.role === 'user');
        expect(userMsg.content).not.toContain('PREVIOUS_TURN');
    });
});
