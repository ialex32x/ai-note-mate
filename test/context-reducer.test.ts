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

// ─────────────────────────────────────────────────────────────────────
// validateAndSanitizeForLLM — pre-sanitize correctness
// ─────────────────────────────────────────────────────────────────────
//
// Private method, accessed via `as any`. Covers the protocol-level
// invariants the assembled prompt must satisfy before going on the wire:
//   * every tool_result has an assistant(toolCalls) "owner" with a
//     matching id;
//   * an assistant(toolCalls) is followed by N tool_results, gaps in
//     the middle become placeholders, gaps at the end degrade or drop
//     the assistant;
//   * no leading orphan tool_result, no empty assistant.
//
// Regression coverage focuses on shapes that ChatStream actually
// produces in `rawMessages` — in particular the **media-injection
// interleave** scenario: when a tool returns multimodal content,
// ChatStream pushes a synthetic `user` message right after that
// tool_result so the LLM can perceive the bytes (tool-role messages
// are text-only on OpenAI/Gemini). Any sibling tool_result emitted
// in the *same* assistant turn for a different toolCall id then ends
// up sitting AFTER that synthetic user message — and pre-sanitize
// must still recognise its owner.

function sanitize(messages: HistroyMessage[]): HistroyMessage[] {
    return (ContextReducer as any).validateAndSanitizeForLLM(messages);
}

/** A `user` message with a `media` field — the shape ChatStream injects after a media tool_result. */
function userMedia(content: string): HistroyMessage {
    return { role: 'user', content, media: [{ kind: 'image', mimeType: 'image/png', base64: 'AAA' }] } as any;
}

describe('ContextReducer.validateAndSanitizeForLLM (pre-sanitize)', () => {
    it('passes a clean text-only flow through unchanged', () => {
        const msgs: HistroyMessage[] = [
            user('find X'),
            assistantWithToolCalls('let me search', [
                { id: 'tc1', name: 'grep_file', arguments: '{}' },
            ]),
            toolResult('tc1', 'matches: [...]'),
            assistant('found at line 87'),
        ];
        const out = sanitize(msgs);
        expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool_result', 'assistant']);
        // Nothing replaced with a placeholder.
        const placeholders = out.filter(m =>
            typeof m.content === 'string' &&
            m.content.includes('[Error: tool result missing after context compression]'),
        );
        expect(placeholders).toEqual([]);
    });

    it('keeps a multi-toolCall batch intact when no media is involved', () => {
        const msgs: HistroyMessage[] = [
            user('do A and B'),
            assistantWithToolCalls('', [
                { id: 'A', name: 'tool_a', arguments: '{}' },
                { id: 'B', name: 'tool_b', arguments: '{}' },
            ]),
            toolResult('A', 'result A'),
            toolResult('B', 'result B'),
            assistant('done'),
        ];
        const out = sanitize(msgs);
        expect(out.map(m => `${m.role}:${(m as any).toolCallId ?? ''}`)).toEqual([
            'user:', 'assistant:', 'tool_result:A', 'tool_result:B', 'assistant:',
        ]);
    });

    /**
     * REGRESSION — media-injection interleave.
     *
     * ChatStream produces this shape when a multi-toolCall batch
     * contains *one* tool that returns media (image/audio/video/pdf):
     *   assistant(toolCalls=[A,B,C])
     *   tool_result A   ← media-returning tool
     *   user(media)     ← injected so LLM can perceive A's bytes
     *   tool_result B   ← regular text tool
     *   tool_result C   ← regular text tool
     *
     * pass1's owner walk only steps back over `tool_result`, so when
     * it processes B / C it stops at `user(media)`, fails the owner
     * check and DROPS them. pass2 then sees the assistant has
     * missing tool_result ids and inserts synthetic placeholders
     * "[Error: tool result missing after context compression]".
     *
     * From the model's POV this looks like its own tool calls failed
     * — so it retries the whole batch on the next iteration. With
     * the same media-returning tool in the batch, the bug repeats
     * verbatim, and the agent loops "as if it forgot what it just
     * did after two steps". The expected behaviour: B and C survive
     * intact, no placeholders are inserted.
     */
    it('does NOT drop sibling tool_results when a peer tool injects a user(media) message between them', () => {
        const msgs: HistroyMessage[] = [
            user('describe the image and also list its bytes'),
            assistantWithToolCalls('', [
                { id: 'A', name: 'read_file_image', arguments: '{}' },
                { id: 'B', name: 'tool_b', arguments: '{}' },
                { id: 'C', name: 'tool_c', arguments: '{}' },
            ]),
            toolResult('A', '{"path":"img.png","kind":"image"}'),
            userMedia('[Image content from img.png]'),
            toolResult('B', 'result B'),
            toolResult('C', 'result C'),
            assistant('here is the analysis'),
        ];

        const out = sanitize(msgs);

        const surviving = out
            .filter(m => m.role === 'tool_result')
            .map(m => (m as any).toolCallId);
        // ALL three tool_results must reach the LLM. Dropping B/C
        // because of the media interleave is the exact bug we're
        // fixing.
        expect(surviving).toEqual(['A', 'B', 'C']);

        // No "missing tool result" placeholders should be synthesised
        // — every toolCall id has a real result already.
        const placeholders = out.filter(m =>
            typeof m.content === 'string' &&
            m.content.includes('[Error: tool result missing after context compression]'),
        );
        expect(placeholders).toEqual([]);

        // The user(media) message itself stays in the prompt so the
        // LLM still receives the multimodal bytes.
        const mediaMsgs = out.filter(m =>
            m.role === 'user' && Array.isArray((m as any).media) && (m as any).media.length > 0,
        );
        expect(mediaMsgs).toHaveLength(1);
    });

    it('drops a leading orphan tool_result with no preceding assistant', () => {
        const msgs: HistroyMessage[] = [
            toolResult('orphan', 'no owner'),
            user('hi'),
        ];
        const out = sanitize(msgs);
        expect(out.map(m => m.role)).toEqual(['user']);
    });

    it('drops a tool_result whose toolCallId does not match its assistant owner', () => {
        const msgs: HistroyMessage[] = [
            user('do A'),
            assistantWithToolCalls('', [
                { id: 'A', name: 'tool_a', arguments: '{}' },
            ]),
            toolResult('Z', 'wrong id'),
            assistant('done'),
        ];
        const out = sanitize(msgs);
        // The Z tool_result is dropped (orphan), and pass2 then
        // fills the missing A with a placeholder so the assistant
        // still has a paired result before the next assistant turn.
        const ids = out
            .filter(m => m.role === 'tool_result')
            .map(m => (m as any).toolCallId);
        expect(ids).toEqual(['A']);
    });
});

