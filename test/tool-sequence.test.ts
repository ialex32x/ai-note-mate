import { describe, it, expect } from 'vitest';
import { toolResultRunEnd, ensureToolSequenceIntegrity } from '../src/services/context-compression/tool-sequence';
import type { HistoryMessage } from '../src/services/context-compression/types';

function msg(overrides: Partial<HistoryMessage> & { role: string }): HistoryMessage {
    return {
        role: 'user' as any,
        content: '',
        ...overrides,
    } as HistoryMessage;
}

function userMsg(content: string, id?: string): HistoryMessage {
    return msg({ role: 'user' as any, content, id });
}

function assistantMsg(content: string, toolCalls?: any[], id?: string): HistoryMessage {
    return msg({ role: 'assistant' as any, content, toolCalls, id });
}

function toolResult(toolCallId: string, content: string): HistoryMessage {
    return msg({ role: 'tool_result' as any, content, toolCallId });
}

describe('toolResultRunEnd', () => {
    it('should return exclusive end index of tool result run (stops at next assistant)', () => {
        // The run continues past tool_results AND user(media) messages,
        // stopping only at the next assistant message.
        const messages: HistoryMessage[] = [
            assistantMsg('thinking...', [{ id: 'tc1' }]),
            toolResult('tc1', 'result 1'),
            toolResult('tc2', 'result 2'),
            userMsg('next turn'),
        ];
        // Stops at messages.length because there's no next assistant
        expect(toolResultRunEnd(messages, 0)).toBe(4);
    });

    it('should return messages.length when run goes to end', () => {
        const messages: HistoryMessage[] = [
            assistantMsg('thinking...', [{ id: 'tc1' }]),
            toolResult('tc1', 'result'),
        ];
        expect(toolResultRunEnd(messages, 0)).toBe(2);
    });

    it('should stop at the next assistant message (not user/media)', () => {
        const messages: HistoryMessage[] = [
            assistantMsg('call tool', [{ id: 'tc1' }]),
            toolResult('tc1', 'image bytes'),
            // A user(media) message injected between tool_results
            userMsg('', 'media-msg'),
            toolResult('tc2', 'more data'),
            assistantMsg('next assistant'),
            userMsg('user turn'),
        ];
        // The run should extend past the user(media) message to the next assistant
        expect(toolResultRunEnd(messages, 0)).toBe(4);
    });
});

describe('ensureToolSequenceIntegrity', () => {
    it('should return empty array for empty input', () => {
        expect(ensureToolSequenceIntegrity([])).toEqual([]);
    });

    it('should pass through a clean message sequence', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Hi'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toEqual(messages);
    });

    it('should drop orphaned tool_result at the start', () => {
        const messages: HistoryMessage[] = [
            toolResult('tc1', 'orphan'),
            userMsg('Hello'),
            assistantMsg('Hi'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toHaveLength(2);
        expect(result[0]!.role).toBe('user');
        expect(result[1]!.role).toBe('assistant');
    });

    it('should drop orphaned tool_call at the start', () => {
        const messages: HistoryMessage[] = [
            msg({ role: 'tool_call' as any, content: '' }),
            userMsg('Hello'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toHaveLength(1);
        expect(result[0]!.role).toBe('user');
    });

    it('should keep leading plain assistant message', () => {
        const messages: HistoryMessage[] = [
            assistantMsg('Welcome'),
            userMsg('Hello'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toHaveLength(2);
    });

    it('should keep leading assistant with complete tool call sequence', () => {
        const messages: HistoryMessage[] = [
            assistantMsg('Calling tool...', [{ id: 'tc1' }]),
            toolResult('tc1', 'done'),
            userMsg('Great'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toHaveLength(3);
    });

    it('should drop leading assistant with incomplete tool calls', () => {
        const messages: HistoryMessage[] = [
            assistantMsg('Calling tool...', [{ id: 'tc1' }, { id: 'tc2' }]),
            toolResult('tc1', 'done'),
            // Missing tc2
            userMsg('Hello'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toHaveLength(1);
        expect(result[0]!.role).toBe('user');
    });

    it('should truncate trailing incomplete tool call sequence', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Calling tool...', [{ id: 'tc1' }]),
            // Missing tool_result for tc1
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toHaveLength(1);
        expect(result[0]!.role).toBe('user');
    });

    it('should keep trailing complete tool call sequence', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Calling tool...', [{ id: 'tc1' }]),
            toolResult('tc1', 'done'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toHaveLength(3);
    });

    it('should handle user(media) message interleaved in tool results', () => {
        // A real-world scenario: media attachment injected between tool_results
        const messages: HistoryMessage[] = [
            userMsg('Generate an image'),
            assistantMsg('Creating...', [{ id: 'gen1' }, { id: 'gen2' }]),
            toolResult('gen1', 'image data'),
            userMsg('', 'media-injection'),
            toolResult('gen2', 'more image data'),
            assistantMsg('Done'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        // Should keep everything — the user(media) between tool_results is legitimate
        expect(result).toHaveLength(6);
    });

    it('should handle multiple turns with tool calls', () => {
        const messages: HistoryMessage[] = [
            userMsg('Turn 1'),
            assistantMsg('Processing turn 1', [{ id: 't1' }]),
            toolResult('t1', 'result 1'),
            assistantMsg('Turn 1 done'),
            userMsg('Turn 2'),
            assistantMsg('Processing turn 2', [{ id: 't2' }]),
            toolResult('t2', 'result 2'),
            assistantMsg('Turn 2 done'),
        ];
        const result = ensureToolSequenceIntegrity(messages);
        expect(result).toEqual(messages);
    });
});
