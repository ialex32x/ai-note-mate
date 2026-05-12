import { describe, it, expect, vi } from 'vitest';
import { AgentOrchestrator, buildDelegatePayload, buildInitialStore, EXCHANGE_VALUE_MAX_BYTES, InvalidDelegateInputError } from '../src/services/agent-orchestrator';
import type { SubAgentConfig } from '../src/services/sub-agent';
import type { ExchangeStore } from '../src/services/tools/exchange-toolcall';
import type { RegisteredTool, ToolCallResult, ChatMessage } from '../src/services/chat-stream';

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

// ─── buildDelegatePayload ──────────────────────────────────
//
// Pure function — covers the structural logic that decides what the main
// agent sees as the `delegate_task` tool_result. End-to-end wiring (store
// is actually handed to sub-agent.execute, JSON.stringify happens, etc.)
// is covered by:
//   - the SubAgent exchange tests in `sub-agent-exchange.test.ts` (store
//     plumbing on the sub-agent side)
//   - TS type-checking of the orchestrator wiring (3 lines of glue)
//   - manual smoke test in a real Obsidian vault (per the design plan)
// Driving a full mock-provider tool_call loop just to verify those 3 lines
// would lock the orchestrator's tests to ChatStream's internal multi-turn
// implementation, which is brittle and low-ROI. We test the logic that
// CAN drift — the envelope-building rules — directly.

