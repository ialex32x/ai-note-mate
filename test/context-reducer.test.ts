import { describe, it, expect } from 'vitest';
import { ContextReducer, HistroyMessage, tryParseDelegateEnvelope } from '../src/services/context-reducer';
import { buildDelegatePayload, DELEGATE_ENVELOPE_KIND, DELEGATE_ENVELOPE_VERSION } from '../src/services/agent-orchestrator';

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

// ─── tryParseDelegateEnvelope (B-0 detector contract) ──────────
//
// These tests pin the contract that future steps (B-1 shrink branch,
// E-2 recall_artifact) will rely on. The detector must:
//   1. Recognise the exact JSON shape `buildDelegatePayload` emits.
//   2. Reject anything that lacks the marker, even if it would deserialize
//      into an object with similar keys.
//   3. Reject anything that the runtime cannot safely consume — non-JSON,
//      partial JSON, wrong / unknown version. Forward-compat behavior
//      (unknown future versions degrade gracefully) is part of the contract.
//
// The detector is exposed at module scope (not as a static on
// ContextReducer) because it has no dependence on reducer state and
// the future B-1 / E-2 call sites will be in different files.
describe('tryParseDelegateEnvelope', () => {
    it('recognises a real envelope (empty store path) round-trip from buildDelegatePayload', () => {
        // Use the actual producer to guarantee the test moves with the
        // wire format. If `buildDelegatePayload` ever drops a marker,
        // this test will fail before B-1 / E-2 hit production.
        const envelope = buildDelegatePayload('hello world', new Map());
        const raw = JSON.stringify(envelope);

        const parsed = tryParseDelegateEnvelope(raw);

        expect(parsed).not.toBeNull();
        expect(parsed!.__kind).toBe(DELEGATE_ENVELOPE_KIND);
        expect(parsed!.__v).toBe(DELEGATE_ENVELOPE_VERSION);
        expect(parsed!.text).toBe('hello world');
    });

    it('recognises an envelope carrying result + extras + omitted', () => {
        // Hand-rolled to exercise all optional buckets at once. Avoids
        // depending on any oversized-input behavior in the orchestrator.
        const raw = JSON.stringify({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: DELEGATE_ENVELOPE_VERSION,
            text: 'summary',
            result: { ok: true, items: [1, 2, 3] },
            extras: { auxiliary_log: 'meh' },
            omitted: { huge_blob_omitted: true, huge_blob_size: 999_999 },
        });

        const parsed = tryParseDelegateEnvelope(raw);

        expect(parsed).not.toBeNull();
        expect(parsed!.text).toBe('summary');
        expect(parsed!.result).toEqual({ ok: true, items: [1, 2, 3] });
        expect(parsed!.extras).toEqual({ auxiliary_log: 'meh' });
        expect(parsed!.omitted).toEqual({ huge_blob_omitted: true, huge_blob_size: 999_999 });
    });

    it('rejects similar JSON that lacks the __kind marker', () => {
        // A future tool returning `{ text: "hi", result: {...} }` would
        // otherwise false-positive on shape alone. The marker is the
        // entire reason we have explicit discriminators.
        expect(tryParseDelegateEnvelope(JSON.stringify({ text: 'hi' }))).toBeNull();
        expect(tryParseDelegateEnvelope(JSON.stringify({ text: 'hi', result: { a: 1 } }))).toBeNull();
        expect(tryParseDelegateEnvelope(JSON.stringify({ __v: 1, text: 'hi' }))).toBeNull();
    });

    it('rejects JSON whose __kind is not the literal "delegate_envelope"', () => {
        // Defends against an unrelated tool deciding to emit some other
        // discriminator (e.g. `"some_other_envelope"`) — we should not
        // claim it as ours.
        const raw = JSON.stringify({
            __kind: 'some_other_kind',
            __v: 1,
            text: 'hi',
        });
        expect(tryParseDelegateEnvelope(raw)).toBeNull();
    });

    it('rejects an envelope with a missing or wrong __v (forward-compat: unknown future versions degrade)', () => {
        // Missing `__v`.
        expect(tryParseDelegateEnvelope(JSON.stringify({
            __kind: DELEGATE_ENVELOPE_KIND,
            text: 'hi',
        }))).toBeNull();

        // Wrong type for `__v`.
        expect(tryParseDelegateEnvelope(JSON.stringify({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: '1', // string, not number
            text: 'hi',
        }))).toBeNull();

        // A hypothetical future v2 envelope read by a v1 runtime: must
        // fall through to the generic path, never be mis-parsed. This
        // is the persistence-compat clause from plan doc §6.
        expect(tryParseDelegateEnvelope(JSON.stringify({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: 2,
            text: 'hi',
        }))).toBeNull();
    });

    it('rejects an envelope where text is missing or not a string', () => {
        // `text` is the only required free-form field beyond the
        // discriminators; a missing `text` means the envelope is malformed
        // and we should not claim to recognise it.
        expect(tryParseDelegateEnvelope(JSON.stringify({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: DELEGATE_ENVELOPE_VERSION,
        }))).toBeNull();

        expect(tryParseDelegateEnvelope(JSON.stringify({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: DELEGATE_ENVELOPE_VERSION,
            text: 42, // wrong type
        }))).toBeNull();
    });

    it('rejects non-JSON content', () => {
        // The vast majority of historical tool_results are plain strings
        // (file contents, search summaries, error messages). The detector
        // must be silent on these — both correct and cheap (the
        // looksLikeEnvelope precheck rejects them before parse).
        expect(tryParseDelegateEnvelope('')).toBeNull();
        expect(tryParseDelegateEnvelope('hello')).toBeNull();
        expect(tryParseDelegateEnvelope('Error: file not found')).toBeNull();
        expect(tryParseDelegateEnvelope('not { really } json')).toBeNull();
    });

    it('rejects partial / truncated JSON', () => {
        // Defensive: a tool result that was itself truncated by some
        // upstream layer might leave us with malformed JSON. Must not
        // throw — must return null.
        const half = JSON.stringify({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: DELEGATE_ENVELOPE_VERSION,
            text: 'hi',
        }).slice(0, 20);
        expect(tryParseDelegateEnvelope(half)).toBeNull();
    });

    it('rejects JSON arrays and primitives even if they parse', () => {
        // `JSON.parse('[1,2,3]')` succeeds — but it is not an envelope.
        // Same for `JSON.parse('null')` / `'42'` / `'"str"'`.
        expect(tryParseDelegateEnvelope('[1,2,3]')).toBeNull();
        expect(tryParseDelegateEnvelope('null')).toBeNull();
        expect(tryParseDelegateEnvelope('42')).toBeNull();
        expect(tryParseDelegateEnvelope('"a string"')).toBeNull();
    });

    it('does NOT throw when given pathological input', () => {
        // Robustness contract: this helper is on a hot path that runs
        // over every historical tool_result; throwing on weird input
        // would corrupt the entire shrink stage. Pin "never throws"
        // explicitly for a few adversarial shapes.
        expect(() => tryParseDelegateEnvelope('{')).not.toThrow();
        expect(() => tryParseDelegateEnvelope('{"__kind":')).not.toThrow();
        expect(() => tryParseDelegateEnvelope('{"__kind":"' + 'x'.repeat(10_000) + '"')).not.toThrow();
        // Very large plain text (no envelope marker in first 64 bytes):
        // the looksLikeEnvelope precheck must reject without parsing,
        // which is also the scenario where a slow-path parse would
        // hurt us most.
        expect(tryParseDelegateEnvelope('lorem ipsum '.repeat(10_000))).toBeNull();
    });
});

