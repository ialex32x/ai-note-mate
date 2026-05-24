import { describe, it, expect } from 'vitest';
import { ContextReducer, estimateTokens, isValidBudgetHint, HistroyMessage, tryParseDelegateEnvelope } from '../src/services/context-reducer';
import { ArtifactStore } from '../src/services/artifact-store';
import { DELEGATE_ENVELOPE_KIND, DELEGATE_ENVELOPE_VERSION, type DelegatePayload } from '../src/services/delegate-envelope-shape';

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
function shrink(
    messages: HistroyMessage[],
    store?: ArtifactStore,
): HistroyMessage[] {
    return (ContextReducer as any).shrinkLargeToolResults(messages, store ?? null);
}

// Generate a tool_result payload that's well above
// `TOOL_RESULT_COLLAPSE_THRESHOLD` (500 tokens, ~2k chars Latin) so the
// shrink rule will definitely fire when not exempted.
function bigText(): string {
    return 'lorem ipsum dolor sit amet '.repeat(400); // ~10.8k chars
}

/**
 * Build a `delegate_task` tool_result content (envelope JSON) sized
 * to comfortably exceed the shrink threshold. The fields we want to
 * spill (`result.payload`, `extras.notes`) are made individually
 * larger than `ENVELOPE_FIELD_SPILL_MIN_BYTES` (256 bytes) so the
 * spill path actually fires; otherwise the helper would return
 * `null` and the envelope would be left intact.
 *
 * Helper rather than inline JSON so each test reads the same
 * envelope shape buildDelegatePayload would emit at runtime.
 */
function envelopeContent(opts?: {
    text?: string;
    result?: unknown;
    extras?: Record<string, unknown>;
    omitted?: Record<string, true | number>;
    artifacts?: DelegatePayload['artifacts'];
}): string {
    const env: DelegatePayload = {
        __kind: DELEGATE_ENVELOPE_KIND,
        __v: DELEGATE_ENVELOPE_VERSION,
        text: opts?.text ?? 'sub-agent did its thing',
    };
    if (opts?.result !== undefined) env.result = opts.result;
    if (opts?.extras !== undefined) env.extras = opts.extras;
    if (opts?.omitted !== undefined) env.omitted = opts.omitted;
    if (opts?.artifacts !== undefined) env.artifacts = opts.artifacts;
    return JSON.stringify(env);
}

/**
 * Big payload that comfortably exceeds the per-field min spill size
 * (256 bytes) but stays well under the artifact store's per-entry cap
 * (128 KB). Picked to be JSON-friendly so we can assert byte-for-byte
 * round-trips through the store.
 */
function bigPayload(label: string): { items: Array<{ id: number; body: string }> } {
    return {
        items: Array.from({ length: 30 }, (_, i) => ({
            id: i,
            body: `${label}: ` + 'x'.repeat(50),
        })),
    };
}

// ─── Tests ─────────────────────────────────────────────────

