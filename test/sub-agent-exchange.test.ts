/**
 * PR 2 — SubAgent ↔ exchange-toolcall wiring tests.
 *
 * Scope: verify ONLY the SubAgent-side plumbing introduced in PR 2,
 * specifically the `_currentExchangeStore` field's lifecycle.
 *
 * Out of scope (left to PR 3 / orchestrator-level integration tests):
 *   - End-to-end behaviour of the `exchange` tool through the full
 *     ChatStream tool-calling loop.
 *   - Orchestrator's payload envelope (`{ text, result, extras }`).
 *
 * The strategy here is deliberately white-box: the mock provider runs
 * a probe inside its `createStream` body to capture the SubAgent's
 * private `_currentExchangeStore` field at the moment the LLM would
 * be receiving its input. That moment is the only one that matters
 * for the exchange tool — when the model decides to call `exchange`,
 * the tool's getter closure resolves the field at exactly that time.
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
import type { ExchangeStore } from '../src/services/tools/exchange-toolcall';

// ─── Helpers ───────────────────────────────────────────────

/**
 * Mock LLM provider that runs `probe()` once at the start of each
 * `createStream()` call before yielding a single 'stop' chunk.
 *
 * The probe runs inside an async generator, i.e. *during* the active
 * `execute()` call — which is exactly when the real exchange tool
 * handler would resolve `_currentExchangeStore`.
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
 * BEFORE the throw so we can still observe the exchange-store state
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
        name: 'exchange-test-agent',
        description: 'SubAgent under test for exchange wiring',
        systemPrompt: 'system',
        tools: [],
    };
}

/** Read SubAgent's private `_currentExchangeStore` for assertions. */
function peekStore(agent: SubAgent): ExchangeStore | null {
    return (agent as unknown as { _currentExchangeStore: ExchangeStore | null })
        ._currentExchangeStore;
}

// ─── Tests ─────────────────────────────────────────────────

describe('SubAgent — exchange store wiring', () => {
    it('A: leaves _currentExchangeStore null when no store is passed', async () => {
        const agent = new SubAgent(makeConfig());

        let observedDuring: ExchangeStore | null | undefined = undefined;
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
        const store: ExchangeStore = new Map();
        store.set('seed', { hello: 'world' });

        let observedDuring: ExchangeStore | null | undefined = undefined;
        const provider = createProbingProvider(() => {
            observedDuring = peekStore(agent);
        });

        await agent.execute('task', {
            provider: provider as never,
            exchangeStore: store,
        });

        // Mid-flight: identity must match (NOT a copy — the tool writes
        // into this same map and the orchestrator reads it back later).
        expect(observedDuring).toBe(store);
        // After cleanup: cleared.
        expect(peekStore(agent)).toBeNull();
        // Caller's store is unaffected and still holds whatever was put in it.
        expect(store.get('seed')).toEqual({ hello: 'world' });
    });

    it('C: per-dispatch isolation — sequential execute() calls see only their own store', async () => {
        const agent = new SubAgent(makeConfig());
        const storeA: ExchangeStore = new Map([['tag', 'A']]);
        const storeB: ExchangeStore = new Map([['tag', 'B']]);

        const observed: Array<ExchangeStore | null> = [];

        // First dispatch: store A
        await agent.execute('task A', {
            provider: createProbingProvider(() => {
                observed.push(peekStore(agent));
            }) as never,
            exchangeStore: storeA,
        });
        expect(peekStore(agent)).toBeNull(); // cleaned up before next call

        // Second dispatch: store B (note: ChatStream is reused internally)
        await agent.execute('task B', {
            provider: createProbingProvider(() => {
                observed.push(peekStore(agent));
            }) as never,
            exchangeStore: storeB,
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
        const storeA: ExchangeStore = new Map([['tag', 'A']]);

        let observedDuringAbort: ExchangeStore | null | undefined = undefined;
        await agent.execute('task A (will abort)', {
            provider: createAbortingProvider(() => {
                observedDuringAbort = peekStore(agent);
            }) as never,
            exchangeStore: storeA,
        });
        // Sanity: the probe did fire and saw the wired store, then
        // abort triggered, then cleanup ran.
        expect(observedDuringAbort).toBe(storeA);
        expect(peekStore(agent)).toBeNull();

        // Next dispatch passes NO store. The probe must see null —
        // i.e. `storeA` did not leak across.
        let observedDuringSecond: ExchangeStore | null | undefined = undefined;
        await agent.execute('task B (no store)', {
            provider: createProbingProvider(() => {
                observedDuringSecond = peekStore(agent);
            }) as never,
        });
        expect(observedDuringSecond).toBeNull();
        expect(peekStore(agent)).toBeNull();
    });

    it('E: provider errors during streaming still leave _currentExchangeStore null afterwards', async () => {
        const agent = new SubAgent(makeConfig());
        const storeA: ExchangeStore = new Map();

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
        // re-throw. Both must end with `_currentExchangeStore === null`.
        await agent.execute('task', {
            provider: explodingProvider as never,
            exchangeStore: storeA,
        }).catch(() => { /* swallow either way */ });

        expect(peekStore(agent)).toBeNull();
    });
});
