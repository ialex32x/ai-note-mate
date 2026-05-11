import { describe, it, expect } from 'vitest';
import { ContextReducer, HistroyMessage } from '../src/services/context-reducer';

// ─── Helpers ───────────────────────────────────────────────

function user(content: string, id?: string): HistroyMessage {
    return { role: 'user', content, id };
}

function assistant(content: string, id?: string): HistroyMessage {
    return { role: 'assistant', content, id };
}

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

function toolResult(toolCallId: string, content: string, id?: string): HistroyMessage {
    return { role: 'tool_result', content, id, toolCallId } as any;
}

// `shrinkLargeToolResults` is private — invoke via `as any` for white-box
// testing of the "skip last unconsumed tool_result chain" semantics.
function shrink(messages: HistroyMessage[]): HistroyMessage[] {
    return (ContextReducer as any).shrinkLargeToolResults(messages);
}

// Generate a tool_result payload that's well above
// `TOOL_RESULT_COLLAPSE_THRESHOLD` (500 tokens, ~2k chars Latin) so the
// shrink rule will definitely fire when not exempted.
function bigText(): string {
    return 'lorem ipsum dolor sit amet '.repeat(400); // ~10.8k chars
}

// ─── Tests ─────────────────────────────────────────────────

describe('ContextReducer.shrinkLargeToolResults', () => {
    it('returns the input unchanged when there are no messages', () => {
        expect(shrink([])).toEqual([]);
    });

    it('passes small tool_results through verbatim', () => {
        const small = 'Found 3 results';
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'search', arguments: '{}' },
            ]),
            toolResult('tc1', small),
            assistant('done'),
        ];
        const out = shrink(msgs);
        expect(out).toHaveLength(4);
        expect(out[2]!.content).toBe(small);
    });

    it('shrinks a large tool_result that has already been digested by a later assistant', () => {
        const big = bigText();
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'big_tool', arguments: '{}' },
            ]),
            toolResult('tc1', big),
            // The trailing assistant (with text content, no toolCalls) means
            // the model has already read tc1's result and produced a reply
            // based on it → tc1 is "consumed" and may be shrunk.
            assistant('Here is what I found.'),
        ];
        const out = shrink(msgs);
        expect(out).toHaveLength(4);
        // Original was multi-thousand chars; truncated bracket form is ~250.
        expect(out[2]!.content.length).toBeLessThan(big.length);
        expect(out[2]!.content).toContain('truncated');
        // toolCallId must be preserved so pairing remains valid.
        expect((out[2] as any).toolCallId).toBe('tc1');
    });

    it('exempts the last unconsumed tool_result chain (single tool_result)', () => {
        const big = bigText();
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'big_tool', arguments: '{}' },
            ]),
            // No assistant follows → tc1 has not been seen by any assistant
            // turn yet. Shrinking it now would defeat the entire purpose of
            // the tool call (most painful for delegate_task / digest tools).
            toolResult('tc1', big),
        ];
        const out = shrink(msgs);
        expect(out).toHaveLength(3);
        // Should be byte-for-byte identical (and the same object reference).
        expect(out[2]!.content).toBe(big);
        expect(out[2]).toBe(msgs[2]);
    });

    it('exempts the last unconsumed chain when the assistant emitted multiple parallel tool_calls', () => {
        const big1 = bigText();
        const big2 = bigText();
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'big_tool_a', arguments: '{}' },
                { id: 'tc2', name: 'big_tool_b', arguments: '{}' },
            ]),
            toolResult('tc1', big1),
            toolResult('tc2', big2),
        ];
        const out = shrink(msgs);
        // Both tail tool_results sit after the last assistant → both exempt.
        expect(out[2]!.content).toBe(big1);
        expect(out[3]!.content).toBe(big2);
    });

    it('still shrinks earlier (already-consumed) chains in a multi-turn history', () => {
        const oldBig = bigText();
        const newBig = bigText();
        const msgs: HistroyMessage[] = [
            // Turn 1 — already digested by the trailing assistant text below.
            user('first question'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'big_tool', arguments: '{}' },
            ]),
            toolResult('tc1', oldBig),
            assistant('first answer'),
            // Turn 2 — the just-produced tool_result that hasn't been
            // consumed yet. MUST stay intact.
            user('follow up'),
            assistantWithToolCalls('', [
                { id: 'tc2', name: 'big_tool', arguments: '{}' },
            ]),
            toolResult('tc2', newBig),
        ];
        const out = shrink(msgs);
        // Old result shrunk:
        expect(out[2]!.content).not.toBe(oldBig);
        expect(out[2]!.content).toContain('truncated');
        // New result preserved:
        expect(out[6]!.content).toBe(newBig);
    });

    it('does not shrink when a chained tool_call follows (model has not yet produced a text reply)', () => {
        // assistant → tool_result → assistant(toolCalls again, no content) → tool_result
        // The intermediate assistant *is* an assistant message, so by the
        // "last assistant" rule the FIRST tool_result is now considered
        // consumed (the model produced something — another tool_call —
        // after reading it). The SECOND tool_result is the unconsumed tail.
        const big1 = bigText();
        const big2 = bigText();
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'big_tool', arguments: '{}' },
            ]),
            toolResult('tc1', big1),
            assistantWithToolCalls('', [
                { id: 'tc2', name: 'big_tool', arguments: '{}' },
            ]),
            toolResult('tc2', big2),
        ];
        const out = shrink(msgs);
        // First tool_result was consumed (the model replied with another
        // tool_call) → shrunk.
        expect(out[2]!.content).not.toBe(big1);
        expect(out[2]!.content).toContain('truncated');
        // Second tool_result is the still-unconsumed tail → preserved.
        expect(out[4]!.content).toBe(big2);
    });

    it('exempts all tool_results when there is no assistant in the slice', () => {
        // Edge case: a slice that contains only tool_results (e.g. ill-
        // formed or unusually-sliced input). With no assistant anchor
        // present, every tool_result is treated as "not yet consumed by
        // any assistant turn" → all preserved verbatim. This is the safe
        // default — the alternative (shrink everything) would silently
        // lose payload that the model has never had a chance to read.
        const big = bigText();
        const msgs: HistroyMessage[] = [
            toolResult('tc1', big),
        ];
        const out = shrink(msgs);
        expect(out[0]!.content).toBe(big);
    });

    it('preserves error tool_results regardless of position', () => {
        // Errors are short and meaningful — the shrinker has always kept
        // them verbatim. The exemption rule must not regress that.
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'big_tool', arguments: '{}' },
            ]),
            toolResult('tc1', 'Error: file not found'),
            assistant('sorry, file is missing'),
        ];
        const out = shrink(msgs);
        expect(out[2]!.content).toBe('Error: file not found');
    });
});