describe('ContextReducer budget hints', () => {
    it('records contentBudgetHint on shrink without dropping the full body from the source buffer', () => {
        const full = bigText();
        const raw: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [{ id: 'r1', name: 'read_file', arguments: '{}' }]),
            toolResult('r1', full),
            assistant('done'),
        ];
        const sent = shrink(raw);
        const sentResult = sent.find(m => m.role === 'tool_result')!;
        expect(sentResult.contentBudgetHint).toBeDefined();
        expect(sentResult.contentBudgetHintForLength).toBe(full.length);
        expect(sentResult.content).not.toBe(full);
        expect(estimateTokens(sentResult.contentBudgetHint!)).toBeLessThan(estimateTokens(full));

        ContextReducer.backfillBudgetHints(sent, raw);
        const rawResult = raw.find(m => m.role === 'tool_result')!;
        expect(rawResult.content).toBe(full);
        expect(rawResult.contentBudgetHint).toBe(sentResult.contentBudgetHint);
        expect(rawResult.contentBudgetHintForLength).toBe(full.length);
        expect(isValidBudgetHint(rawResult)).toBe(true);

        const secondPass = shrink(raw);
        const secondResult = secondPass.find(m => m.role === 'tool_result')!;
        expect(secondResult.content).toBe(sentResult.contentBudgetHint);
    });

    it('does not apply a stale budget hint when tool_result content changed', () => {
        const full = bigText();
        const raw: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [{ id: 'r1', name: 'read_file', arguments: '{}' }]),
            toolResult('r1', full),
            assistant('done'),
        ];
        const sent = shrink(raw);
        ContextReducer.backfillBudgetHints(sent, raw);
        const rawResult = raw.find(m => m.role === 'tool_result')!;
        rawResult.content = full + '-edited';
        expect(isValidBudgetHint(rawResult)).toBe(false);
        expect(rawResult.contentBudgetHintForLength).toBe(full.length);
        // Stale hint must not match → a fresh shrink pass still sees the new body.
        const reshunk = shrink(raw);
        expect(reshunk.find(m => m.role === 'tool_result')!.content).not.toBe(rawResult.contentBudgetHint);
    });
});

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
        //
        // Every assistant in this sequence is a **pure tool-call turn**
        // (empty content, only toolCalls). A pure tool-call assistant
        // does NOT summarise the prior tool_result — it forwards it
        // inline via toolCall arguments and chains the next step. That
        // means the FIRST tool_result is still in the model's active
        // reasoning chain even after the second assistant emits its
        // toolCall, and shrinking it here would force the model to
        // "re-derive" the same payload on a later iteration (typically
        // by re-running the same expensive tool — the loop reported in
        // the wild as `read_file → write_handoff → read_file → ...`,
        // i.e. the agent "走两步就完全忘了自己干过什么了").
        //
        // The contract is therefore: only a **content-bearing**
        // assistant turn (non-empty `content`) closes the active chain
        // and makes preceding tool_results eligible for shrinking. See
        // the dedicated regression case below for the exact loop shape
        // the wild bug exhibits.
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
        // No content-bearing assistant exists anywhere → the entire
        // chain is "active". Both tool_results MUST be preserved
        // verbatim.
        expect(out[2]!.content).toBe(big1);
        expect(out[4]!.content).toBe(big2);
    });

    /**
     * REGRESSION — vault_inspector "read_file → write_handoff →
     * read_file → write_handoff" loop.
     *
     * The reported wild symptom: a sub-agent reads a file in full,
     * hands its content off via `write_handoff`, and then on the very
     * next iteration of the same `prompt()` loop re-runs `read_file`
     * on the same path and writes the result a second time — all
     * within one user-visible turn.
     *
     * Mechanism (pre-fix): `shrinkLargeToolResults` is invoked inside
     * `reduce()` at the start of every LLM round-trip even on the
     * "no compression needed" path. Its consumed-tail heuristic took
     * "the LAST assistant message" as the boundary between consumed
     * and unconsumed tool_results. After iter 2 emitted its
     * `write_handoff` toolCall (a pure tool-call assistant — empty
     * content), the read_file's tool_result was now BEFORE the latest
     * assistant and therefore "consumed" → shrunk to a
     * `[Tool result truncated: …]` placeholder on the next iter's
     * reduce. The model, no longer able to see its own file content,
     * decided to fetch it again.
     *
     * Fix: only a content-bearing assistant counts as a consumption
     * boundary. The active reasoning chain (pure-tool-call iterations
     * threading data forward through toolCall arguments) stays exempt.
     */
    it('preserves the tool_result inside an active read_file → write_handoff chain', () => {
        const fileBody = bigText(); // simulates a full file read
        const msgs: HistroyMessage[] = [
            // Sub-agent task description.
            user('Read file X and store its content into the result key of the handoff.'),
            // iter 1 — pure tool-call: read_file
            assistantWithToolCalls('', [
                { id: 'read1', name: 'read_file', arguments: JSON.stringify({ path: 'X' }) },
            ]),
            toolResult('read1', fileBody),
            // iter 2 — pure tool-call: write_handoff forwards the file
            // content via its toolCall arguments. Crucially this
            // assistant has NO prose content, so it is NOT a
            // consumption boundary.
            assistantWithToolCalls('', [
                { id: 'put1', name: 'write_handoff', arguments: JSON.stringify({ key: 'result', value: '<<file body>>' }) },
            ]),
            toolResult('put1', 'OK: stored 1 entry'),
            // iter 3 is about to start: reduce() is called with all
            // five messages above. The read_file result MUST remain
            // intact for the model to plan the next step.
        ];
        const out = shrink(msgs);

        const readResult = out.find(m => m.role === 'tool_result' && (m as any).toolCallId === 'read1');
        expect(readResult).toBeDefined();
        // The full file body must survive — shrinking it forces the
        // model into the "走两步就忘 → re-read" loop reported in the
        // wild.
        expect(readResult!.content).toBe(fileBody);
        expect(readResult!.content).not.toContain('truncated');

        // The small put_ack is below the threshold and stays intact
        // for unrelated reasons; the assertion is included as a
        // belt-and-braces guard against accidental over-shrinking.
        const putResult = out.find(m => m.role === 'tool_result' && (m as any).toolCallId === 'put1');
        expect(putResult!.content).toBe('OK: stored 1 entry');
    });

    it('still shrinks a tool_result once a content-bearing assistant has summarised it (chain closed)', () => {
        // Same shape as the regression above but with a final assistant
        // that emits prose. Once the chain is closed by a content-bearing
        // turn, the early tool_result is genuinely "consumed" and the
        // shrink rule fires — exactly as it did pre-fix for the chain-
        // closing case.
        const fileBody = bigText();
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'read1', name: 'read_file', arguments: '{}' },
            ]),
            toolResult('read1', fileBody),
            assistantWithToolCalls('', [
                { id: 'put1', name: 'write_handoff', arguments: '{}' },
            ]),
            toolResult('put1', 'OK'),
            // Chain-closing prose. Now everything before it is fair game.
            assistant('Done — stored the file content under `result`.'),
        ];
        const out = shrink(msgs);
        const readResult = out.find(m => m.role === 'tool_result' && (m as any).toolCallId === 'read1');
        expect(readResult!.content).not.toBe(fileBody);
        expect(readResult!.content).toContain('truncated');
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

