/**
 * PR 2 — SubAgent ↔ handoff-toolcall wiring tests.
 *
 * Scope: verify ONLY the SubAgent-side plumbing introduced in PR 2,
 * specifically the `_currentHandoffStore` field's lifecycle.
 *
 * Out of scope (left to PR 3 / orchestrator-level integration tests):
 *   - End-to-end behaviour of the handoff tools through the full
 *     ChatStream tool-calling loop.
 *   - Orchestrator's payload envelope (`{ text, result, extras }`).
 *
 * The strategy here is deliberately white-box: the mock provider runs
 * a probe inside its `createStream` body to capture the SubAgent's
 * private `_currentHandoffStore` field at the moment the LLM would
 * be receiving its input. That moment is the only one that matters
 * for the handoff tools — when the model decides to call write_handoff
 * / read_handoff / list_handoff, the tool's getter closure resolves
 * the field at exactly that time.
 *
 * We don't drive a fake tool_call delta through the ChatStream loop
 * because:
 *   1. It would couple this test tightly to ChatStream's internal
 *      multi-turn loop, which is already covered by its own tests.
 *   2. The thing PR 2 actually changes — field assignment / cleanup —
 *      is fully observable without simulating tool calls.
 *
 * Calls 7 / 8 from the design doc map to the C / D tests below.
 */

import { describe, it, expect } from 'vitest';
import { SubAgent } from '../src/services/sub-agent';
import type { SubAgentConfig } from '../src/services/sub-agent';
import type { HandoffStore } from '../src/services/tools/handoff-toolcall';

// ─── Helpers ───────────────────────────────────────────────

/**
 * Mock LLM provider that runs `probe()` once at the start of each
 * `createStream()` call before yielding a single 'stop' chunk.
 *
 * The probe runs inside an async generator, i.e. *during* the active
 * `execute()` call — which is exactly when the real handoff tools'
 * handlers would resolve `_currentHandoffStore`.
 */
