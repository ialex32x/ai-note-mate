import { describe, it, expect } from 'vitest';
import { collapseToolMessagesForSummary } from '../src/services/context-compression/tool-collapse';
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

function assistantMsg(content: string, toolCalls?: { id: string; function: { name: string; arguments: string } }[], id?: string): HistoryMessage {
    return msg({ role: 'assistant' as any, content, toolCalls, id });
}

function toolResult(toolCallId: string, content: string): HistoryMessage {
    return msg({ role: 'tool_result' as any, content, toolCallId });
}

describe('collapseToolMessagesForSummary', () => {
    it('should return empty array for empty input', () => {
        expect(collapseToolMessagesForSummary([])).toEqual([]);
    });

    it('should pass through non-tool messages unchanged', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Hi there'),
            userMsg('How are you?'),
            assistantMsg('I am fine'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toEqual(messages);
    });

    it('should collapse a tool_call + tool_result pair into a single assistant message', () => {
        const messages: HistoryMessage[] = [
            userMsg('Create a file'),
            assistantMsg('', [{ id: 'tc1', function: { name: 'write_file', arguments: '{"path":"test.md"}' } }]),
            toolResult('tc1', 'File created successfully'),
            assistantMsg('Done!'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toHaveLength(3);
        expect(result[0]!.role).toBe('user');
        // The collapsed assistant message should contain a narrative summary
        expect(result[1]!.role).toBe('assistant');
        expect(result[1]!.content).toContain('write_file');
        expect(result[2]!.role).toBe('assistant');
        expect(result[2]!.content).toBe('Done!');
    });

    it('should merge text content with tool call summary', () => {
        const messages: HistoryMessage[] = [
            userMsg('Search and summarize'),
            assistantMsg('Let me search...', [{ id: 's1', function: { name: 'web_search', arguments: '{"q":"AI"}' } }]),
            toolResult('s1', 'AI is a broad field of computer science...'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toHaveLength(2);
        expect(result[1]!.role).toBe('assistant');
        expect(result[1]!.content).toContain('Let me search...');
        expect(result[1]!.content).toContain('web_search');
    });

    it('should collapse multiple tool calls in a single assistant turn', () => {
        const messages: HistoryMessage[] = [
            userMsg('Do multiple things'),
            assistantMsg('Running tools...', [
                { id: 't1', function: { name: 'read_file', arguments: '{"path":"a.md"}' } },
                { id: 't2', function: { name: 'read_file', arguments: '{"path":"b.md"}' } },
            ]),
            toolResult('t1', 'Content of a.md'),
            toolResult('t2', 'Content of b.md'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toHaveLength(2);
        expect(result[1]!.role).toBe('assistant');
        expect(result[1]!.content).toContain('read_file');
        // Both tool calls should be summarized
        expect(result[1]!.content).toContain('a.md');
        expect(result[1]!.content).toContain('b.md');
    });

    it('should preserve thinkingContent on collapsed messages', () => {
        const messages: HistoryMessage[] = [
            userMsg('Explain this'),
            msg({
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'r1', function: { name: 'read_file', arguments: '{}' } }],
                thinkingContent: 'reasoning step',
            }),
            toolResult('r1', 'file content'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toHaveLength(2);
        const collapsed = result[1]! as any;
        expect(collapsed.thinkingContent).toBe('reasoning step');
    });

    it('should skip user(media) messages interleaved between tool results', () => {
        // user(media) messages within the tool result run are consumed
        // (not output as separate elements) — the collapse function skips
        // them so sibling tool_results still make it into the summary.
        const messages: HistoryMessage[] = [
            userMsg('Generate an image'),
            assistantMsg('Creating...', [{ id: 'g1', function: { name: 'generate_image', arguments: '{"prompt":"sunset"}' } }]),
            toolResult('g1', 'base64data...'),
            userMsg('', 'media-synthetic'), // user(media) injection, consumed during collapse
            assistantMsg('Here is your image'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        // The user(media) message at index 3 is within the tool run and gets consumed.
        // Result: [user('Generate'), collapsedAssistant, assistant('Here is your image')]
        expect(result).toHaveLength(3);
        expect(result[0]!.role).toBe('user');
        expect(result[0]!.content).toBe('Generate an image');
        expect(result[1]!.role).toBe('assistant');
        expect(result[1]!.content).toContain('generate_image');
        expect(result[2]!.role).toBe('assistant');
        expect(result[2]!.content).toBe('Here is your image');
    });

    it('should handle a mix of plain messages and tool calls', () => {
        const messages: HistoryMessage[] = [
            userMsg('Q1'),
            assistantMsg('A1'),
            userMsg('Q2 with tool'),
            assistantMsg('Using tool', [{ id: 'c1', function: { name: 'calc', arguments: '{"expr":"1+1"}' } }]),
            toolResult('c1', '2'),
            assistantMsg('The answer is 2'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toHaveLength(5);
        expect(result[0]!.content).toBe('Q1');
        expect(result[1]!.content).toBe('A1');
        expect(result[2]!.content).toBe('Q2 with tool');
        expect(result[3]!.role).toBe('assistant');
        expect(result[3]!.content).toContain('calc');
        expect(result[3]!.content).toContain('1+1');
        expect(result[4]!.content).toBe('The answer is 2');
    });

    it('should handle tool calls with unnamed tools (toolCalls with no id)', () => {
        const messages: HistoryMessage[] = [
            userMsg('Do something'),
            assistantMsg('ok', [{ id: 't1', function: { name: 'unknown', arguments: '{}' } }]),
            toolResult('t1', 'result'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toHaveLength(2);
        expect(result[1]!.role).toBe('assistant');
    });

    it('should not collapse assistant messages without toolCalls', () => {
        const messages: HistoryMessage[] = [
            userMsg('Hello'),
            assistantMsg('Hi'),
        ];
        const result = collapseToolMessagesForSummary(messages);
        expect(result).toHaveLength(2);
        expect(result).toEqual(messages);
    });
});
