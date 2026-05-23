import { describe, it, expect, vi } from 'vitest';
import { AgentOrchestrator, buildDelegatePayload, buildInitialStore, DELEGATE_ENVELOPE_KIND, DELEGATE_ENVELOPE_VERSION, HANDOFF_VALUE_MAX_BYTES, InvalidDelegateInputError } from '../src/services/agent-orchestrator';
import type { SubAgentConfig } from '../src/services/sub-agent';
import type { HandoffStore } from '../src/services/tools/handoff-toolcall';
import type { RegisteredTool, ToolCallResult, ChatMessage } from '../src/services/chat-stream';
import { ArtifactStore, ARTIFACT_STORE_DEFAULTS } from '../src/services/artifact-store';

// ─── Helpers ───────────────────────────────────────────────

/** Create a minimal mock LLM provider */
function createMockProvider(response: string = 'Mock response') {
    return {
        createStream: async function* () {
            yield {
                content: response,
                reasoningContent: null,
                toolCallDeltas: null,
                finishReason: 'stop',
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
            };
        },
        listModels: async () => ['mock-model'],
    };
}

// ─── Tests ─────────────────────────────────────────────────

describe('AgentOrchestrator', () => {
    it('should create an orchestrator with sub-agents', () => {
        const subAgentConfigs: SubAgentConfig[] = [
            {
                name: 'vault',
                description: 'Vault operations',
                systemPrompt: 'You handle vault ops.',
                tools: [],
            },
            {
                name: 'web',
                description: 'Web search',
                systemPrompt: 'You handle web search.',
                tools: [],
            },
        ];

        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'You are the main agent.',
            subAgents: subAgentConfigs,
        });

        expect(orchestrator.state).toBe('idle');
        expect(orchestrator.messages).toHaveLength(0);
        expect(orchestrator.currentTurn).toBe(0);
        expect(orchestrator.sessionTokenUsage.totalTokens).toBe(0);
    });

    it('should expose compatible interface with ChatStream', () => {
        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'Test',
            subAgents: [],
        });

        // Verify all IChatAgent interface methods exist
        expect(typeof orchestrator.messages).toBe('object');
        expect(typeof orchestrator.state).toBe('string');
        expect(typeof orchestrator.sessionTokenUsage).toBe('object');
        expect(typeof orchestrator.currentTurn).toBe('number');
        expect(typeof orchestrator.summaries).toBe('object');
        expect(typeof orchestrator.clearHistory).toBe('function');
        expect(typeof orchestrator.restoreState).toBe('function');
        expect(typeof orchestrator.restoreSummaries).toBe('function');
        expect(typeof orchestrator.abort).toBe('function');
        expect(typeof orchestrator.registerTool).toBe('function');
        expect(typeof orchestrator.registerMainAgentTool).toBe('function');
        expect(typeof orchestrator.prompt).toBe('function');
    });

    it('should clear history and reset state', () => {
        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'Test',
            subAgents: [],
        });

        orchestrator.clearHistory();
        expect(orchestrator.messages).toHaveLength(0);
        expect(orchestrator.sessionTokenUsage.totalTokens).toBe(0);
    });

    it('should restore state from previous session', () => {
        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'Test',
            subAgents: [],
        });

        const messages: ChatMessage[] = [
            {
                id: 'msg-1',
                role: 'user',
                content: 'Hello',
                streaming: false,
                timestamp: Date.now(),
                turn: 1,
            },
            {
                id: 'msg-2',
                role: 'assistant',
                content: 'Hi there!',
                streaming: false,
                timestamp: Date.now(),
                turn: 1,
            },
        ];

        const tokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };

        orchestrator.restoreState(messages, tokenUsage);

        expect(orchestrator.messages).toHaveLength(2);
        expect(orchestrator.currentTurn).toBe(1);
    });

    it('should execute a simple prompt without sub-agents', async () => {
        let finishCalled = false;

        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'You are a test agent.',
            subAgents: [],
            onFinish: () => {
                finishCalled = true;
            },
        });

        await orchestrator.prompt('Hello', {
            provider: createMockProvider('Hello back!') as any,
        });

        expect(finishCalled).toBe(true);
        // Should have user message + assistant message
        const msgs = orchestrator.messages;
        expect(msgs.length).toBeGreaterThanOrEqual(2);
        expect(msgs[0]!.role).toBe('user');
        expect(msgs[0]!.content).toBe('Hello');
    });

    it('should aggregate token usage from sub-agents', () => {
        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'Test',
            subAgents: [],
        });

        // Initially zero
        const usage = orchestrator.sessionTokenUsage;
        expect(usage.promptTokens).toBe(0);
        expect(usage.completionTokens).toBe(0);
        expect(usage.totalTokens).toBe(0);
    });

    it('should provide sub-agent logs', () => {
        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'Test',
            subAgents: [],
        });

        expect(orchestrator.subAgentLogs).toHaveLength(0);
    });
});

// ─── Sub-agent router (sticky-on-history) ──────────────────
//
// The router itself is unit-tested in `sub-agent-router.test.ts`.
// Here we cover the orchestrator-side wiring that the router depends
// on: rebuilding the sticky-name set from persisted history so a
// session reload doesn't lose track of sub-agents the conversation
// has already used (a regression there would silently drop the
// DELEGATION block on first turn after restore, leaving the model
// with envelope refs it can no longer interpret).