// ─── B-1: envelope-aware shrink (spill into ArtifactStore) ────────
//
// The pre-B-1 path collapses every oversized tool_result to a
// `[Tool result truncated: …]` meta string, which loses the entire
// structured `result` / `extras` channel of a `delegate_task` envelope.
// B-1 changes this for envelopes specifically: instead of collapsing,
// rewrite the envelope so that bulky inline fields move into a per-
// session artifact store and the envelope retains a recoverable
// reference (`payload.artifacts[k]`).
//
// What these tests pin down:
//   1. The envelope structure survives the shrink (kind/version/text/
//      omitted/pre-existing artifacts all preserved).
//   2. The store actually gets the original value, byte-for-byte
//      (covers the recall_artifact contract that B-1 feeds into).
//   3. Without a store OR without a toolCallId, the legacy generic
//      truncation runs unchanged — backward compat.
//   4. Stage-1 exemption (last unconsumed tool_result) still wins.
//   5. Idempotency: an already-shrunk envelope (no spillable inline
//      fields left) is left alone, NOT collapsed to a meta string.
//   6. Mutual exclusion: pre-existing `artifacts[k]` (E-3 build-time
//      promotion) is not double-spilled; pre-existing `omitted` keys
//      are kept.
//   7. Store rejection (too_large_for_store) flows into `omitted`
//      with the standard `_too_large_for_store` flag, matching E-3's
//      build-time bucket-3 markers.