function createProbingProvider(
    probe: () => void,
    response: string = 'Mock response',
) {
    return {
        createStream: async function* () {
            probe();
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

/**
 * Mock provider that throws an AbortError mid-stream, simulating the
 * user / orchestrator aborting the in-flight dispatch. The probe runs
 * BEFORE the throw so we can still observe the handoff-store state
 * during the active call.
 */
function createAbortingProvider(probe: () => void) {
    return {
        createStream: async function* () {
            probe();
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
            // eslint-disable-next-line @typescript-eslint/no-unreachable
            yield { content: '', reasoningContent: null, toolCallDeltas: null, finishReason: 'stop', usage: null };
        },
        listModels: async () => ['mock-model'],
    };
}

function makeConfig(): SubAgentConfig {
    return {
        name: 'handoff-test-agent',
        description: 'SubAgent under test for handoff wiring',
        systemPrompt: 'system',
        tools: [],
    };
}

/** Read SubAgent's private `_currentHandoffStore` for assertions. */
function peekStore(agent: SubAgent): HandoffStore | null {
    return (agent as unknown as { _currentHandoffStore: HandoffStore | null })
        ._currentHandoffStore;
}

// ─── Tests ─────────────────────────────────────────────────

describe('SubAgent — handoff store wiring', () => {
    it('A: leaves _currentHandoffStore null when no store is passed', async () => {
        const agent = new SubAgent(makeConfig());

        let observedDuring: HandoffStore | null | undefined = undefined;
        const provider = createProbingProvider(() => {
            observedDuring = peekStore(agent);
        });

        await agent.execute('task', { provider: provider as never });

        // Mid-flight: nothing wired up.
        expect(observedDuring).toBeNull();
        // After cleanup: still null.
        expect(peekStore(agent)).toBeNull();
    });

    it('B: exposes the passed-in store mid-flight and clears it on completion', async () => {
        const agent = new SubAgent(makeConfig());
        const store: HandoffStore = new Map();
        store.set('seed', { hello: 'world' });

        let observedDuring: HandoffStore | null | undefined = undefined;
        const provider = createProbingProvider(() => {
            observedDuring = peekStore(agent);
        });

        await agent.execute('task', {
            provider: provider as never,
            handoffStore: store,
        });

        // Mid-flight: identity must match (NOT a copy — the tools write
        // into this same map and the orchestrator reads it back later).
        expect(observedDuring).toBe(store);
        // After cleanup: cleared.
        expect(peekStore(agent)).toBeNull();
        // Caller's store is unaffected and still holds whatever was put in it.
        expect(store.get('seed')).toEqual({ hello: 'world' });
    });

    it('C: per-dispatch isolation — sequential execute() calls see only their own store', async () => {
        const agent = new SubAgent(makeConfig());
        const storeA: HandoffStore = new Map([['tag', 'A']]);
        const storeB: HandoffStore = new Map([['tag', 'B']]);

        const observed: Array<HandoffStore | null> = [];

        // First dispatch: store A
        await agent.execute('task A', {
            provider: createProbingProvider(() => {
                observed.push(peekStore(agent));
            }) as never,
            handoffStore: storeA,
        });
        expect(peekStore(agent)).toBeNull(); // cleaned up before next call

        // Second dispatch: store B (note: ChatStream is reused internally)
        await agent.execute('task B', {
            provider: createProbingProvider(() => {
                observed.push(peekStore(agent));
            }) as never,
            handoffStore: storeB,
        });

        expect(observed).toHaveLength(2);
        expect(observed[0]).toBe(storeA);
        expect(observed[1]).toBe(storeB);
        // No cross-contamination.
        expect(observed[0]).not.toBe(storeB);
        expect(observed[1]).not.toBe(storeA);
        expect(peekStore(agent)).toBeNull();
    });

    it('D: abort path — store is cleared so a subsequent dispatch without one sees null', async () => {
        const agent = new SubAgent(makeConfig());
        const storeA: HandoffStore = new Map([['tag', 'A']]);

        let observedDuringAbort: HandoffStore | null | undefined = undefined;
        await agent.execute('task A (will abort)', {
            provider: createAbortingProvider(() => {
                observedDuringAbort = peekStore(agent);
            }) as never,
            handoffStore: storeA,
        });
        // Sanity: the probe did fire and saw the wired store, then
        // abort triggered, then cleanup ran.
        expect(observedDuringAbort).toBe(storeA);
        expect(peekStore(agent)).toBeNull();

        // Next dispatch passes NO store. The probe must see null —
        // i.e. `storeA` did not leak across.
        let observedDuringSecond: HandoffStore | null | undefined = undefined;
        await agent.execute('task B (no store)', {
            provider: createProbingProvider(() => {
                observedDuringSecond = peekStore(agent);
            }) as never,
        });
        expect(observedDuringSecond).toBeNull();
        expect(peekStore(agent)).toBeNull();
    });

    // ── Auto-fill safety net for the "silent write" case ─────────
    //
    // Some models call `write_handoff` and then end the turn without
    // producing a text reply. SubAgent.execute() should synthesize a
    // brief stand-in `summary` so the orchestrator's envelope carries a
    // positive signal (otherwise `payload.text` would be `""` and the
    // main agent's LLM may mis-read the envelope as "sub-agent failed",
    // even though `result` is right there).

    it('F: synthesizes a summary when sub-agent added `result` but produced no text reply', async () => {
        const agent = new SubAgent(makeConfig());
        const store: HandoffStore = new Map();

        // Probe runs DURING the active execute() — mutate the store like
        // a real `write_handoff` would, then yield an empty content turn.
        const provider = createProbingProvider(() => {
            store.set('result', { found: 42 });
        }, '');

        const result = await agent.execute('task', {
            provider: provider as never,
            handoffStore: store,
        });

        // fullContent reflects what the model actually produced (empty)
        expect(result.fullContent).toBe('');
        // summary is the synthesized stand-in
        expect(result.summary).not.toBe('');
        expect(result.summary).toMatch(/result/);
        expect(result.summary).toMatch(/handoff-test-agent/);
    });

    it('F2: synthesizes including extras when sub-agent added `result` plus auxiliary keys', async () => {
        const agent = new SubAgent(makeConfig());
        const store: HandoffStore = new Map();

        const provider = createProbingProvider(() => {
            store.set('result', { ok: true });
            store.set('warnings', ['legacy frontmatter']);
            store.set('candidates', ['A.md', 'B.md']);
        }, '');

        const result = await agent.execute('task', {
            provider: provider as never,
            handoffStore: store,
        });

        expect(result.summary).toMatch(/result/);
        expect(result.summary).toMatch(/warnings/);
        expect(result.summary).toMatch(/candidates/);
    });

    it('F3: synthesizes from extras alone when sub-agent wrote no `result`', async () => {
        const agent = new SubAgent(makeConfig());
        const store: HandoffStore = new Map();

        const provider = createProbingProvider(() => {
            store.set('warnings', ['anomaly']);
        }, '');

        const result = await agent.execute('task', {
            provider: provider as never,
            handoffStore: store,
        });

        // No `result` key was written, but a non-canonical extra was.
        // Synthesis still kicks in so the main agent learns extras exist.
        expect(result.summary).not.toBe('');
        expect(result.summary).toMatch(/warnings/);
        expect(result.summary).not.toMatch(/`result`/);
    });

    it('F4: does NOT synthesize when sub-agent only consumed pre-loaded seed (no new keys)', async () => {
        const agent = new SubAgent(makeConfig());
        // Pre-loaded by the main agent's `handoff` argument — counts as
        // "seed keys", NOT sub-agent output.
        const store: HandoffStore = new Map([
            ['source', 'path/to/note.md'],
            ['user_focus', 'find typos'],
        ]);

        // Probe does not mutate the store: the sub-agent only read the seed.
        const provider = createProbingProvider(() => { /* read-only */ }, '');

        const result = await agent.execute('task', {
            provider: provider as never,
            handoffStore: store,
        });

        // No new keys were added; the empty reply is the truthful signal
        // ("the sub-agent really produced nothing"). Don't paper over it.
        expect(result.summary).toBe('');
    });

    it('F5: keeps the model\'s non-empty reply verbatim (no synthesis)', async () => {
        const agent = new SubAgent(makeConfig());
        const store: HandoffStore = new Map();

        const provider = createProbingProvider(() => {
            store.set('result', { x: 1 });
        }, 'Done — see structured result.');

        const result = await agent.execute('task', {
            provider: provider as never,
            handoffStore: store,
        });

        // Real reply wins; synthesizer only fires on empty/whitespace summary.
        expect(result.summary).toBe('Done — see structured result.');
    });

    it('F6: whitespace-only reply triggers synthesis (treated as empty)', async () => {
        const agent = new SubAgent(makeConfig());
        const store: HandoffStore = new Map();

        const provider = createProbingProvider(() => {
            store.set('result', { x: 1 });
        }, '   \n  ');

        const result = await agent.execute('task', {
            provider: provider as never,
            handoffStore: store,
        });

        // A reply of just whitespace conveys nothing to the main agent
        // LLM — same failure mode as empty, same fix.
        expect(result.summary).toMatch(/result/);
    });

    it('E: provider errors during streaming still leave _currentHandoffStore null afterwards', async () => {
        const agent = new SubAgent(makeConfig());
        const storeA: HandoffStore = new Map();

        // Provider that throws a NON-abort error before yielding anything.
        // ChatStream.prompt() catches provider errors internally and surfaces
        // them as a system/error message rather than re-throwing — so
        // execute() resolves normally. Either way, the store MUST be cleared
        // before the next dispatch. We don't care about which code path
        // does the clearing here, only the post-condition.
        const explodingProvider = {
            createStream: async function* () {
                throw new Error('boom');
                // eslint-disable-next-line @typescript-eslint/no-unreachable
                yield { content: '', reasoningContent: null, toolCallDeltas: null, finishReason: 'stop', usage: null };
            },
            listModels: async () => ['mock-model'],
        };

        // Tolerate either resolution path: prompt() may surface the error
        // as a chat message (current behaviour) or — should that change —
        // re-throw. Both must end with `_currentHandoffStore === null`.
        await agent.execute('task', {
            provider: explodingProvider as never,
            handoffStore: storeA,
        }).catch(() => { /* swallow either way */ });

        expect(peekStore(agent)).toBeNull();
    });
});