describe('AgentOrchestrator sticky-on-history', () => {
    const subAgentConfigs: SubAgentConfig[] = [
        { name: 'vault_inspector', description: 'Read-only', systemPrompt: 'X', tools: [] },
        { name: 'web', description: 'Web search', systemPrompt: 'X', tools: [] },
    ];

    it('seeds the sticky set empty before any dispatch', () => {
        const orch = new AgentOrchestrator({ systemPrompt: 'Test', subAgents: subAgentConfigs });
        const sticky: Set<string> = (orch as any)._usedSubAgentNames;
        expect(sticky.size).toBe(0);
    });

    it('rebuilds the sticky set from delegate_task tool_calls in restored history', () => {
        const orch = new AgentOrchestrator({ systemPrompt: 'Test', subAgents: subAgentConfigs });

        const messages: ChatMessage[] = [
            {
                id: 'm1', role: 'user', content: 'find notes about cats',
                streaming: false, timestamp: 1, turn: 1,
            },
            {
                id: 'm2', role: 'assistant', content: 'searching',
                streaming: false, timestamp: 2, turn: 1,
            },
            {
                id: 'm3', role: 'tool_call', content: '', streaming: false, timestamp: 3, turn: 1,
                toolCallMeta: {
                    toolCallId: 'tc-1',
                    toolName: 'delegate_task',
                    toolArgs: { agent: 'vault_inspector', task: 'find cats' },
                },
                toolCallResult: { status: 'success', result: '{}' },
            },
        ];

        orch.restoreState(messages, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });

        const sticky: Set<string> = (orch as any)._usedSubAgentNames;
        expect(sticky.has('vault_inspector')).toBe(true);
        expect(sticky.has('web')).toBe(false);
    });

    it('ignores delegate_task calls whose `agent` does not resolve to a configured sub-agent', () => {
        const orch = new AgentOrchestrator({ systemPrompt: 'Test', subAgents: subAgentConfigs });

        const messages: ChatMessage[] = [
            {
                id: 'm3', role: 'tool_call', content: '', streaming: false, timestamp: 3, turn: 1,
                toolCallMeta: {
                    toolCallId: 'tc-1',
                    toolName: 'delegate_task',
                    toolArgs: { agent: 'imaginary_agent', task: '...' },
                },
                toolCallResult: { status: 'success', result: '{}' },
            },
        ];

        orch.restoreState(messages, { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
        const sticky: Set<string> = (orch as any)._usedSubAgentNames;
        expect(sticky.size).toBe(0);
    });

    it('also seeds the sticky set from restored sub-agent messages', () => {
        const orch = new AgentOrchestrator({ systemPrompt: 'Test', subAgents: subAgentConfigs });

        orch.restoreSubAgentMessages({
            'parent-tc-1': [
                {
                    id: 's1', role: 'assistant', content: 'searching',
                    streaming: false, timestamp: 1, turn: 1,
                    subAgent: { agentName: 'web', parentToolCallId: 'parent-tc-1' },
                },
            ],
        });

        const sticky: Set<string> = (orch as any)._usedSubAgentNames;
        expect(sticky.has('web')).toBe(true);
    });

    it('clears the sticky set on clearHistory', () => {
        const orch = new AgentOrchestrator({ systemPrompt: 'Test', subAgents: subAgentConfigs });
        (orch as any)._usedSubAgentNames.add('vault_inspector');
        (orch as any)._usedSubAgentNames.add('web');

        orch.clearHistory();

        const sticky: Set<string> = (orch as any)._usedSubAgentNames;
        expect(sticky.size).toBe(0);
    });
});

// ─── buildDelegatePayload ──────────────────────────────────
//
// Pure function — covers the structural logic that decides what the main
// agent sees as the `delegate_task` tool_result. End-to-end wiring (store
// is actually handed to sub-agent.execute, JSON.stringify happens, etc.)
// is covered by:
//   - the SubAgent handoff tests in `sub-agent-handoff.test.ts` (store
//     plumbing on the sub-agent side)
//   - TS type-checking of the orchestrator wiring (3 lines of glue)
//   - manual smoke test in a real Obsidian vault (per the design plan)
// Driving a full mock-provider tool_call loop just to verify those 3 lines
// would lock the orchestrator's tests to ChatStream's internal multi-turn
// implementation, which is brittle and low-ROI. We test the logic that
// CAN drift — the envelope-building rules — directly.

describe('buildDelegatePayload', () => {
    it('returns just `text` when the store is empty (5-fallback)', () => {
        // The vast majority of legacy sub-agents never call write_handoff.
        // For them the envelope must collapse to `{ text }` only — no
        // empty `result: null`, no empty `extras: {}` — so the JSON the
        // main LLM sees stays compact and indistinguishable in spirit
        // from the pre-handoff plain-text behaviour.
        const store: HandoffStore = new Map();
        const payload = buildDelegatePayload('plain summary', store);

        // The envelope always carries the marker fields (so the reducer
        // can recognise it downstream — see plan doc §1.1) plus `text`.
        // No empty `result: null` / `extras: {}` leak when unused.
        expect(payload).toEqual({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: DELEGATE_ENVELOPE_VERSION,
            text: 'plain summary',
        });
        // Explicit absence checks — the envelope must NOT carry these
        // when not used. JSON.stringify of an `undefined` field is fine
        // (it gets dropped) but a literal `null`/empty object would leak.
        expect('result' in payload).toBe(false);
        expect('extras' in payload).toBe(false);
        expect('omitted' in payload).toBe(false);
    });

    it('lifts the `result` key to a top-level field (5-happy-path)', () => {
        // The end-to-end success case: sub-agent put structured data under
        // the canonical key, main agent should see it as `result`.
        const store: HandoffStore = new Map();
        store.set('result', { paths: ['a/b.md', 'c.md'], count: 2 });

        const payload = buildDelegatePayload('found 2 notes', store);

        expect(payload.text).toBe('found 2 notes');
        expect(payload.result).toEqual({ paths: ['a/b.md', 'c.md'], count: 2 });
        expect(payload.extras).toBeUndefined();
        expect(payload.omitted).toBeUndefined();
    });

    it('routes non-`result` keys to `extras`', () => {
        const store: HandoffStore = new Map();
        store.set('result', 'main');
        store.set('candidates', ['x', 'y']);
        store.set('warnings', [{ msg: 'partial' }]);

        const payload = buildDelegatePayload('done', store);

        expect(payload.result).toBe('main');
        expect(payload.extras).toEqual({
            candidates: ['x', 'y'],
            warnings: [{ msg: 'partial' }],
        });
        // `result` must NOT also appear inside `extras`.
        expect(payload.extras).not.toHaveProperty('result');
    });

    it('omits `extras` field when only auxiliary keys exist (no `result`)', () => {
        // Edge case: sub-agent put aux data but never wrote `result`. The
        // envelope must still be valid: `result` absent, `extras` present.
        // The main-agent prompt explicitly tells the LLM to fall back to
        // `text` in this case, so we don't synthesize a fake `result`.
        const store: HandoffStore = new Map();
        store.set('debug', { trace: [1, 2, 3] });

        const payload = buildDelegatePayload('side-effect done', store);

        expect(payload.text).toBe('side-effect done');
        expect('result' in payload).toBe(false);
        expect(payload.extras).toEqual({ debug: { trace: [1, 2, 3] } });
    });

    it('drops oversized values and records them under `omitted` (test 9)', () => {
        // ~33 KB string blows past the 32 KB cap — must be dropped, with
        // size & flag preserved so the main agent can react (e.g.
        // re-delegate with a tighter scope) instead of silently losing
        // the value.
        const huge = 'x'.repeat(HANDOFF_VALUE_MAX_BYTES + 1024);
        const store: HandoffStore = new Map();
        store.set('result', huge);

        const payload = buildDelegatePayload('too big to inline', store);

        // The huge value MUST NOT appear inline.
        expect(payload.result).toBeUndefined();
        // But the main agent MUST learn the value existed and how big it was.
        expect(payload.omitted).toBeDefined();
        expect(payload.omitted!['result_omitted']).toBe(true);
        expect(typeof payload.omitted!['result_size']).toBe('number');
        expect(payload.omitted!['result_size'] as number).toBeGreaterThan(HANDOFF_VALUE_MAX_BYTES);
        // Sanity: stringified envelope is reasonably small now.
        expect(JSON.stringify(payload).length).toBeLessThan(HANDOFF_VALUE_MAX_BYTES);
    });

    it('preserves small values alongside oversized ones', () => {
        // Mixed case: one oversized, one fine. The fine one must survive
        // intact (oversized handling is per-key, not global).
        const huge = 'y'.repeat(HANDOFF_VALUE_MAX_BYTES + 100);
        const store: HandoffStore = new Map();
        store.set('result', { ok: true, items: [1, 2, 3] });
        store.set('debug', huge);

        const payload = buildDelegatePayload('mixed', store);

        expect(payload.result).toEqual({ ok: true, items: [1, 2, 3] });
        expect(payload.extras).toBeUndefined(); // `debug` was dropped
        expect(payload.omitted).toEqual({
            debug_omitted: true,
            debug_size: expect.any(Number),
        });
    });

    it('produces a JSON-serializable envelope', () => {
        // Belt-and-suspenders: the orchestrator JSON.stringify's whatever
        // we return. If buildDelegatePayload ever lets through a non-
        // serializable value (it shouldn't — write_handoff already
        // rejects them at write time, but defence in depth) we want this
        // test to flag it.
        const store: HandoffStore = new Map();
        store.set('result', { nested: { a: 1, b: [true, null, 'x'] } });
        store.set('extra1', 42);

        const payload = buildDelegatePayload('ok', store);
        const json = JSON.stringify(payload);
        const roundTripped = JSON.parse(json);

        expect(roundTripped).toEqual({
            __kind: DELEGATE_ENVELOPE_KIND,
            __v: DELEGATE_ENVELOPE_VERSION,
            text: 'ok',
            result: { nested: { a: 1, b: [true, null, 'x'] } },
            extras: { extra1: 42 },
        });
    });

    it('always stamps `__kind` and `__v` marker fields (envelope-detection contract)', () => {
        // The shrink stage in `context-reducer.ts` will branch on these
        // two fields to decide whether a tool_result string is a delegate
        // envelope (vs. a coincidentally JSON-shaped tool result). They
        // are part of the wire contract from this point on — pin them
        // here so a careless edit to `buildDelegatePayload` cannot drop
        // them silently.
        //
        // Cover all three buckets (empty store, with result, with omitted)
        // because the marker fields are set at construction, not at any
        // conditional branch — but the test is cheap and the regression
        // surface (silent removal during a refactor) is real.
        const empty = buildDelegatePayload('t1', new Map());
        expect(empty.__kind).toBe(DELEGATE_ENVELOPE_KIND);
        expect(empty.__v).toBe(DELEGATE_ENVELOPE_VERSION);

        const withResult = new Map();
        withResult.set('result', { ok: true });
        const p2 = buildDelegatePayload('t2', withResult);
        expect(p2.__kind).toBe(DELEGATE_ENVELOPE_KIND);
        expect(p2.__v).toBe(DELEGATE_ENVELOPE_VERSION);

        const withOmitted = new Map();
        withOmitted.set('result', 'x'.repeat(HANDOFF_VALUE_MAX_BYTES + 100));
        const p3 = buildDelegatePayload('t3', withOmitted);
        expect(p3.__kind).toBe(DELEGATE_ENVELOPE_KIND);
        expect(p3.__v).toBe(DELEGATE_ENVELOPE_VERSION);

        // Marker fields survive a JSON round trip — they must be on the
        // wire, not just on the in-memory object.
        const json = JSON.stringify(empty);
        expect(JSON.parse(json).__kind).toBe(DELEGATE_ENVELOPE_KIND);
        expect(JSON.parse(json).__v).toBe(DELEGATE_ENVELOPE_VERSION);
    });
});

// ─── buildDelegatePayload — artifact promotion (E-3) ───────
//
// Plan §1.6 / §6 step 6: 32 KB < size ≤ 128 KB values are routed to
// the per-session artifact store rather than dropped to `omitted`. The
// envelope grows an `artifacts` field describing each promoted entry;
// `recall_artifact({key})` is the main agent's recovery path.
//
// These tests pin the per-bucket routing rules and the contract that
// `omitted` / `artifacts` never overlap. Validator-runs-against-promoted
// behaviour lives further down with the other validator tests.

describe('buildDelegatePayload (artifact promotion)', () => {
    /** Build an in-band-but-too-big-to-inline value: ~50 KB serialized. */
    function midSizeString(): string {
        // JSON-stringified length of a string s is s.length + 2 ("...").
        // Aim well above HANDOFF_VALUE_MAX_BYTES (32 KB) and well under
        // singleArtifactCap (128 KB) so the artifact band is unambiguous.
        return 'm'.repeat(50_000);
    }

    /** Build an over-128KB value: ~150 KB serialized. */
    function oversizeString(): string {
        return 'o'.repeat(150_000);
    }

    it('promotes a 32K < size ≤ 128K result into the artifact store and emits an ArtifactRef', () => {
        const store: HandoffStore = new Map();
        const value = midSizeString();
        store.set('result', value);

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('done', store, undefined, {
            artifactStore,
            delegateCallId: 'tc-abc',
        });

        // Inline `result` MUST be empty — promotion is mutually exclusive
        // with inlining for the same field.
        expect('result' in payload).toBe(false);

        // `artifacts.result` carries a complete ArtifactRef.
        expect(payload.artifacts).toBeDefined();
        const ref = payload.artifacts!['result'];
        expect(ref).toBeDefined();
        // Key is auto-generated by the store.
        expect(typeof ref.key).toBe('string');
        expect(ref.key.length).toBeGreaterThan(0);
        expect(ref.size).toBeGreaterThan(HANDOFF_VALUE_MAX_BYTES);
        expect(ref.size).toBeLessThanOrEqual(ARTIFACT_STORE_DEFAULTS.singleArtifactCap);
        expect(ref.reason).toBe('oversize');
        // Preview is bounded — we don't want it leaking the whole value.
        expect(ref.preview).toBeDefined();
        expect(ref.preview!.length).toBeLessThanOrEqual(220); // 200 chars + ellipsis tolerance

        // `omitted` MUST NOT mention the promoted field — the value is
        // recoverable, not lost.
        expect(payload.omitted?.['result_omitted']).toBeUndefined();
        expect(payload.omitted?.['result_size']).toBeUndefined();

        // The store actually has the value, byte-for-byte.
        const got = artifactStore.get(ref.key);
        expect(got.found).toBe(true);
        if (got.found) {
            expect(got.value).toBe(value);
            expect(got.size).toBe(ref.size);
        }
    });

    it('promotes a mid-sized extras key under its own field name', () => {
        const store: HandoffStore = new Map();
        store.set('result', { ok: true });           // small, inlines
        store.set('details', midSizeString());       // mid, promotes

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('mixed', store, undefined, {
            artifactStore,
            delegateCallId: 'tc-xyz',
        });

        // Small result inlines.
        expect(payload.result).toEqual({ ok: true });

        // Mid extras key shows up only in `artifacts`, never in `extras`.
        expect(payload.extras?.['details']).toBeUndefined();
        expect(payload.artifacts?.['details']).toBeDefined();
        expect(typeof payload.artifacts!['details'].key).toBe('string');
        expect(payload.artifacts!['details'].key.length).toBeGreaterThan(0);
        expect(payload.artifacts!['details'].reason).toBe('oversize');

        // No accidental cross-pollution: the artifact ref's outer field
        // name is the extras key, NOT `result`.
        expect(payload.artifacts!['result']).toBeUndefined();
    });

    it('drops > singleArtifactCap values to `omitted` with a too_large_for_store flag', () => {
        // Value above the artifact store's per-entry cap (128 KB default).
        // The store refuses the put and the orchestrator falls back to
        // the legacy `omitted` shape, plus an extra flag so the LLM
        // distinguishes "could-have-recalled-but-evicted" from "never-stored".
        const store: HandoffStore = new Map();
        store.set('result', oversizeString());

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('too big', store, undefined, {
            artifactStore,
            delegateCallId: 'tc-huge',
        });

        // Not inline, not in artifacts, definitely in omitted.
        expect('result' in payload).toBe(false);
        expect(payload.artifacts?.['result']).toBeUndefined();
        expect(payload.omitted).toBeDefined();
        expect(payload.omitted!['result_omitted']).toBe(true);
        expect(typeof payload.omitted!['result_size']).toBe('number');
        expect(payload.omitted!['result_too_large_for_store']).toBe(true);

        // Store stays empty — no entry, no tombstone for a put that
        // was never accepted (plan §1.6 last bullet).
        expect(artifactStore.stats().liveCount).toBe(0);
        expect(artifactStore.stats().diskIndexCount).toBe(0);
    });

    it('falls back to `omitted` (no flag) when no artifact store is provided', () => {
        // Back-compat path: legacy 3-arg call sites and unit tests that
        // don't care about artifacts must keep working unchanged.
        // Oversized values land in `omitted` exactly as before, with
        // NO `_too_large_for_store` flag (the value didn't exceed the
        // store's cap — there is no store).
        const store: HandoffStore = new Map();
        store.set('result', midSizeString()); // 50K → would promote if store wired

        const payload = buildDelegatePayload('legacy call', store, undefined);

        expect('result' in payload).toBe(false);
        expect(payload.artifacts).toBeUndefined();
        expect(payload.omitted).toBeDefined();
        expect(payload.omitted!['result_omitted']).toBe(true);
        expect(payload.omitted!['result_size']).toBeGreaterThan(HANDOFF_VALUE_MAX_BYTES);
        // The flag MUST be absent — it is reserved for the
        // store-rejected-this case, which is not what happened here.
        expect(payload.omitted!['result_too_large_for_store']).toBeUndefined();
    });

    it('falls back to `omitted` when delegateCallId is missing (key-collision guard)', () => {
        // The orchestrator namespaces artifact keys with the parent
        // toolCallId. Without one, two concurrent delegations could
        // mint the same key — refusing to promote is the safe default.
        const store: HandoffStore = new Map();
        store.set('result', midSizeString());

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('no callId', store, undefined, {
            artifactStore,
            // delegateCallId intentionally omitted
        });

        expect(payload.artifacts).toBeUndefined();
        expect(payload.omitted!['result_omitted']).toBe(true);
        // Store must remain untouched.
        expect(artifactStore.stats().liveCount).toBe(0);
    });

    it('keeps `omitted` and `artifacts` field-disjoint within a single envelope', () => {
        // Mixed bucket-3 / bucket-2 / bucket-1 in one call. Each field
        // routes to exactly ONE of the three slots; no field appears
        // twice. This is the crucial invariant the prompt relies on
        // when it tells the LLM "look in artifacts before re-delegating".
        const store: HandoffStore = new Map();
        store.set('result', { ok: true });           // bucket 1: inline
        store.set('details', midSizeString());        // bucket 2: artifact
        store.set('mega', oversizeString());          // bucket 3: omitted

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('three buckets', store, undefined, {
            artifactStore,
            delegateCallId: 'tc-three',
        });

        // bucket 1
        expect(payload.result).toEqual({ ok: true });
        expect(payload.extras).toBeUndefined();

        // bucket 2
        expect(payload.artifacts?.['details']).toBeDefined();
        expect(payload.artifacts?.['result']).toBeUndefined();
        expect(payload.artifacts?.['mega']).toBeUndefined();

        // bucket 3
        expect(payload.omitted?.['mega_omitted']).toBe(true);
        expect(payload.omitted?.['mega_too_large_for_store']).toBe(true);
        expect(payload.omitted?.['details_omitted']).toBeUndefined();
        expect(payload.omitted?.['result_omitted']).toBeUndefined();

        // Cross-check: `result` is ONLY in the inline slot.
        expect(payload.artifacts && 'result' in payload.artifacts).toBeFalsy();
        // `details` is ONLY in artifacts.
        expect(payload.extras && 'details' in payload.extras).toBeFalsy();
        expect(payload.omitted && 'details_omitted' in payload.omitted).toBeFalsy();
    });

    it('produces a JSON-serializable envelope when artifacts are present', () => {
        // Defence-in-depth: the orchestrator JSON.stringify's the
        // envelope; all artifact-side fields (key, size, preview, reason)
        // must be plain JSON values.
        const store: HandoffStore = new Map();
        store.set('result', midSizeString());

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('json', store, undefined, {
            artifactStore,
            delegateCallId: 'tc-json',
        });

        const json = JSON.stringify(payload);
        const round = JSON.parse(json);

        expect(round.__kind).toBe(DELEGATE_ENVELOPE_KIND);
        expect(round.__v).toBe(DELEGATE_ENVELOPE_VERSION);
        // Key is auto-generated by the store — verify it's a non-empty string.
        expect(typeof round.artifacts.result.key).toBe('string');
        expect(round.artifacts.result.key.length).toBeGreaterThan(0);
        expect(round.artifacts.result.reason).toBe('oversize');
        expect(typeof round.artifacts.result.size).toBe('number');
        expect(typeof round.artifacts.result.preview).toBe('string');
    });

    it('preview is a head slice with an ellipsis for truncated values', () => {
        // The preview is meant as a quick orientation hint for the LLM,
        // not a usable fragment. Confirm: ≤200 chars for short values
        // (no ellipsis), or 200 chars + "…" for long ones.
        const shortStore: HandoffStore = new Map();
        // Pick a small structured value that, when JSON-stringified,
        // is ≤200 chars but big enough overall to land in the artifact
        // band — so we get a SHORT preview but still hit the promote path.
        // Easiest: a long string of repeated "ab" (each "a" = 1 char in JSON);
        // we can't get a "short preview" + "long total" out of a single
        // string, so instead rely on the long-value case below to verify
        // the truncation, and add a separate small-value case where the
        // preview IS the full JSON.
        const value = midSizeString();
        shortStore.set('result', value);
        const payload = buildDelegatePayload('p', shortStore, undefined, {
            artifactStore: new ArtifactStore(),
            delegateCallId: 'tc-prev',
        });
        const ref = payload.artifacts!['result'];
        // The preview ends with the ellipsis marker we picked.
        expect(ref.preview!.endsWith('…')).toBe(true);
        // Before the ellipsis the preview is exactly 200 chars (the cap).
        expect(ref.preview!.slice(0, -1).length).toBe(200);
        // And the chars match the head of the JSON-stringified value.
        const expectedHead = JSON.stringify(value).slice(0, 200);
        expect(ref.preview!.slice(0, -1)).toBe(expectedHead);
    });

    it('LRU-evicts older artifacts when the store fills up; eviction is observable but envelope-stable', () => {
        // Pin the lifecycle contract: putting a second mid-sized
        // artifact when the store can only hold one causes the first
        // to be tombstoned. The envelope produced for the SECOND call
        // is unaffected — the contract says the just-written artifact
        // is live, and any prior artifact's eviction is a runtime
        // concern surfaced through `recall_artifact`, not the envelope.
        //
        // Scenario tightens the cap to barely fit one 50K entry so
        // adding a second forces the eviction.
        const tightStore = new ArtifactStore({ totalBytesCap: 60_000 });

        // First call: promotes to artifact with auto-generated key.
        const s1: HandoffStore = new Map();
        s1.set('result', midSizeString());
        const p1 = buildDelegatePayload('first', s1, undefined, {
            artifactStore: tightStore,
            delegateCallId: 'tc-1',
        });
        const p1Key = p1.artifacts!['result'].key;
        expect(typeof p1Key).toBe('string');
        expect(p1Key.length).toBeGreaterThan(0);
        expect(tightStore.get(p1Key).found).toBe(true);

        // Second call: writes another entry → first may be LRU-evicted.
        const s2: HandoffStore = new Map();
        s2.set('result', midSizeString());
        const p2 = buildDelegatePayload('second', s2, undefined, {
            artifactStore: tightStore,
            delegateCallId: 'tc-2',
        });
        const p2Key = p2.artifacts!['result'].key;
        expect(typeof p2Key).toBe('string');
        expect(p2Key).not.toBe(p1Key);

        // Old key now answers "evicted, reason=lru" — the LLM can tell
        // the difference between a forgotten key and a never-existed one.
        const oldGot = tightStore.get(p1Key);
        expect(oldGot.found).toBe(false);
        if (!oldGot.found && oldGot.evicted) {
            expect(oldGot.reason).toBe('lru');
        } else {
            // Force a clear failure if the assertion above didn't bite.
            expect.fail('expected lru tombstone on the first artifact key');
        }
    });
});

// ─── buildDelegatePayload — vault_inspector result schema ──
//
// The validator is wired into buildDelegatePayload behind an optional
// `agentName` arg. When the agent name matches a registered validator,
// schema issues are surfaced in `extras.result_validation_issues` —
// soft degradation, NOT data loss. These tests pin that behaviour.

describe('buildDelegatePayload (with vault_inspector validator)', () => {
    it('passes a well-formed digest result through with no validation issues', () => {
        const store: HandoffStore = new Map();
        store.set('result', {
            digests: [
                {
                    path: 'Topics/A.md',
                    summary: 'A short neutral summary.',
                    key_points: ['Claim 1.', 'Claim 2.'],
                    anchors: [
                        { heading_path: ['Chapter 2', 'Background'], why: 'core argument' },
                    ],
                },
            ],
            focus: 'compare arguments',
        });

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        expect(payload.result).toBeDefined();
        // No issues key when the schema matches.
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('surfaces issues for a digest entry missing required fields', () => {
        const store: HandoffStore = new Map();
        store.set('result', {
            digests: [
                // Missing summary, anchors, key_points
                { path: 'Topics/A.md' },
            ],
        });

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        // The malformed result is STILL passed through (soft degradation).
        expect(payload.result).toBeDefined();
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(Array.isArray(issues)).toBe(true);
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.some((s) => /summary/.test(s))).toBe(true);
        expect(issues.some((s) => /key_points/.test(s))).toBe(true);
        expect(issues.some((s) => /anchors/.test(s))).toBe(true);
    });

    it('flags oversized summary and excessive key_points/anchors counts', () => {
        const store: HandoffStore = new Map();
        const tooLongSummary = 'x'.repeat(1000);
        store.set('result', {
            digests: [
                {
                    path: 'A.md',
                    summary: tooLongSummary,
                    key_points: new Array(8).fill('point'),
                    anchors: new Array(8).fill({ heading_path: ['H'] }),
                },
            ],
        });

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(issues.some((s) => /summary is too long/.test(s))).toBe(true);
        expect(issues.some((s) => /key_points has 8 items/.test(s))).toBe(true);
        expect(issues.some((s) => /anchors has 8 items/.test(s))).toBe(true);
    });

    it('rejects an empty digests array (every path must have an entry)', () => {
        const store: HandoffStore = new Map();
        store.set('result', { digests: [] });

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(issues.some((s) => /empty/.test(s))).toBe(true);
    });

    it('does NOT flag non-digest results (Mode A inspect tasks)', () => {
        // vault_inspector also handles Mode A (locate/inspect) tasks where
        // the natural `result` shape is a string / array / object without
        // `digests`. Those pass through unchanged — the validator only
        // engages when `digests` is present.
        const store: HandoffStore = new Map();
        store.set('result', { matches: ['a/b.md', 'c.md'] });

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        expect(payload.result).toEqual({ matches: ['a/b.md', 'c.md'] });
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('skips validation when result was omitted for size', () => {
        // If result is too large to inline, it never reaches the validator;
        // surfacing schema issues about a value the main agent can't see
        // would just be noise.
        const store: HandoffStore = new Map();
        const huge = { digests: [{ path: 'x', summary: 'x'.repeat(HANDOFF_VALUE_MAX_BYTES + 100) }] };
        store.set('result', huge);

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        expect(payload.result).toBeUndefined();
        expect(payload.omitted).toBeDefined();
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('runs the validator on a result promoted to an artifact (E-3)', () => {
        // Critical contract for E-3: the LLM still sees the artifact's
        // shape via `recall_artifact`, so schema issues are STILL useful
        // even when the value is parked in the store rather than inlined.
        // Validate against the original value, not the (absent) inline
        // payload. A malformed-but-promoted result should surface issues
        // exactly as if it had been inlined.
        //
        // We aim the malformed result at the vault_inspector schema:
        // missing required fields (summary / key_points / anchors) on a
        // digest entry. Pad with a long string so the JSON crosses the
        // 32 KB inline cap and lands in the artifact band.
        const store: HandoffStore = new Map();
        const padding = 'p'.repeat(50_000); // pushes serialized size past 32 KB
        store.set('result', {
            digests: [
                { path: 'Topics/A.md' }, // missing summary, key_points, anchors
            ],
            // padding lives at the top level, ensuring the WHOLE result
            // is large; the validator only inspects digests so padding
            // does not perturb its decisions.
            padding,
        });

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('done', store, 'vault_inspector', {
            artifactStore,
            delegateCallId: 'tc-promoted',
        });

        // Promoted, not inlined.
        expect(payload.result).toBeUndefined();
        expect(payload.artifacts?.['result']).toBeDefined();

        // Validator issues surface anyway — same shape as the inline path.
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(Array.isArray(issues)).toBe(true);
        expect(issues.some((s) => /summary/.test(s))).toBe(true);
        expect(issues.some((s) => /key_points/.test(s))).toBe(true);
        expect(issues.some((s) => /anchors/.test(s))).toBe(true);
    });

    it('does NOT run the validator when result was dropped to omitted (store rejected)', () => {
        // Companion to the test above: when a result is so large the
        // artifact store also rejects it, surfacing schema issues about
        // a value the LLM cannot recover would just be noise — same
        // rationale as the original "omitted for size" skip.
        const store: HandoffStore = new Map();
        // Build a value that WOULD fail vault_inspector validation
        // (missing required digest fields) AND is large enough to
        // exceed singleArtifactCap (128 KB).
        store.set('result', {
            digests: [{ path: 'A.md' }],
            mega: 'q'.repeat(150_000),
        });

        const artifactStore = new ArtifactStore();
        const payload = buildDelegatePayload('done', store, 'vault_inspector', {
            artifactStore,
            delegateCallId: 'tc-too-big',
        });

        expect(payload.result).toBeUndefined();
        expect(payload.artifacts?.['result']).toBeUndefined();
        expect(payload.omitted?.['result_too_large_for_store']).toBe(true);
        // No validation noise on an unrecoverable value.
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('does not validate when no agentName is supplied (back-compat)', () => {
        // Existing callers and tests pass only (text, store) — the third
        // arg is optional and absence means "skip validation". This
        // ensures the new behaviour is fully opt-in.
        const store: HandoffStore = new Map();
        store.set('result', { digests: [{ path: 'x' }] }); // would fail schema

        const payload = buildDelegatePayload('done', store);
        expect(payload.result).toBeDefined();
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('does not validate for unknown agent names', () => {
        // Sub-agents without a registered validator pass through
        // unchanged — adding a new sub-agent should never accidentally
        // trigger schema enforcement intended for a different one.
        const store: HandoffStore = new Map();
        store.set('result', { digests: [{ path: 'x' }] });

        const payload = buildDelegatePayload('done', store, 'web_researcher');
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });
});

// ─── buildDelegatePayload — vault_editor result schema ─────
//
// The `vault_editor` sub-agent's result schema pins down the
// structured diff contract: a strategy verb + a cap-respecting
// sample_diff. These tests mirror the vault_inspector block above,
// covering happy paths, caps, and the abort shape.

describe('buildDelegatePayload (with vault_editor validator)', () => {
    it('passes a well-formed wholesale result with no issues', () => {
        const store: HandoffStore = new Map();
        store.set('result', {
            path: 'Notes/Foo.md',
            strategy: 'wholesale',
            edits_applied: 1,
            previous_size: 1200,
            new_size: 1150,
            sample_diff: [
                { before_excerpt: '# Old Heading\n\nold body start...', after_excerpt: '# New Heading\n\nnew body start...' },
            ],
            warnings: [],
        });

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        expect(payload.result).toBeDefined();
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('passes a surgical result with multiple samples', () => {
        const store: HandoffStore = new Map();
        store.set('result', {
            path: 'Notes/Foo.md',
            strategy: 'surgical',
            edits_applied: 3,
            sample_diff: [
                { before_excerpt: 'foo', after_excerpt: 'bar' },
                { before_excerpt: 'baz', after_excerpt: 'qux' },
                { before_excerpt: 'hello', after_excerpt: 'world' },
            ],
        });

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        expect(payload.result).toBeDefined();
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('flags an invalid strategy value', () => {
        const store: HandoffStore = new Map();
        store.set('result', {
            path: 'Notes/Foo.md',
            strategy: 'wat',
            edits_applied: 1,
        });

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        expect(payload.result).toBeDefined();
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(Array.isArray(issues)).toBe(true);
        expect(issues.some((s) => /strategy must be one of/.test(s))).toBe(true);
    });

    it('flags a sample_diff with more than 5 entries', () => {
        const store: HandoffStore = new Map();
        store.set('result', {
            path: 'Notes/Foo.md',
            strategy: 'surgical',
            edits_applied: 6,
            sample_diff: Array.from({ length: 6 }, (_, i) => ({
                before_excerpt: `b${i}`,
                after_excerpt: `a${i}`,
            })),
        });

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(issues.some((s) => /sample_diff has 6 entries/.test(s))).toBe(true);
    });

    it('flags a sample_diff entry whose excerpt exceeds the 240-char cap', () => {
        const store: HandoffStore = new Map();
        const huge = 'x'.repeat(300);
        store.set('result', {
            path: 'Notes/Foo.md',
            strategy: 'wholesale',
            edits_applied: 1,
            sample_diff: [{ before_excerpt: huge, after_excerpt: 'short' }],
        });

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(issues.some((s) => /before_excerpt is too long/.test(s))).toBe(true);
    });

    it('flags a non-empty path that is missing entirely', () => {
        const store: HandoffStore = new Map();
        store.set('result', {
            path: '',
            strategy: 'wholesale',
            edits_applied: 1,
        });

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(issues.some((s) => /path must be a non-empty string/.test(s))).toBe(true);
    });

    it('flags a completely non-object result (string mis-wrap)', () => {
        // An LLM slip: put "Done rewriting." as the result instead of
        // an object. We want this to fail schema loudly but still pass
        // through (soft degradation).
        const store: HandoffStore = new Map();
        store.set('result', 'Done rewriting Foo.md.');

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        expect(payload.result).toBeDefined();
        const issues = payload.extras?.['result_validation_issues'] as string[];
        expect(issues.some((s) => /result must be an object/.test(s))).toBe(true);
    });

    it('accepts the abort shape ({ error, strategy: noop, ... }) without issues', () => {
        // The editor refuses multi-file tasks via this shape. It must
        // pass cleanly — otherwise every refusal produces false-positive
        // validation noise on the main agent side.
        const store: HandoffStore = new Map();
        store.set('result', {
            path: 'Notes/Foo.md',
            strategy: 'noop',
            edits_applied: 0,
            error: 'multi-file task; please delegate one file per call.',
        });

        const payload = buildDelegatePayload('done', store, 'vault_editor');
        expect(payload.result).toBeDefined();
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });
});

// ─── buildInitialStore ─────────────────────────────────────
//
// Pure function — covers the validation rules for the main → sub
// direction (the `handoff` argument of delegate_task — historically
// called `inputs`, then `exchange`). End-to-end wiring (the orchestrator actually calls
// this and refuses to start the sub-agent on InvalidDelegateInputError)
// is covered by TS type-checking + manual smoke; the behaviour that
// CAN drift — what counts as a valid seed entry — is tested directly here.

describe('buildInitialStore', () => {
    it('returns an empty store when the seed is undefined or null', () => {
        // The common case: main agent didn't pass `handoff` at all.
        // Must NOT throw, must NOT pre-populate anything — the sub-agent
        // sees a clean store, identical to pre-seed behaviour.
        expect(buildInitialStore(undefined).size).toBe(0);
        expect(buildInitialStore(null).size).toBe(0);
    });

    it('returns an empty store for an empty object', () => {
        // Edge case: explicitly `{}`. Should be indistinguishable from
        // "no seed" — no special marker, no thrown error.
        expect(buildInitialStore({}).size).toBe(0);
    });

    it('pre-populates the store with each (key, value) pair', () => {
        // Happy path: the main agent's structured handoff.
        const store = buildInitialStore({
            source: ['a/b.md', 'c.md'],
            constraints: { maxLen: 500 },
            count: 2,
        });

        expect(store.size).toBe(3);
        expect(store.get('source')).toEqual(['a/b.md', 'c.md']);
        expect(store.get('constraints')).toEqual({ maxLen: 500 });
        expect(store.get('count')).toBe(2);
    });

    it('rejects arrays at the top level', () => {
        // An array would silently lose its keys (numeric indexes ≠ named
        // slots), so we reject it loudly instead of mis-treating index 0
        // as the key "0".
        expect(() => buildInitialStore([1, 2, 3] as unknown as Record<string, unknown>))
            .toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore([1, 2, 3] as unknown as Record<string, unknown>))
            .toThrow(/plain object/);
    });

    it('rejects class instances at the top level', () => {
        // Class instances (Date, Map, custom classes) would either lose
        // information when JSON.stringify'd or crash mid-flight; the
        // write_handoff tool already rejects them at write-time, so the
        // input path mirrors that for consistency.
        class MyShape { constructor(public n = 1) {} }
        const inst = new MyShape();
        expect(() => buildInitialStore(inst as unknown as Record<string, unknown>))
            .toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore(inst as unknown as Record<string, unknown>))
            .toThrow(/plain object/);
    });

    it('rejects empty string keys', () => {
        // write_handoff also rejects "" as a key (would produce
        // ambiguous list output); the input path enforces the same
        // constraint up front.
        expect(() => buildInitialStore({ '': 1 })).toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore({ '': 1 })).toThrow(/empty key/);
    });

    it('rejects non-JSON-serializable values with the offending path in the message', () => {
        // Defence in depth: validateSerializable is the canonical
        // checker; we re-run it here so a bad seed fails BEFORE any
        // sub-agent tokens are spent (cheaper than discovering the
        // problem when the orchestrator JSON.stringify's the envelope).
        // The error message must reference the failing key so the main
        // LLM can self-correct.
        const seed = { good: 1, bad: () => 42 };
        expect(() => buildInitialStore(seed as unknown as Record<string, unknown>))
            .toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore(seed as unknown as Record<string, unknown>))
            .toThrow(/"bad"/);
    });

    it('rejects oversized values rather than silently truncating', () => {
        // Asymmetric with the OUTPUT path (which degrades to `omitted`
        // markers): on the INPUT path the LLM hasn't paid for generation
        // yet, so a hard error is the right move — it lets the main LLM
        // re-delegate with a leaner input or a reference instead of the
        // raw payload.
        const huge = 'x'.repeat(HANDOFF_VALUE_MAX_BYTES + 1024);
        expect(() => buildInitialStore({ source: huge }))
            .toThrow(InvalidDelegateInputError);
        // Error must mention the cap so the main LLM sees a concrete
        // budget number, not a vague "too big".
        expect(() => buildInitialStore({ source: huge }))
            .toThrow(new RegExp(String(HANDOFF_VALUE_MAX_BYTES)));
    });

    it('rejects non-finite numbers (delegated to validateSerializable)', () => {
        // Sanity: rules forbidden by write_handoff are also forbidden
        // here. Don't enumerate every rule — just confirm the validator
        // is wired in.
        expect(() => buildInitialStore({ x: NaN })).toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore({ x: Infinity })).toThrow(InvalidDelegateInputError);
    });

    it('produces a fresh Map each call (no shared state)', () => {
        // Stack-local ownership invariant: two dispatches in a row must
        // get independent stores. (This is a property of `new Map()` so
        // it's a regression guard, not a behaviour test.)
        const a = buildInitialStore({ x: 1 });
        const b = buildInitialStore({ x: 2 });
        expect(a).not.toBe(b);
        expect(a.get('x')).toBe(1);
        expect(b.get('x')).toBe(2);
    });
});

// ─── delegate_task.exec — seed extraction & legacy `inputs` fallback ───
//
// The `delegate_task` tool's `exec` handler is ~3 lines of glue, but it
// owns a non-obvious responsibility: pulling the seed out of the
// model-emitted args under EITHER the canonical key (`handoff`) or the
// transitional legacy key (`inputs`), then forwarding it to
// `_dispatchSubAgent` under the unified field name `handoff`.
//
// Historically we relied on TS type-checking + manual smoke for this
// "wiring" layer (see the long comment above `buildDelegatePayload`),
// but a user-reported regression where a model still emitted `inputs:`
// against the new schema showed why a fast, direct regression guard
// belongs here: a typo / inverted ?? / missed key would silently drop
// the seed and the bug would only surface in a live multi-turn run.
//
// These tests deliberately bypass the full ChatStream multi-turn loop
// (which is brittle to mock) and instead invoke the registered tool's
// `exec` directly with a spy on `_dispatchSubAgent`, asserting on the
// forwarded payload. That's the smallest unit of code that owns the
// extraction contract.

describe('delegate_task.exec — seed extraction', () => {
    // Helper: build an orchestrator with one sub-agent and pull the
    // dynamically-registered `delegate_task` tool out of the main agent.
    // The cast to `any` is intentional — `_mainAgent` is private; we
    // accept the test-internal coupling so we can hit the exact code
    // path the live runtime hits (vs. recreating the schema in the
    // test, which would let the two drift).
    function makeOrch() {
        const orchestrator = new AgentOrchestrator({
            systemPrompt: 'Test',
            subAgents: [
                { name: 'vault', description: 'd', systemPrompt: 's', tools: [] },
            ],
        });
        const mainAgent = (orchestrator as unknown as { _mainAgent: { findRegisteredTool: (n: string) => RegisteredTool | undefined } })._mainAgent;
        const tool = mainAgent.findRegisteredTool('delegate_task');
        if (!tool) throw new Error('delegate_task tool not registered');
        return { orchestrator, tool };
    }

    it('forwards `handoff` arg as the seed', async () => {
        // Happy path under the canonical name: model emits the new
        // `handoff` key, orchestrator must forward it unchanged.
        const { orchestrator, tool } = makeOrch();
        const spy = vi
            .spyOn(orchestrator as unknown as { _dispatchSubAgent: (...a: unknown[]) => Promise<unknown> }, '_dispatchSubAgent')
            .mockResolvedValue({ success: true, content: 'ok' });

        await tool.exec(
            null as never,
            {
                agent: 'vault',
                task: 'go',
                handoff: { path: 'Inbox/Foo.base' },
            },
            undefined,
            { toolCallId: 'tc-1', toolCallMessage: {} as ChatMessage },
        );

        expect(spy).toHaveBeenCalledOnce();
        const payload = spy.mock.calls[0]![0] as { handoff?: Record<string, unknown> };
        expect(payload.handoff).toEqual({ path: 'Inbox/Foo.base' });
    });

    it('falls back to legacy `inputs` arg when `handoff` is absent', async () => {
        // The regression guard: some models still emit the old
        // parameter name (`inputs`) from training-data muscle memory
        // or a cached tool schema. The exec MUST treat `inputs` as a
        // transparent alias of `handoff` — anything else means the
        // seed silently disappears and the sub-agent runs against an
        // empty store, which is exactly the bug a user hit in the
        // field.
        const { orchestrator, tool } = makeOrch();
        const spy = vi
            .spyOn(orchestrator as unknown as { _dispatchSubAgent: (...a: unknown[]) => Promise<unknown> }, '_dispatchSubAgent')
            .mockResolvedValue({ success: true, content: 'ok' });

        await tool.exec(
            null as never,
            {
                agent: 'vault',
                task: 'go',
                inputs: { path: 'Inbox/Foo.base' },
            },
            undefined,
            { toolCallId: 'tc-1', toolCallMessage: {} as ChatMessage },
        );

        expect(spy).toHaveBeenCalledOnce();
        const payload = spy.mock.calls[0]![0] as { handoff?: Record<string, unknown> };
        expect(payload.handoff).toEqual({ path: 'Inbox/Foo.base' });
    });

    it('prefers `handoff` over `inputs` when both are present', async () => {
        // Defensive: a confused model could emit both keys. The
        // canonical name wins — same as the `?? `-style resolution
        // order in the source. Documenting this prevents a future
        // "merge them" refactor from accidentally clobbering the
        // intended seed.
        const { orchestrator, tool } = makeOrch();
        const spy = vi
            .spyOn(orchestrator as unknown as { _dispatchSubAgent: (...a: unknown[]) => Promise<unknown> }, '_dispatchSubAgent')
            .mockResolvedValue({ success: true, content: 'ok' });

        await tool.exec(
            null as never,
            {
                agent: 'vault',
                task: 'go',
                handoff: { path: 'A.md' },
                inputs: { path: 'B.md' },
            },
            undefined,
            { toolCallId: 'tc-1', toolCallMessage: {} as ChatMessage },
        );

        expect(spy).toHaveBeenCalledOnce();
        const payload = spy.mock.calls[0]![0] as { handoff?: Record<string, unknown> };
        expect(payload.handoff).toEqual({ path: 'A.md' });
    });

    it('forwards undefined when neither key is present', async () => {
        // Sanity: no seed at all → undefined reaches the dispatcher,
        // which `buildInitialStore(undefined)` turns into an empty
        // store. Asserting `undefined` (not `{}`) keeps the contract
        // explicit so future refactors don't paper over a missing
        // seed by silently defaulting to `{}`.
        const { orchestrator, tool } = makeOrch();
        const spy = vi
            .spyOn(orchestrator as unknown as { _dispatchSubAgent: (...a: unknown[]) => Promise<unknown> }, '_dispatchSubAgent')
            .mockResolvedValue({ success: true, content: 'ok' });

        await tool.exec(
            null as never,
            { agent: 'vault', task: 'go' },
            undefined,
            { toolCallId: 'tc-1', toolCallMessage: {} as ChatMessage },
        );

        expect(spy).toHaveBeenCalledOnce();
        const payload = spy.mock.calls[0]![0] as { handoff?: Record<string, unknown> };
        expect(payload.handoff).toBeUndefined();
    });
});