describe('ContextReducer.shrinkLargeToolResults — B-1 envelope spill', () => {
    it('spills inline `result` into the artifact store and emits an ArtifactRef', () => {
        const store = new ArtifactStore();
        const result = bigPayload('A');
        const env = envelopeContent({ text: 'done', result });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            // Trailing assistant text → tc1 is "consumed" → eligible to shrink.
            assistant('summary text'),
        ];

        const out = shrink(msgs, store);
        const rewritten = out[2]!.content;

        // Still a valid envelope (structure preserved).
        const parsed = tryParseDelegateEnvelope(rewritten);
        expect(parsed).not.toBeNull();
        expect(parsed!.text).toBe('done');
        expect(parsed!.__kind).toBe(DELEGATE_ENVELOPE_KIND);
        expect(parsed!.__v).toBe(DELEGATE_ENVELOPE_VERSION);

        // Inline `result` is gone, replaced by an artifact ref.
        expect(parsed!.result).toBeUndefined();
        expect(parsed!.artifacts).toBeDefined();
        expect(parsed!.artifacts!.result).toBeDefined();
        expect(parsed!.artifacts!.result.reason).toBe('shrunk');
        // Key is auto-generated — should be a non-empty string.
        const artifactKey = parsed!.artifacts!.result.key;
        expect(typeof artifactKey).toBe('string');
        expect(artifactKey.length).toBeGreaterThan(0);
        expect(parsed!.artifacts!.result.size).toBeGreaterThan(0);

        // Store has the original value byte-for-byte (recall contract).
        const got = store.get(artifactKey);
        expect(got.found).toBe(true);
        if (got.found) expect(got.value).toEqual(result);

        // toolCallId pairing preserved.
        expect((out[2] as any).toolCallId).toBe('tc1');
    });

    it('spills each `extras` field independently and keeps small ones inline', () => {
        const store = new ArtifactStore();
        const big = bigPayload('B');
        const env = envelopeContent({
            text: 'done',
            extras: {
                big_log: big,
                tiny_note: 'short string', // < 256 bytes, must stay inline
            },
        });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            assistant('ack'),
        ];

        const out = shrink(msgs, store);
        const parsed = tryParseDelegateEnvelope(out[2]!.content)!;

        // Big extras field promoted.
        expect(parsed.artifacts!.big_log).toBeDefined();
        expect(parsed.artifacts!.big_log.reason).toBe('shrunk');
        expect(parsed.extras?.big_log).toBeUndefined();

        // Tiny extras field stays inline.
        expect(parsed.extras?.tiny_note).toBe('short string');

        // Store contains the spilled big_log via its auto-generated key.
        const bigLogKey = parsed.artifacts!.big_log.key;
        expect(typeof bigLogKey).toBe('string');
        expect(bigLogKey.length).toBeGreaterThan(0);
        const got = store.get(bigLogKey);
        expect(got.found).toBe(true);
        if (got.found) expect(got.value).toEqual(big);
    });

    it('preserves pre-existing `artifacts` (E-3 build-time promotion) without re-spilling', () => {
        const store = new ArtifactStore();
        // Simulate an envelope where E-3 already promoted `result` at
        // build time. The shrink stage MUST NOT re-spill or rename it,
        // because the stored value already lives under the build-time
        // key.
        const preExisting: NonNullable<DelegatePayload['artifacts']> = {
            result: {
                key: '1738000000000-abc1234',
                size: 99_000,
                preview: '{"payload":[…',
                reason: 'oversize',
            },
        };
        const env = envelopeContent({
            text: 'done',
            extras: { big_log: bigPayload('C') },
            artifacts: preExisting,
        });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            assistant('ack'),
        ];

        const out = shrink(msgs, store);
        const parsed = tryParseDelegateEnvelope(out[2]!.content)!;

        // Pre-existing artifact entry is kept verbatim (same key, same reason).
        expect(parsed.artifacts!.result).toEqual(preExisting.result);

        // The newly-shrunk extras field gets the shrink reason and an auto-generated key.
        expect(parsed.artifacts!.big_log.reason).toBe('shrunk');
        expect(typeof parsed.artifacts!.big_log.key).toBe('string');
        expect(parsed.artifacts!.big_log.key.length).toBeGreaterThan(0);
    });

    it('keeps pre-existing `omitted` markers and stays out of their way', () => {
        const store = new ArtifactStore();
        const env = envelopeContent({
            text: 'done',
            result: bigPayload('D'),
            omitted: { huge_blob_omitted: true, huge_blob_size: 999_999 },
        });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            assistant('ack'),
        ];

        const out = shrink(msgs, store);
        const parsed = tryParseDelegateEnvelope(out[2]!.content)!;

        // Original omitted markers preserved unchanged.
        expect(parsed.omitted).toMatchObject({
            huge_blob_omitted: true,
            huge_blob_size: 999_999,
        });
        // Result was promoted to artifacts (not added to omitted).
        expect(parsed.artifacts!.result).toBeDefined();
    });

    it('flags store-rejected fields with `_too_large_for_store`', () => {
        // A store with an artificially tiny per-entry cap so any spill
        // attempt is rejected. This exercises the bucket-3 fallback
        // path: rejected fields move into `omitted` with the same
        // `_too_large_for_store` flag E-3 emits at build time, so the
        // LLM cannot tell whether the drop happened at build or shrink.
        const store = new ArtifactStore({ singleArtifactCap: 100 });
        const env = envelopeContent({ text: 'done', result: bigPayload('E') });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            assistant('ack'),
        ];

        const out = shrink(msgs, store);
        const parsed = tryParseDelegateEnvelope(out[2]!.content)!;

        // Inline result is gone, but NOT in artifacts (store rejected).
        expect(parsed.result).toBeUndefined();
        expect(parsed.artifacts?.result).toBeUndefined();
        // Instead, the field is recorded as omitted with the rejection flag.
        expect(parsed.omitted).toBeDefined();
        expect(parsed.omitted!.result_omitted).toBe(true);
        expect(parsed.omitted!.result_too_large_for_store).toBe(true);
        expect(typeof parsed.omitted!.result_size).toBe('number');
    });

    it('falls back to legacy truncation when no store is provided', () => {
        // Single-agent mode / tests / exotic call paths: without a store,
        // an envelope is treated like any other oversized JSON object,
        // which is exactly the pre-B-1 behaviour. Backward-compat clause.
        const env = envelopeContent({ text: 'done', result: bigPayload('F') });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            assistant('ack'),
        ];

        const out = shrink(msgs); // no store
        // Legacy generic truncation: opaque meta string, not a parseable envelope.
        expect(out[2]!.content).toContain('truncated');
        expect(tryParseDelegateEnvelope(out[2]!.content)).toBeNull();
    });

    it('falls back to legacy truncation when the tool_result has no toolCallId', () => {
        // Without a toolCallId we cannot mint a collision-free key. The
        // safe choice is to take the legacy path rather than risk a key
        // namespaced by something the orchestrator might reuse.
        const store = new ArtifactStore();
        const env = envelopeContent({ text: 'done', result: bigPayload('G') });

        // Manually construct the message without a toolCallId.
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            { role: 'tool_result', content: env } as any,
            assistant('ack'),
        ];

        const out = shrink(msgs, store);
        expect(out[2]!.content).toContain('truncated');
        expect(tryParseDelegateEnvelope(out[2]!.content)).toBeNull();
        // Store untouched — nothing was spilled.
        expect(store.stats().liveCount).toBe(0);
    });

    it('exempts the last unconsumed envelope from spilling (stage-1 rule)', () => {
        // Stage-1 exemption is the foundational rule of the shrink
        // stage: the most recent tool_result hasn't been seen by any
        // assistant turn yet. Spilling its `result` into the store
        // would defeat the purpose of the delegate_task call (the
        // main agent is about to read the value RIGHT NOW). B-1 must
        // not regress this — verify by leaving no trailing assistant
        // after the envelope tool_result.
        const store = new ArtifactStore();
        const env = envelopeContent({ text: 'done', result: bigPayload('H') });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            // No trailing assistant → tc1 is the unconsumed tail.
        ];

        const out = shrink(msgs, store);
        // Original content preserved byte-for-byte; same object reference.
        expect(out[2]!.content).toBe(env);
        expect(out[2]).toBe(msgs[2]);
        // Store untouched.
        expect(store.stats().liveCount).toBe(0);
    });

    it('is idempotent: an already-shrunk envelope is left alone (not collapsed)', () => {
        // After B-1 runs once on a turn, the envelope still parses (the
        // shape is intact, just with the `result` moved to `artifacts`).
        // The next reduce pass MUST recognise that there's nothing
        // spillable left and keep the envelope as-is rather than fall
        // through to the generic truncation path — that would lose the
        // recoverable artifact reference and the LLM's ability to
        // recall_artifact would silently break.
        const store = new ArtifactStore();
        const env = envelopeContent({ text: 'done', result: bigPayload('I') });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            assistant('first reply'),
        ];

        // First pass: do the spill.
        const firstOut = shrink(msgs, store);
        const firstShrunk = firstOut[2]!.content;
        const firstParsed = tryParseDelegateEnvelope(firstShrunk)!;
        expect(firstParsed.artifacts?.result).toBeDefined();

        // Second pass: feed the already-shrunk envelope back in.
        const replayMsgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', firstShrunk),
            assistant('first reply'),
            user('follow up'),
            assistant('second reply'),
        ];
        const secondOut = shrink(replayMsgs, store);
        // Same content — no further mutation. Crucially NOT a `[Tool
        // result truncated: …]` meta string.
        expect(secondOut[2]!.content).toBe(firstShrunk);
        expect(tryParseDelegateEnvelope(secondOut[2]!.content)).not.toBeNull();
    });

    it('leaves an envelope with no spillable fields intact (does NOT collapse it)', () => {
        // An envelope that's nominally large only because of `text`
        // (e.g. a verbose narrative summary, no structured payload).
        // There's nothing to spill — but collapsing it to `[Tool result
        // truncated…]` would lose the envelope shape for no real
        // budget gain, since the bulk is exactly the field we'd want
        // the model to read. The B-1 design returns null from the
        // spiller in this case and the caller keeps the original.
        const store = new ArtifactStore();
        // Only `text` is large; result is small and stays inline.
        // Note: helper text is small by default so we inflate it here.
        const env = envelopeContent({
            text: 'narrative summary: ' + 'x'.repeat(8000),
            result: { ok: true }, // way under the 256-byte spill min
        });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'delegate_task', arguments: '{}' },
            ]),
            toolResult('tc1', env),
            assistant('ack'),
        ];

        const out = shrink(msgs, store);
        // Original envelope kept; not collapsed to a meta string.
        expect(out[2]!.content).toBe(env);
        expect(store.stats().liveCount).toBe(0);
    });

    it('stores generic (non-envelope) JSON tool_results in the artifact store with a recall key', () => {
        // Phase 0: a non-envelope JSON tool_result (e.g. a vault search)
        // that exceeds the shrink threshold is now stored as an artifact
        // so the LLM can retrieve it via `recall_artifact`. The truncated
        // message includes the artifact key for the LLM to reference.
        const store = new ArtifactStore();
        const plainJson = JSON.stringify({
            results: Array.from({ length: 50 }, (_, i) => ({ id: i, body: 'x'.repeat(100) })),
        });

        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'search', arguments: '{}' },
            ]),
            toolResult('tc1', plainJson),
            assistant('ack'),
        ];

        const out = shrink(msgs, store);
        // Still truncated with JSON object summary.
        expect(out[2]!.content).toContain('truncated');
        expect(out[2]!.content).toContain('JSON object');
        // Phase 0: the truncated message now includes an artifact recall hint
        // with the auto-generated key.
        expect(out[2]!.content).toContain('recall_artifact(key="');
        // Store now has the original content, recoverable via recall_artifact.
        expect(store.stats().liveCount).toBe(1);
        // Extract the key from the hint and verify the store has the value.
        const hintMatch = (out[2]!.content as string).match(/recall_artifact\(key="([^"]+)"\)/);
        expect(hintMatch).not.toBeNull();
        const artifactKey = hintMatch![1]!;
        const got = store.get(artifactKey);
        expect(got.found).toBe(true);
        if (got.found) expect(got.value).toBe(plainJson);
    });
});

