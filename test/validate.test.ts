import { describe, it, expect } from 'vitest';
import { validateAndSanitizeForLLM } from '../src/services/context-compression/validate';
import type { HistoryMessage } from '../src/services/context-compression/types';

function msg(overrides: Partial<HistoryMessage> & { role: string }): HistoryMessage {
    return {
        role: 'system' as any,
        content: '',
        ...overrides,
    } as HistoryMessage;
}

function systemMsg(content: string): HistoryMessage {
    return msg({ role: 'system' as any, content });
}

function userMsg(content: string, id?: string): HistoryMessage {
    return msg({ role: 'user' as any, content, id });
}

function assistantMsg(
    content: string,
    toolCalls?: { id: string; function: { name: string; arguments: string } }[],
    thinkingContent?: string,
    id?: string,
): HistoryMessage {
    return msg({ role: 'assistant' as any, content, toolCalls, thinkingContent, id });
}

function toolResult(toolCallId: string, content: string): HistoryMessage {
    return msg({ role: 'tool_result' as any, content, toolCallId });
}

// TEMP DEBUG: Log actual inputs/outputs
function debug(msg: string) { /* suppress in non-debug mode */ }

describe('validateAndSanitizeForLLM', () => {
    it('should return input unchanged for empty array', () => {
        const result = validateAndSanitizeForLLM([]);
        expect(result).toEqual([]);
    });

    it('should pass through a clean sequence unchanged', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Hi there'),
            userMsg('How are you?'),
            assistantMsg('I am fine!'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toEqual(messages);
    });

    // ── Pass 1: Drop empty assistant messages ────────────────────────

    it('should drop assistant message with no content, no thinking, no toolCalls', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg(''),
            userMsg('World'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(2);
        expect(result[0]!.role).toBe('user');
        expect(result[1]!.role).toBe('user');
    });

    it('should keep assistant message with only thinkingContent', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('', undefined, 'deep thought'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(2);
        expect(result[1]!.role).toBe('assistant');
        expect(result[1]!.thinkingContent).toBe('deep thought');
    });

    it('should keep assistant message with only toolCalls (middle, not trailing)', () => {
        // When toolCalls-only assistant is in the MIDDLE (not trailing),
        // it won't be affected by trailing degradation
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('', [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }]),
            toolResult('tc1', 'result'),
            userMsg('Done'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(4);
        expect(result[1]!.role).toBe('assistant');
        expect(result[1]!.toolCalls).toHaveLength(1);
    });

    it('should keep assistant message with content only', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Valid reply'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(2);
    });

    // ── Pass 1: Leading orphan tool_result ──────────────────────────

    it('should drop leading orphan tool_result (first non-system message)', () => {
        const messages: HistoryMessage[] = [
            systemMsg('You are a helpful assistant'),
            toolResult('tc1', 'result'),
            userMsg('Hello'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(2);
        expect(result[0]!.role).toBe('system');
        expect(result[1]!.role).toBe('user');
    });

    it('should drop tool_result when it has no matching assistant(toolCalls) predecessor', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('I will help'),
            toolResult('nonexistent', 'orphan'),
            userMsg('Next'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(3);
        expect(result[0]!.role).toBe('user');
        expect(result[1]!.role).toBe('assistant');
        expect(result[2]!.role).toBe('user');
    });

    it('should keep tool_result when it has matching assistant(toolCalls) predecessor', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Calling...', [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }]),
            toolResult('tc1', 'search result'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(3);
        expect(result[2]!.role).toBe('tool_result');
        expect((result[2] as HistoryMessage).toolCallId).toBe('tc1');
    });

    it('should keep tool_result even when user(media) message is interleaved between tool_results', () => {
        // Real-world scenario: media attachment injected between tool_results from same assistant turn
        const messages: HistoryMessage[] = [
            userMsg('Generate images'),
            assistantMsg('Creating...', [
                { id: 'gen1', function: { name: 'generate_image', arguments: '{}' } },
                { id: 'gen2', function: { name: 'generate_image', arguments: '{}' } },
            ]),
            toolResult('gen1', 'image data'),
            userMsg('', undefined, undefined, 'media-msg'), // media-injected synthetic user
            toolResult('gen2', 'more image data'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(5);
        // Both tool_results should survive
        const toolResults = result.filter(m => m.role === 'tool_result');
        expect(toolResults).toHaveLength(2);
        expect(toolResults[0]!.toolCallId).toBe('gen1');
        expect(toolResults[1]!.toolCallId).toBe('gen2');
    });

    it('should keep system messages untouched throughout pass 1', () => {
        const messages: HistoryMessage[] = [
            systemMsg('System instruction'),
            userMsg('Hello'),
            assistantMsg(''),
            userMsg('World'),
            systemMsg('Another system instruction'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        // Empty assistant should be dropped, system messages kept
        const systemMessages = result.filter(m => m.role === 'system');
        expect(systemMessages).toHaveLength(2);
        expect(result).toHaveLength(4);
    });

    // ── Pass 2: Complete tool sequence ──────────────────────────────

    it('should pass through complete tool sequence unchanged', () => {
        const messages: HistoryMessage[] = [
            userMsg('Search something'),
            assistantMsg('Calling...', [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }]),
            toolResult('tc1', 'found results'),
            assistantMsg('Here are the results'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toEqual(messages);
    });

    // ── Pass 2: Trailing missing results ────────────────────────────

    it('should degrade trailing assistant(toolCalls) with missing results to content-only when content exists', () => {
        const messages: HistoryMessage[] = [
            userMsg('Search something'),
            assistantMsg('I am thinking...', [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }]),
            // Missing toolResult for tc1
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(2);
        // Assistant should be degraded to content-only (no toolCalls)
        expect(result[1]!.role).toBe('assistant');
        const degraded = result[1] as HistoryMessage;
        expect(degraded.toolCalls).toBeUndefined();
        expect(degraded.content).toBe('I am thinking...');
    });

    it('should drop trailing assistant(toolCalls) with missing results when no content', () => {
        const messages: HistoryMessage[] = [
            userMsg('Search something'),
            assistantMsg('', [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }]),
            // Missing toolResult for tc1
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(1);
        expect(result[0]!.role).toBe('user');
    });

    it('should degrade trailing assistant(toolCalls) with only thinkingContent', () => {
        const messages: HistoryMessage[] = [
            userMsg('Search something'),
            assistantMsg('', [{ id: 'tc1', function: { name: 'search', arguments: '{}' } }], 'thinking deeply'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(2);
        expect(result[1]!.role).toBe('assistant');
        expect((result[1] as HistoryMessage).thinkingContent).toBe('thinking deeply');
        expect((result[1] as HistoryMessage).toolCalls).toBeUndefined();
    });

    // ── Pass 2: Middle missing results ──────────────────────────────

    it('should insert placeholder tool_result for missing middle tool call id', () => {
        const messages: HistoryMessage[] = [
            userMsg('Do two things'),
            assistantMsg('Calling...', [
                { id: 'tc1', function: { name: 'search', arguments: '{}' } },
                { id: 'tc2', function: { name: 'fetch', arguments: '{}' } },
            ]),
            toolResult('tc1', 'search result'),
            // Missing tc2
            assistantMsg('Done'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(5);
        // tc1 result should be kept
        expect(result[2]!.role).toBe('tool_result');
        expect((result[2] as HistoryMessage).toolCallId).toBe('tc1');
        // Placeholder should be inserted for tc2
        expect(result[3]!.role).toBe('tool_result');
        expect((result[3] as HistoryMessage).toolCallId).toBe('tc2');
        expect((result[3] as HistoryMessage).content).toContain('Error: tool result missing');
    });

    it('should insert placeholders for multiple missing tool call ids', () => {
        const messages: HistoryMessage[] = [
            userMsg('Do three things'),
            assistantMsg('Calling...', [
                { id: 'tc1', function: { name: 'search', arguments: '{}' } },
                { id: 'tc2', function: { name: 'fetch', arguments: '{}' } },
                { id: 'tc3', function: { name: 'process', arguments: '{}' } },
            ]),
            // Only tc2 present, tc1 and tc3 missing
            toolResult('tc2', 'fetch result'),
            assistantMsg('Done'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(6);
        // Check placeholders for both tc1 and tc3
        const placeholders = result.filter(
            m => m.role === 'tool_result' && (m as HistoryMessage).content.includes('Error: tool result missing'),
        );
        expect(placeholders).toHaveLength(2);
        expect(placeholders[0]!.toolCallId).toBe('tc1');
        expect(placeholders[1]!.toolCallId).toBe('tc3');
    });

    // ── Complex multi-turn scenarios ────────────────────────────────

    it('should handle multiple turns with complete and incomplete tool sequences', () => {
        const messages: HistoryMessage[] = [
            userMsg('Turn 1'),
            assistantMsg('Complete', [{ id: 't1', function: { name: 'tool1', arguments: '{}' } }]),
            toolResult('t1', 'result 1'),
            assistantMsg('Turn 1 done'),
            userMsg('Turn 2'),
            assistantMsg('', [{ id: 't2', function: { name: 'tool2', arguments: '{}' } }]),
            // Missing t2 result — no content so should be dropped
        ];
        const result = validateAndSanitizeForLLM(messages);
        // Turn 2's empty assistant with toolCalls but no content and no results gets dropped
        // Expected: user('Turn1'), assistant('Complete' + t1), toolResult(t1), assistant('Turn1 done'), user('Turn2')
        expect(result).toHaveLength(5);
        expect(result[0]!.role).toBe('user');
        expect(result[1]!.role).toBe('assistant');
        expect((result[1] as HistoryMessage).toolCalls).toBeDefined();
        expect(result[4]!.role).toBe('user');
    });

    it('should handle tool_result with toolCallId matching via id-match after user(media) interjection', () => {
        const messages: HistoryMessage[] = [
            userMsg('Turn 1'),
            assistantMsg('First turn', [{ id: 't1', function: { name: 'tool1', arguments: '{}' } }]),
            toolResult('t1', 'first result'),
            assistantMsg('First turn done'),
            userMsg('Turn 2'),
            assistantMsg('Second turn', [{ id: 't2', function: { name: 'tool2', arguments: '{}' } }]),
            toolResult('t2', 'second result'),
            // Should all survive
        ];
        const result = validateAndSanitizeForLLM(messages);
        expect(result).toHaveLength(7);
    });

    it('should drop orphan tool_result that has no matching toolCalls in nearest assistant', () => {
        const messages: HistoryMessage[] = [
            userMsg('Turn'),
            // "Calling" has content but NO toolCalls property at all
            assistantMsg('Calling'),
            toolResult('nonexistent_id', 'orphan data'),
            userMsg('Next'),
        ];
        const result = validateAndSanitizeForLLM(messages);
        // The tool_result should be dropped (orphan). The assistant "Calling" has no toolCalls
        // so it cannot own the tool_result. After dropping the orphan, we have
        // user('Turn'), assistant('Calling') — assistant kept because it has content,
        // and user('Next'). Total: 3.
        expect(result).toHaveLength(3);
    });
});
