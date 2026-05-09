import { describe, it, expect } from 'vitest';
import { ContextReducer, HistroyMessage } from '../src/services/context-reducer';

// ─── Helpers ───────────────────────────────────────────────

/** Shorthand to build a user message */
function user(content: string, id?: string): HistroyMessage {
    return { role: 'user', content, id };
}

/** Shorthand to build a plain assistant message */
function assistant(content: string, id?: string): HistroyMessage {
    return { role: 'assistant', content, id };
}

/** Build an assistant message that contains tool calls */
function assistantWithToolCalls(
    content: string,
    toolCalls: { id: string; name: string; arguments: string }[],
    id?: string,
): HistroyMessage {
    return {
        role: 'assistant',
        content,
        id,
        toolCalls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
        })),
    } as any;
}

/** Build a tool_result message */
function toolResult(toolCallId: string, content: string, id?: string): HistroyMessage {
    return { role: 'tool_result', content, id, toolCallId } as any;
}

// ─── Tests ─────────────────────────────────────────────────

describe('ContextReducer.collapseToolMessagesForSummary', () => {
    it('should return empty array for empty input', () => {
        expect(ContextReducer.collapseToolMessagesForSummary([])).toEqual([]);
    });

    it('should pass through messages without tool calls unchanged', () => {
        const msgs = [user('hi'), assistant('hello')];
        const result = ContextReducer.collapseToolMessagesForSummary(msgs);
        expect(result).toHaveLength(2);
        expect(result[0]!.role).toBe('user');
        expect(result[1]!.role).toBe('assistant');
    });

    it('should collapse a tool call + tool result pair into a single assistant message', () => {
        const msgs = [
            user('search for cats'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'search_notes', arguments: '{"query":"cats"}' },
            ]),
            toolResult('tc1', 'Found 3 notes about cats'),
            assistant('Here are the results about cats.'),
        ];

        const result = ContextReducer.collapseToolMessagesForSummary(msgs);

        // user + collapsed_assistant + final_assistant = 3
        expect(result).toHaveLength(3);
        expect(result[0]!.role).toBe('user');
        expect(result[1]!.role).toBe('assistant');
        // The collapsed message should mention the tool name and result
        expect(result[1]!.content).toContain('search_notes');
        expect(result[1]!.content).toContain('cats');
        expect(result[2]!.role).toBe('assistant');
    });

    it('should collapse multiple tool calls in a single assistant message', () => {
        const msgs = [
            user('compare two files'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'read_note', arguments: '{"path":"a.md"}' },
                { id: 'tc2', name: 'read_note', arguments: '{"path":"b.md"}' },
            ]),
            toolResult('tc1', 'Content of file A'),
            toolResult('tc2', 'Content of file B'),
            assistant('Here is the comparison.'),
        ];

        const result = ContextReducer.collapseToolMessagesForSummary(msgs);

        // user + collapsed_assistant(2 tools) + final_assistant = 3
        expect(result).toHaveLength(3);
        expect(result[1]!.content).toContain('read_note');
        expect(result[1]!.content).toContain('a.md');
        expect(result[1]!.content).toContain('b.md');
    });

    it('should handle large tool results by truncating', () => {
        const largeContent = 'x'.repeat(5000); // Well above 500 token threshold
        const msgs = [
            user('read big file'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'read_note', arguments: '{"path":"big.md"}' },
            ]),
            toolResult('tc1', largeContent),
        ];

        const result = ContextReducer.collapseToolMessagesForSummary(msgs);

        expect(result).toHaveLength(2);
        // The collapsed content should be much shorter than the original
        expect(result[1]!.content.length).toBeLessThan(largeContent.length);
        expect(result[1]!.content).toContain('truncated');
    });

    it('should preserve error results as-is', () => {
        const msgs = [
            user('read missing file'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'read_note', arguments: '{"path":"missing.md"}' },
            ]),
            toolResult('tc1', 'Error: File not found'),
        ];

        const result = ContextReducer.collapseToolMessagesForSummary(msgs);

        expect(result).toHaveLength(2);
        expect(result[1]!.content).toContain('Error: File not found');
    });

    it('should preserve assistant text content alongside tool call summaries', () => {
        const msgs = [
            user('do something'),
            assistantWithToolCalls('Let me search for that.', [
                { id: 'tc1', name: 'search_notes', arguments: '{"query":"test"}' },
            ]),
            toolResult('tc1', 'Found 1 result'),
        ];

        const result = ContextReducer.collapseToolMessagesForSummary(msgs);

        expect(result[1]!.content).toContain('Let me search for that.');
        expect(result[1]!.content).toContain('search_notes');
    });

    it('should handle JSON array results with item count', () => {
        const jsonArray = JSON.stringify([{ title: 'a' }, { title: 'b' }, { title: 'c' }]);
        // Need to make it large enough to trigger collapse
        const largeJsonArray = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({
            title: `Item ${i}`,
            content: 'x'.repeat(100),
        })));

        const msgs = [
            user('list items'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'search_notes', arguments: '{"query":"all"}' },
            ]),
            toolResult('tc1', largeJsonArray),
        ];

        const result = ContextReducer.collapseToolMessagesForSummary(msgs);

        expect(result[1]!.content).toContain('50 items');
    });

    it('should handle sequential tool call sequences', () => {
        const msgs = [
            user('multi-step task'),
            // First tool call sequence
            assistantWithToolCalls('Step 1', [
                { id: 'tc1', name: 'search_notes', arguments: '{"query":"foo"}' },
            ]),
            toolResult('tc1', 'Found foo'),
            // Second tool call sequence
            assistantWithToolCalls('Step 2', [
                { id: 'tc2', name: 'read_note', arguments: '{"path":"foo.md"}' },
            ]),
            toolResult('tc2', 'Content of foo'),
            assistant('Done with both steps.'),
        ];

        const result = ContextReducer.collapseToolMessagesForSummary(msgs);

        // user + collapsed1 + collapsed2 + final_assistant = 4
        expect(result).toHaveLength(4);
        expect(result[1]!.content).toContain('search_notes');
        expect(result[2]!.content).toContain('read_note');
    });
});