// ─────────────────────────────────────────────────────────────────────
// emergencyShrink — incremental, oldest-first
// ─────────────────────────────────────────────────────────────────────
//
// `emergencyShrink` is the last-resort budget guard that fires when the
// assembled prompt is still over `min(threshold * 1.5, modelWindow * 0.708)`
// after the primary `shrinkLargeToolResults` pass. After the active-chain
// exemption rewrite, this is the ONLY way a tool_result inside the
// active reasoning chain ever gets truncated, so its sub-strategy
// directly determines whether a sub-agent that legitimately reads
// several large files in one turn loses its earliest reads piecewise
// (acceptable degradation) or its entire history at once (the
// "走两步就忘 → re-read everything → loop" pathology this whole shrink
// stage was meant to prevent).
//
// Contract pinned here:
//   1. Walk tool_results oldest-first; stop the moment the running
//      total drops back under the emergency line.
//   2. The most-recent tool_results survive verbatim whenever the
//      budget allows.
//   3. The output array always preserves message ordering, role,
//      toolCallId, and the structural assistant→tool_result pairing
//      so `validateAndSanitizeForLLM` doesn't drop anything.

function emergencyShrink(
    messages: HistroyMessage[],
    options: {
        accessoryTokens?: number;
        threshold: number;
        store?: ArtifactStore | null;
        modelContextWindow?: number;
    },
): { messages: HistroyMessage[]; shrunk: boolean } {
    return (ContextReducer as any).emergencyShrink(
        messages,
        options.accessoryTokens ?? 0,
        options.threshold,
        options.store ?? null,
        options.modelContextWindow ?? 0,
    );
}