describe('buildDelegatePayload', () => {
    it('returns just `text` when the store is empty (5-fallback)', () => {
        // The vast majority of legacy sub-agents never call exchange.put.
        // For them the envelope must collapse to `{ text }` only — no
        // empty `result: null`, no empty `extras: {}` — so the JSON the
        // main LLM sees stays compact and indistinguishable in spirit
        // from the pre-exchange plain-text behaviour.
        const store: ExchangeStore = new Map();
        const payload = buildDelegatePayload('plain summary', store);

        expect(payload).toEqual({ text: 'plain summary' });
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
        const store: ExchangeStore = new Map();
        store.set('result', { paths: ['a/b.md', 'c.md'], count: 2 });

        const payload = buildDelegatePayload('found 2 notes', store);

        expect(payload.text).toBe('found 2 notes');
        expect(payload.result).toEqual({ paths: ['a/b.md', 'c.md'], count: 2 });
        expect(payload.extras).toBeUndefined();
        expect(payload.omitted).toBeUndefined();
    });

    it('routes non-`result` keys to `extras`', () => {
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const huge = 'x'.repeat(EXCHANGE_VALUE_MAX_BYTES + 1024);
        const store: ExchangeStore = new Map();
        store.set('result', huge);

        const payload = buildDelegatePayload('too big to inline', store);

        // The huge value MUST NOT appear inline.
        expect(payload.result).toBeUndefined();
        // But the main agent MUST learn the value existed and how big it was.
        expect(payload.omitted).toBeDefined();
        expect(payload.omitted!['result_omitted']).toBe(true);
        expect(typeof payload.omitted!['result_size']).toBe('number');
        expect(payload.omitted!['result_size'] as number).toBeGreaterThan(EXCHANGE_VALUE_MAX_BYTES);
        // Sanity: stringified envelope is reasonably small now.
        expect(JSON.stringify(payload).length).toBeLessThan(EXCHANGE_VALUE_MAX_BYTES);
    });

    it('preserves small values alongside oversized ones', () => {
        // Mixed case: one oversized, one fine. The fine one must survive
        // intact (oversized handling is per-key, not global).
        const huge = 'y'.repeat(EXCHANGE_VALUE_MAX_BYTES + 100);
        const store: ExchangeStore = new Map();
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
        // serializable value (it shouldn't — the exchange tool already
        // rejects them at put time, but defence in depth) we want this
        // test to flag it.
        const store: ExchangeStore = new Map();
        store.set('result', { nested: { a: 1, b: [true, null, 'x'] } });
        store.set('extra1', 42);

        const payload = buildDelegatePayload('ok', store);
        const json = JSON.stringify(payload);
        const roundTripped = JSON.parse(json);

        expect(roundTripped).toEqual({
            text: 'ok',
            result: { nested: { a: 1, b: [true, null, 'x'] } },
            extras: { extra1: 42 },
        });
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
        store.set('result', { matches: ['a/b.md', 'c.md'] });

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        expect(payload.result).toEqual({ matches: ['a/b.md', 'c.md'] });
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('skips validation when result was omitted for size', () => {
        // If result is too large to inline, it never reaches the validator;
        // surfacing schema issues about a value the main agent can't see
        // would just be noise.
        const store: ExchangeStore = new Map();
        const huge = { digests: [{ path: 'x', summary: 'x'.repeat(EXCHANGE_VALUE_MAX_BYTES + 100) }] };
        store.set('result', huge);

        const payload = buildDelegatePayload('done', store, 'vault_inspector');
        expect(payload.result).toBeUndefined();
        expect(payload.omitted).toBeDefined();
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('does not validate when no agentName is supplied (back-compat)', () => {
        // Existing callers and tests pass only (text, store) — the third
        // arg is optional and absence means "skip validation". This
        // ensures the new behaviour is fully opt-in.
        const store: ExchangeStore = new Map();
        store.set('result', { digests: [{ path: 'x' }] }); // would fail schema

        const payload = buildDelegatePayload('done', store);
        expect(payload.result).toBeDefined();
        expect(payload.extras?.['result_validation_issues']).toBeUndefined();
    });

    it('does not validate for unknown agent names', () => {
        // Sub-agents without a registered validator pass through
        // unchanged — adding a new sub-agent should never accidentally
        // trigger schema enforcement intended for a different one.
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
        const store: ExchangeStore = new Map();
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
// direction (the `inputs` argument of delegate_task). End-to-end wiring
// (the orchestrator actually calls this and refuses to start the
// sub-agent on InvalidDelegateInputError) is covered by TS type-checking
// + manual smoke; the behaviour that CAN drift — what counts as a valid
// input — is tested directly here.

describe('buildInitialStore', () => {
    it('returns an empty store when inputs is undefined or null', () => {
        // The common case: main agent didn't pass `inputs` at all.
        // Must NOT throw, must NOT pre-populate anything — the sub-agent
        // sees a clean store, identical to pre-inputs behaviour.
        expect(buildInitialStore(undefined).size).toBe(0);
        expect(buildInitialStore(null).size).toBe(0);
    });

    it('returns an empty store for an empty object', () => {
        // Edge case: explicitly `{}`. Should be indistinguishable from
        // "no inputs" — no special marker, no thrown error.
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
        // exchange tool already rejects them at put-time, so the input
        // path mirrors that for consistency.
        class MyShape { constructor(public n = 1) {} }
        const inst = new MyShape();
        expect(() => buildInitialStore(inst as unknown as Record<string, unknown>))
            .toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore(inst as unknown as Record<string, unknown>))
            .toThrow(/plain object/);
    });

    it('rejects empty string keys', () => {
        // The exchange tool's `put` path also rejects "" as a key (would
        // produce ambiguous list output); the input path enforces the
        // same constraint up front.
        expect(() => buildInitialStore({ '': 1 })).toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore({ '': 1 })).toThrow(/empty key/);
    });

    it('rejects non-JSON-serializable values with the offending path in the message', () => {
        // Defence in depth: validateSerializable is the canonical
        // checker; we re-run it here so a bad input fails BEFORE any
        // sub-agent tokens are spent (cheaper than discovering the
        // problem when the orchestrator JSON.stringify's the envelope).
        // The error message must reference the failing key so the main
        // LLM can self-correct.
        const inputs = { good: 1, bad: () => 42 };
        expect(() => buildInitialStore(inputs as unknown as Record<string, unknown>))
            .toThrow(InvalidDelegateInputError);
        expect(() => buildInitialStore(inputs as unknown as Record<string, unknown>))
            .toThrow(/"bad"/);
    });

    it('rejects oversized values rather than silently truncating', () => {
        // Asymmetric with the OUTPUT path (which degrades to `omitted`
        // markers): on the INPUT path the LLM hasn't paid for generation
        // yet, so a hard error is the right move — it lets the main LLM
        // re-delegate with a leaner input or a reference instead of the
        // raw payload.
        const huge = 'x'.repeat(EXCHANGE_VALUE_MAX_BYTES + 1024);
        expect(() => buildInitialStore({ source: huge }))
            .toThrow(InvalidDelegateInputError);
        // Error must mention the cap so the main LLM sees a concrete
        // budget number, not a vague "too big".
        expect(() => buildInitialStore({ source: huge }))
            .toThrow(new RegExp(String(EXCHANGE_VALUE_MAX_BYTES)));
    });

    it('rejects non-finite numbers (delegated to validateSerializable)', () => {
        // Sanity: rules forbidden by the exchange tool's put path are
        // also forbidden here. Don't enumerate every rule — just confirm
        // the validator is wired in.
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