describe('ContextReducer.emergencyShrink', () => {
    it('returns the input unchanged when total is at or below the emergency line', () => {
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [
                { id: 'tc1', name: 'small_tool', arguments: '{}' },
            ]),
            toolResult('tc1', 'tiny result'),
        ];
        // threshold * 1.5 = 15000 estimated tokens — way above this fixture.
        const result = emergencyShrink(msgs, { threshold: 10_000 });
        expect(result.shrunk).toBe(false);
        expect(result.messages).toBe(msgs); // identity, no copy
    });

    /**
     * REGRESSION — multi-read active chain at the emergency line.
     *
     * Before this rewrite, hitting the emergency line invoked
     * `shrinkLargeToolResults` with `forceShrinkAll=true`, which
     * blindly truncated every oversized tool_result regardless of
     * position. For an active chain that legitimately needed several
     * large reads in one turn (the user-reported `read_file →
     * write_handoff → read_file → ...` shape), that meant every read
     * became a `[Tool result truncated: …]` placeholder on the very
     * next reduce — exactly the symptom that brought us here.
     *
     * After the rewrite, only the OLDEST oversized tool_result(s) are
     * shrunk, and only as many as needed to fit. The most recent
     * tool_results survive verbatim, so the model still has fresh
     * content to reason over and at most "loses" the earliest read
     * (which it had the longest time to absorb anyway, and which is
     * usually already paraphrased into the next pure-tool-call
     * assistant's toolCall arguments).
     */
    it('shrinks oldest tool_result first and stops as soon as the prompt fits', () => {
        const big = bigText(); // ~2700 estimated tokens each
        // 4 large reads in an active chain — no content-bearing assistant
        // anywhere, so primary shrink leaves them all intact and
        // emergencyShrink is the only knob.
        const msgs: HistroyMessage[] = [
            user('Read several files for analysis.'),
            assistantWithToolCalls('', [{ id: 'r1', name: 'read_file', arguments: '{}' }]),
            toolResult('r1', big),
            assistantWithToolCalls('', [{ id: 'r2', name: 'read_file', arguments: '{}' }]),
            toolResult('r2', big),
            assistantWithToolCalls('', [{ id: 'r3', name: 'read_file', arguments: '{}' }]),
            toolResult('r3', big),
            assistantWithToolCalls('', [{ id: 'r4', name: 'read_file', arguments: '{}' }]),
            toolResult('r4', big),
        ];

        // Emergency line = threshold * 1.5 = 6000. Total ≈ 4 * 2700 ≈ 10800.
        // We need to shed ~4800 tokens; one shrink (~2700 saved) is not
        // enough, two shrinks (~5400 saved) suffice. So r1 + r2 should be
        // shrunk and r3 + r4 should survive.
        const result = emergencyShrink(msgs, { threshold: 4000 });
        expect(result.shrunk).toBe(true);

        const r1 = result.messages.find(m => (m as any).toolCallId === 'r1')!;
        const r2 = result.messages.find(m => (m as any).toolCallId === 'r2')!;
        const r3 = result.messages.find(m => (m as any).toolCallId === 'r3')!;
        const r4 = result.messages.find(m => (m as any).toolCallId === 'r4')!;

        // Oldest two were shrunk to fit the budget.
        expect(r1.content).not.toBe(big);
        expect(r1.content).toContain('truncated');
        expect(r2.content).not.toBe(big);
        expect(r2.content).toContain('truncated');
        // The newest two survive verbatim — the model can still see what it just read.
        expect(r3.content).toBe(big);
        expect(r4.content).toBe(big);
    });

    it('preserves all tool_results when shrinking just the earliest one is enough', () => {
        const big = bigText();
        // 3 large reads. Emergency line tuned so a single shrink suffices.
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [{ id: 'r1', name: 'read_file', arguments: '{}' }]),
            toolResult('r1', big),
            assistantWithToolCalls('', [{ id: 'r2', name: 'read_file', arguments: '{}' }]),
            toolResult('r2', big),
            assistantWithToolCalls('', [{ id: 'r3', name: 'read_file', arguments: '{}' }]),
            toolResult('r3', big),
        ];
        // 3 * 2700 ≈ 8100. Emergency line = 6000 (threshold 4000 * 1.5).
        // Shrinking r1 alone drops total by ~2700 → ~5400, well under 6000.
        const result = emergencyShrink(msgs, { threshold: 4000 });
        expect(result.shrunk).toBe(true);

        const r1 = result.messages.find(m => (m as any).toolCallId === 'r1')!;
        const r2 = result.messages.find(m => (m as any).toolCallId === 'r2')!;
        const r3 = result.messages.find(m => (m as any).toolCallId === 'r3')!;
        expect(r1.content).not.toBe(big); // shrunk
        // Both later reads must remain intact — this is the primary
        // contract that prevents the multi-read active chain from
        // collapsing into the loop pathology.
        expect(r2.content).toBe(big);
        expect(r3.content).toBe(big);
    });

    it('returns shrunk=false and the original array when nothing is shrinkable', () => {
        // Only small tool_results — none cross TOOL_RESULT_COLLAPSE_THRESHOLD,
        // and the prompt's bulk lives in user/assistant prose. Emergency
        // shrink can't help here.
        const longUserMsg = 'x'.repeat(50_000); // ~12500 estimated tokens
        const msgs: HistroyMessage[] = [
            user(longUserMsg),
            assistantWithToolCalls('', [{ id: 'tc1', name: 'small_tool', arguments: '{}' }]),
            toolResult('tc1', 'tiny'),
        ];
        const result = emergencyShrink(msgs, { threshold: 4000 }); // line = 6000
        expect(result.shrunk).toBe(false);
        expect(result.messages).toBe(msgs);
    });

    it('preserves message ordering and structural pairing after incremental shrink', () => {
        const big = bigText();
        const msgs: HistroyMessage[] = [
            user('q'),
            assistantWithToolCalls('', [{ id: 'r1', name: 'tool', arguments: '{}' }]),
            toolResult('r1', big),
            assistantWithToolCalls('', [{ id: 'r2', name: 'tool', arguments: '{}' }]),
            toolResult('r2', big),
        ];
        const result = emergencyShrink(msgs, { threshold: 1000 }); // forces shrink
        expect(result.messages).toHaveLength(msgs.length);
        const roles = result.messages.map(m => m.role);
        expect(roles).toEqual(['user', 'assistant', 'tool_result', 'assistant', 'tool_result']);
        // toolCallId pairing must survive — `validateAndSanitizeForLLM`
        // would otherwise drop the result as an orphan.
        expect((result.messages[2] as any).toolCallId).toBe('r1');
        expect((result.messages[4] as any).toolCallId).toBe('r2');
    });
});
