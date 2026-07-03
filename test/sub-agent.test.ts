import { describe, it, expect, vi } from 'vitest';
import { SubAgent } from '../src/services/sub-agent';
import type { SubAgentConfig } from '../src/services/sub-agent';
import type { ChatMessage, RegisteredTool, ToolCallResult } from '../src/services/chat-stream';
import type { HandoffStore } from '../src/services/tools/handoff-toolcall';

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
                usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0 },
            };
        },
        listModels: async () => ['mock-model'],
    };
}

/** Create a mock tool */
function createMockTool(name: string, result: string = 'tool result'): RegisteredTool {
    return {
        ondemand: false,
        schema: {
            type: 'function',
            function: {
                name,
                description: `Mock tool: ${name}`,
                parameters: { type: 'object', properties: {} },
            },
        },
        exec: async (): Promise<ToolCallResult> => ({
            success: true,
            type: 'text',
            content: result,
        }),
    };
}

// ─── Tests ─────────────────────────────────────────────────

describe('SubAgent', () => {
    it('should create a SubAgent with correct name and description', () => {
        const config: SubAgentConfig = {
            name: 'test-agent',
            description: 'A test agent',
            systemPrompt: 'You are a test agent.',
            tools: [],
        };

        const agent = new SubAgent(config);
        expect(agent.name).toBe('test-agent');
        expect(agent.description).toBe('A test agent');
    });

    it('should execute a simple task and return result', async () => {
        const config: SubAgentConfig = {
            name: 'simple-agent',
            description: 'Simple agent',
            systemPrompt: 'You are a simple agent.',
            tools: [],
        };

        const agent = new SubAgent(config);
        const result = await agent.execute('Say hello', {
            provider: createMockProvider('Hello from sub-agent!') as any,
        });

        expect(result.aborted).toBe(false);
        expect(result.fullContent).toBe('Hello from sub-agent!');
        expect(result.summary).toBe('Hello from sub-agent!');
        expect(result.tokenUsage.totalTokens).toBe(15);
    });

    it('should include context in user message when provided', async () => {
        const config: SubAgentConfig = {
            name: 'context-agent',
            description: 'Context agent',
            systemPrompt: 'You are a context agent.',
            tools: [],
        };

        const agent = new SubAgent(config);
        const result = await agent.execute('Do something', {
            provider: createMockProvider('Done with context') as any,
            context: 'Some conversation context',
        });

        expect(result.fullContent).toBe('Done with context');
    });

    it('should return fullContent as summary regardless of resultMaxTokens (artifact promotion replaces summarization)', async () => {
        const largeResponse = 'x'.repeat(50000);
        const config: SubAgentConfig = {
            name: 'large-result-agent',
            description: 'Large result agent',
            systemPrompt: 'You are a large result agent.',
            tools: [],
            resultMaxTokens: 100, // No longer triggers summarization — oversized text is handled by buildDelegatePayload
        };

        const agent = new SubAgent(config);
        const result = await agent.execute('Generate large output', {
            provider: createMockProvider(largeResponse) as any,
        });

        // Sub-agents no longer summarise/compress results.
        // Oversized text is promoted to artifacts downstream by buildDelegatePayload.
        expect(result.fullContent).toBe(largeResponse);
        expect(result.summary).toBe(largeResponse);
    });

    it('should return execution log after execution', async () => {
        const config: SubAgentConfig = {
            name: 'log-agent',
            description: 'Log agent',
            systemPrompt: 'You are a log agent.',
            tools: [],
        };

        const agent = new SubAgent(config);

        // Before execution, no log
        expect(agent.getExecutionLog()).toBeNull();

        await agent.execute('Test task', {
            provider: createMockProvider('Log result') as any,
        });

        const log = agent.getExecutionLog();
        expect(log).not.toBeNull();
        expect(log!.agentName).toBe('log-agent');
        expect(log!.task).toBe('Test task');
        expect(log!.aborted).toBe(false);
        expect(log!.endTime).toBeGreaterThanOrEqual(log!.startTime);
    });
});

// ─── Aborted tool_call finalization ─────────────────────────
//
// Regression guard for a UX bug observed in the field: when the user
// hit "stop" while a sub-agent had a `write_handoff` (or any tool) call
// in flight, the tool-call bubble stayed stuck in `streaming: true`
// with `toolCallResult === undefined` forever. The renderer's
// `if (msg.toolCallResult)` gate then silently omitted the RESULT
// section, which the user reasonably read as "the tool returned
// nothing" — even though from the model's perspective the call was
// simply never observed (the abort tore the turn down before the
// result could be recorded).
//
// The fix in `ChatStream` finalizes the in-flight tool_call message
// on both abort exit paths (exec-aborted and post-exec-aborted)
// before re-throwing. These tests drive a synthetic tool_call
// through the streaming loop and abort at a precise moment so we
// can verify the finalization actually fires end-to-end via the
// SubAgent's normal `onMessageUpdate` forwarding.

/**
 * Mock provider that emits a tool_call delta on its FIRST createStream
 * call and a plain stop on every subsequent call. The two-phase
 * behaviour is required because ChatStream loops `createStream → run
 * tool_call → createStream` until the model finishes; a stateless
 * provider that always yields a tool_call would loop forever.
 */
function createToolCallProvider(toolName: string, toolArgs: object) {
    let calls = 0;
    return {
        createStream: async function* () {
            const callIdx = calls++;
            if (callIdx === 0) {
                yield {
                    content: '',
                    reasoningContent: null,
                    toolCallDeltas: [
                        {
                            index: 0,
                            id: 'tc-1',
                            function: {
                                name: toolName,
                                arguments: JSON.stringify(toolArgs),
                            },
                        },
                    ],
                    finishReason: 'tool_calls',
                    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedPromptTokens: 0 },
                };
                return;
            }
            // Second turn: the model has now seen the tool_result and
            // produces its final assistant text. Anything non-empty
            // satisfies the "sub-agent must produce a reply" path.
            yield {
                content: 'done',
                reasoningContent: null,
                toolCallDeltas: null,
                finishReason: 'stop',
                usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
            };
        },
        listModels: async () => ['mock-model'],
    };
}

/** Simple deferred for hand-rolled exec-timing control. */
function createDeferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('SubAgent — aborted tool_call finalization', () => {
    it('marks an in-flight tool_call message complete with a warning result when aborted after exec returns', async () => {
        // Scenario: user clicks "stop" while the sub-agent has just
        // finished executing a tool call but the result hasn't been
        // recorded onto the bubble yet. This is the path the user
        // actually hit in production with `read_handoff`.
        const updates: ChatMessage[] = [];
        const deferredExec = createDeferred<ToolCallResult>();

        const controllableTool: RegisteredTool = {
            ondemand: false,
            schema: {
                type: 'function',
                function: {
                    name: 'slow_tool',
                    description: 'A tool whose exec resolution we control from the test',
                    parameters: { type: 'object', properties: {} },
                },
            },
            // Returning the deferred lets the test gate the moment exec
            // completes, so we can sandwich an `abort()` between
            // "tool_call message created" and "exec resolves".
            exec: () => deferredExec.promise,
        };

        const config: SubAgentConfig = {
            name: 'abort-finalize-agent',
            description: 'Tests abort finalization',
            systemPrompt: 'system',
            tools: [controllableTool],
        };

        const agent = new SubAgent(config);

        // Resolve as soon as the tool_call message first appears (in
        // its streaming, no-toolCallResult state). That's the
        // earliest possible moment the test can pull the abort
        // trigger and still hit the "exec ran but turn was torn
        // down before recording the result" branch.
        let resolveToolCallSeen!: () => void;
        const toolCallSeen = new Promise<void>(r => { resolveToolCallSeen = r; });

        const execPromise = agent.execute('do it', {
            provider: createToolCallProvider('slow_tool', { x: 1 }) as never,
            onMessageUpdate: (_name, msg) => {
                // Capture by value — the SubAgent reuses the same
                // object reference across the streaming/finalized
                // states, so a raw push would let later mutations
                // overwrite the snapshots we want to assert against.
                updates.push({ ...msg, toolCallResult: msg.toolCallResult ? { ...msg.toolCallResult } : undefined });
                if (msg.role === 'tool_call' && msg.toolCallMeta?.toolName === 'slow_tool' && !msg.toolCallResult) {
                    resolveToolCallSeen();
                }
            },
        });

        await toolCallSeen;
        agent.abort();
        // Resolving AFTER abort exercises the post-exec abort check
        // in ChatStream: exec runs to completion, the abort check
        // fires, and our finalization patches up the bubble before
        // AbortError unwinds up the stack. (ChatStream.prompt's own
        // outer catch swallows AbortError into a graceful return, so
        // SubAgent.execute resolves normally — `result.aborted` is
        // intentionally NOT relied on here; the only invariant we
        // care about is that the bubble's final state has a
        // toolCallResult attached, which is the bug this fixes.)
        deferredExec.resolve({ success: true, type: 'text', content: 'late result' });

        await execPromise;

        const toolCallStates = updates.filter(
            m => m.role === 'tool_call' && m.toolCallMeta?.toolName === 'slow_tool',
        );
        // We expect AT LEAST two emissions: the initial streaming
        // state and the post-abort finalization. (More emissions
        // are fine — e.g. confirmation flows in other tools — so
        // we don't pin the count exactly.)
        expect(toolCallStates.length).toBeGreaterThanOrEqual(2);

        const last = toolCallStates[toolCallStates.length - 1]!;
        expect(last.streaming).toBe(false);
        expect(last.toolCallResult).toBeDefined();
        // 'warning' (not 'error'): nothing malfunctioned — the user
        // just interrupted the flow. The renderer maps 'warning' to
        // its own colour + icon so the bubble is visually distinct
        // from a successful call.
        expect(last.toolCallResult!.status).toBe('warning');
        expect(last.toolCallResult!.result).toMatch(/[Aa]borted/);
    });

    it('also finalizes when AbortError is thrown from inside exec itself', async () => {
        // Symmetric scenario: the tool's own exec aborts (e.g. an
        // async fetch tool that observes its `AbortSignal`). The
        // catch block in chat-stream sees AbortError and unwinds —
        // historically that path also left the bubble stuck. This
        // guards the second arm of the same finalization.
        const updates: ChatMessage[] = [];

        const abortingTool: RegisteredTool = {
            ondemand: false,
            schema: {
                type: 'function',
                function: {
                    name: 'aborting_tool',
                    description: 'Throws AbortError from within exec',
                    parameters: { type: 'object', properties: {} },
                },
            },
            exec: async () => {
                const err = new DOMException('Aborted by test', 'AbortError');
                throw err;
            },
        };

        const config: SubAgentConfig = {
            name: 'exec-abort-agent',
            description: 'Tests exec-thrown abort finalization',
            systemPrompt: 'system',
            tools: [abortingTool],
        };

        const agent = new SubAgent(config);
        // ChatStream's outer try/catch turns AbortError into a graceful
        // return (see the `prompt()` epilogue), so execute() resolves
        // normally rather than rejecting. We don't pin `result.aborted`
        // here for the same reason as the test above — the invariant
        // under test is the bubble finalization, not the abort
        // propagation contract.
        await agent.execute('do it', {
            provider: createToolCallProvider('aborting_tool', {}) as never,
            onMessageUpdate: (_name, msg) => {
                updates.push({ ...msg, toolCallResult: msg.toolCallResult ? { ...msg.toolCallResult } : undefined });
            },
        });

        const toolCallStates = updates.filter(
            m => m.role === 'tool_call' && m.toolCallMeta?.toolName === 'aborting_tool',
        );
        expect(toolCallStates.length).toBeGreaterThanOrEqual(2);
        const last = toolCallStates[toolCallStates.length - 1]!;
        expect(last.streaming).toBe(false);
        expect(last.toolCallResult).toBeDefined();
        expect(last.toolCallResult!.status).toBe('warning');
        expect(last.toolCallResult!.result).toMatch(/[Aa]borted/);
    });
});

// ─── Normal (non-abort) tool_call lifecycle ─────────────────
//
// Sanity guard against UX reports of the form "the handoff bubble
// shows ARGUMENTS but no RESULT in normal flow". The chat-stream
// dispatch contract is: emit onMessageUpdate twice for every tool
// call — once on creation (streaming, no result), once on
// completion (not streaming, with result). The renderer's
// `if (msg.toolCallResult)` gate then materialises the RESULT
// section on the second emit. If this test ever fails, the
// second emit is dropping somewhere along the
// chat-stream → SubAgent → orchestrator → view chain.

describe('SubAgent — normal tool_call lifecycle', () => {
    it('emits a streaming-then-finalized pair for a successful tool call (with a populated toolCallResult)', async () => {
        const updates: ChatMessage[] = [];

        // Use a tool that mirrors the shape the handoff tools return
        // (type='object'), since the user-reported missing-RESULT
        // case happens specifically on handoff bubbles. This way the
        // test catches any regression in object-result serialisation
        // that might silently drop the second emit.
        const objectResultTool: RegisteredTool = {
            ondemand: true,
            schema: {
                type: 'function',
                function: {
                    name: 'object_result_tool',
                    description: 'Returns an object result',
                    parameters: { type: 'object', properties: {} },
                },
            },
            exec: async (): Promise<ToolCallResult> => ({
                success: true,
                type: 'object',
                content: { values: { path: 'Inbox/Foo.md' }, missing: [] },
            }),
        };

        const config: SubAgentConfig = {
            name: 'normal-lifecycle-agent',
            description: 'Tests normal completion emits',
            systemPrompt: 'system',
            tools: [objectResultTool],
        };

        const agent = new SubAgent(config);
        await agent.execute('do it', {
            provider: createToolCallProvider('object_result_tool', { op: 'get', keys: ['path'] }) as never,
            onMessageUpdate: (_name, msg) => {
                updates.push({ ...msg, toolCallResult: msg.toolCallResult ? { ...msg.toolCallResult } : undefined });
            },
        });

        const toolCallStates = updates.filter(
            m => m.role === 'tool_call' && m.toolCallMeta?.toolName === 'object_result_tool',
        );
        // Two emits: initial streaming + final completion. (The
        // throttled streaming-emit logic in `_processStream`
        // doesn't apply here — that path coalesces *content* /
        // *thinking* chunk emits, not tool_call lifecycle emits.)
        expect(toolCallStates.length).toBeGreaterThanOrEqual(2);

        const first = toolCallStates[0]!;
        expect(first.streaming).toBe(true);
        expect(first.toolCallResult).toBeUndefined();

        const last = toolCallStates[toolCallStates.length - 1]!;
        expect(last.streaming).toBe(false);
        expect(last.toolCallResult).toBeDefined();
        expect(last.toolCallResult!.status).toBe('success');
        // The object result must be JSON-serialised into the
        // result string — the bubble renderer copies this string
        // verbatim into the RESULT <pre> block, so a missing
        // serialisation here would render an empty RESULT.
        expect(last.toolCallResult!.result).toContain('Inbox/Foo.md');
    });

    it('end-of-turn safety net finalizes any tool_call message left at streaming=true (defence-in-depth)', async () => {
        // Defends against an entire class of UX bugs reported in
        // the field: a tool_call bubble visually stuck at `…`
        // even though the LLM-facing tool_result reached the
        // model. The dispatch loop in chat-stream is supposed to
        // transition every tool_call out of `streaming: true`
        // before the next iteration, but if anything along the
        // chat-pipeline message-update chain (chat-stream →
        // SubAgent forwarder → orchestrator bucket → runtime →
        // session-view) silently drops the finalization emit,
        // the bubble stays spinning. The end-of-turn safety net
        // in `prompt()` re-emits a forced finalization so the
        // bubble can't get stuck for longer than one turn.
        //
        // We simulate the bug condition by injecting a synthetic
        // stuck message into history via `restoreState`, then
        // running a normal prompt that exits via the success
        // path. The safety net runs in that path and patches up
        // the stuck message.
        const updates: ChatMessage[] = [];
        const stuckId = 'stuck-tool-call-1';

        const config: SubAgentConfig = {
            name: 'safety-net-agent',
            description: 'Tests the stuck-tool-call safety net',
            systemPrompt: 'system',
            tools: [],
        };

        const agent = new SubAgent(config);

        // Prime the reusable ChatStream with a stuck tool_call message
        // BEFORE execute() runs. The SubAgent's per-execute
        // _currentExecIds tracker only forwards updates for ids it
        // has seen in the current execute — but the safety net
        // explicitly walks _messages and re-emits, so the
        // finalization update DOES carry the same id and the
        // forwarder will mark it as "seen this execute" on first
        // touch. To make this test deterministic, we let the
        // SubAgent see the stuck id via a probe injection:
        // restoreState happens inside the same execute via a
        // custom provider that re-creates the stuck state on
        // first tick.

        // Inject a synthetic stuck tool_call straight into the
        // ChatStream's `_messages` array on first stream tick.
        // We can't use the public `restoreState` API because it
        // intentionally forces `streaming: false` on every restored
        // message — which is the OTHER half of the same defence we
        // care about. To exercise the safety net, the stuck flag
        // must survive into the dispatch loop, so we mutate
        // `_messages` directly via a typed cast.
        //
        // The SubAgent's per-execute id tracker only forwards
        // updates for ids it has seen during the active execute().
        // We pre-seed the tracker by directly adding the stuck id
        // before the safety net runs (same access pattern). The
        // safety net's emit then arrives with `id === stuckId` and
        // passes the tracker check.
        let stuckInjected = false;
        await agent.execute('do it', {
            provider: {
                createStream: async function* () {
                    if (!stuckInjected) {
                        stuckInjected = true;
                        const innerAgent = agent as unknown as {
                            _reusableChatStream: { _messages: ChatMessage[] } | null;
                            _currentExecIds: Set<string> | null;
                        };
                        const innerStream = innerAgent._reusableChatStream;
                        if (innerStream) {
                            innerStream._messages.push({
                                id: stuckId,
                                role: 'tool_call',
                                content: 'read_handoff',
                                streaming: true,
                                timestamp: Date.now(),
                                toolCallMeta: {
                                    toolCallId: 'tc-stuck',
                                    toolName: 'read_handoff',
                                    toolArgs: { keys: ['path'] },
                                },
                            });
                        }
                        // Pre-seed the SubAgent's per-execute id
                        // tracker so its forwarder doesn't drop the
                        // safety net's finalization emit for an id
                        // it has otherwise never seen.
                        innerAgent._currentExecIds?.add(stuckId);
                    }
                    yield {
                        content: 'done',
                        reasoningContent: null,
                        toolCallDeltas: null,
                        finishReason: 'stop',
                        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
                    };
                },
                listModels: async () => ['mock-model'],
            } as never,
            onMessageUpdate: (_name, msg) => {
                updates.push({ ...msg, toolCallResult: msg.toolCallResult ? { ...msg.toolCallResult } : undefined });
            },
        });

        // After execute() resolves, the safety net should have
        // re-emitted a finalized version of the stuck message
        // (status='warning', streaming=false, populated result).
        const stuckEmits = updates.filter(m => m.id === stuckId);
        expect(stuckEmits.length).toBeGreaterThanOrEqual(1);
        const finalEmit = stuckEmits[stuckEmits.length - 1]!;
        expect(finalEmit.streaming).toBe(false);
        expect(finalEmit.toolCallResult).toBeDefined();
        expect(finalEmit.toolCallResult!.status).toBe('warning');
        expect(finalEmit.toolCallResult!.result).toMatch(/no result|result was captured/i);
    });

    it('embedding-filtered ondemand tool is still dispatched (filter-miss fallback), not left stuck at streaming=true', async () => {
        // Regression for the field bug "handoff bubble shows
        // ARGUMENTS but no RESULT and spins forever":
        //
        //   1. The legacy `exchange` tool was registered with
        //      `ondemand: true`.
        //   2. Its description ("read/write a key-value store") had
        //      low embedding similarity to most sub-agent queries.
        //   3. The embedding filter dropped it from `filteredTools`.
        //   4. The model still called it (recalled from system prompt).
        //   5. The dispatch loop hit `!registered`, found no
        //      onToolCall callback on the sub-agent ChatStream, and
        //      THREW — bypassing the finalization that sets
        //      `streaming = false` and populates `toolCallResult`.
        //   6. The bubble was left stuck.
        //
        // The fix: when `filteredTools.find` misses but the tool IS
        // capability-allowed and registered, dispatch it directly
        // (filter-miss fallback). This test forces the miss by
        // monkey-patching `_getBestMatchedTools` to return an empty
        // set — equivalent to an embedding filter that drops
        // everything ondemand.
        const updates: ChatMessage[] = [];
        const execSpy = vi.fn(async (): Promise<ToolCallResult> => ({
            success: true,
            type: 'object',
            content: { ok: true, key: 'result' },
        }));

        const filteredOutTool: RegisteredTool = {
            ondemand: true,
            schema: {
                type: 'function',
                function: {
                    name: 'filtered_out_tool',
                    description: 'A tool whose embedding score is too low to survive the filter',
                    parameters: { type: 'object', properties: {} },
                },
            },
            exec: execSpy,
        };

        const config: SubAgentConfig = {
            name: 'filter-miss-agent',
            description: 'Tests the embedding filter-miss fallback',
            systemPrompt: 'system',
            tools: [filteredOutTool],
        };

        const agent = new SubAgent(config);

        // Force the ChatStream's embedding-filter step to drop EVERY
        // ondemand tool, simulating a real embedder returning low
        // similarity scores. We patch *after* the reusable stream
        // exists, so we have to trigger one execute() first — or
        // patch lazily inside the provider. The latter keeps the
        // patch ordering deterministic.
        // Force the embedding-filter step to drop EVERY ondemand
        // tool — equivalent to a real embedder returning low
        // similarity scores against every query — by patching
        // `_getBestMatchedTools` on the ChatStream prototype BEFORE
        // execute() runs. We patch the prototype rather than the
        // instance because SubAgent constructs ChatStream lazily
        // inside execute() and `_getBestMatchedTools` is called at
        // the *top* of the dispatch loop, before any provider
        // interaction we could hook into.
        const { ChatStream } = await import('../src/services/chat-stream');
        type ChatStreamProto = {
            _getBestMatchedTools: (...args: unknown[]) => Promise<unknown[]>;
        };
        const proto = ChatStream.prototype as unknown as ChatStreamProto;
        const original = proto._getBestMatchedTools;
        proto._getBestMatchedTools = async () => [];

        // Provider has to be two-phase: first turn yields a
        // tool_call for the filtered-out tool (the model "recalls"
        // it from system-prompt memory even though it's not in the
        // current schema list), second turn yields a final
        // assistant message so the loop terminates.
        let turn = 0;
        try {
            await agent.execute('do it', {
                provider: {
                    createStream: function (
                        _messages: unknown,
                        toolSchemas: unknown,
                    ) {
                        const callIdx = turn++;
                        async function* gen() {
                            if (callIdx === 0) {
                                // Sanity guard: the filter patch
                                // should have hidden every tool from
                                // the provider on this turn. If
                                // chat-stream ever changes how it
                                // passes the empty list, this
                                // assertion catches the drift early.
                                expect(toolSchemas).toBeUndefined();
                                yield {
                                    content: '',
                                    reasoningContent: null,
                                    toolCallDeltas: [{
                                        index: 0,
                                        id: 'call-filtered-1',
                                        function: { name: 'filtered_out_tool', arguments: '{}' },
                                    }],
                                    finishReason: 'tool_calls',
                                    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
                                };
                                return;
                            }
                            yield {
                                content: 'done',
                                reasoningContent: null,
                                toolCallDeltas: null,
                                finishReason: 'stop',
                                usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
                            };
                        }
                        return gen();
                    },
                    listModels: async () => ['mock-model'],
                } as never,
                onMessageUpdate: (_name, msg) => {
                    updates.push({ ...msg, toolCallResult: msg.toolCallResult ? { ...msg.toolCallResult } : undefined });
                },
            });
        } finally {
            proto._getBestMatchedTools = original;
        }

        // The tool must actually have been dispatched (i.e. the
        // fallback path ran, not the throw path).
        expect(execSpy).toHaveBeenCalledTimes(1);

        // And the tool_call bubble must be finalized properly.
        const toolCallStates = updates.filter(
            m => m.role === 'tool_call' && m.toolCallMeta?.toolName === 'filtered_out_tool',
        );
        expect(toolCallStates.length).toBeGreaterThanOrEqual(2);
        const last = toolCallStates[toolCallStates.length - 1]!;
        expect(last.streaming).toBe(false);
        expect(last.toolCallResult).toBeDefined();
        expect(last.toolCallResult!.status).toBe('success');
    });

    it('write_result_object bubble (real built-in tool) gets streaming=false and a populated toolCallResult after a successful write', async () => {
        // Replicates the user-reported scenario: a sub-agent calls
        // `write_result_object({key:'result', value:...})` and the
        // bubble was visually stuck at `...`. The chat-stream's
        // dispatch contract must hand a finalized message to the
        // UI here too — there is nothing handoff-specific in the
        // bubble pipeline, but registering the REAL tool (rather
        // than a fake stub) catches any regression in
        // `serialiseToolResult` for object-typed payloads or in
        // the per-execute handoff-store wiring on the sub-agent.
        const updates: ChatMessage[] = [];
        const store: HandoffStore = new Map();

        const config: SubAgentConfig = {
            name: 'real-result-object-agent',
            description: 'Tests the real result tools',
            systemPrompt: 'system',
            tools: [],
        };

        const agent = new SubAgent(config);
        await agent.execute('do it', {
            provider: createToolCallProvider('write_result_object', {
                key: 'result',
                value: { found: true, path: 'Inbox/Foo.md' },
            }) as never,
            resultStore: store,
            onMessageUpdate: (_name, msg) => {
                updates.push({ ...msg, toolCallResult: msg.toolCallResult ? { ...msg.toolCallResult } : undefined });
            },
        });

        // The store must actually have received the write — sanity
        // check that we exercised the real tool, not a stub.
        expect(store.get('result')).toEqual({ found: true, path: 'Inbox/Foo.md' });

        const toolCallStates = updates.filter(
            m => m.role === 'tool_call' && m.toolCallMeta?.toolName === 'write_result_object',
        );
        expect(toolCallStates.length).toBeGreaterThanOrEqual(2);

        const last = toolCallStates[toolCallStates.length - 1]!;
        expect(last.streaming).toBe(false);
        expect(last.toolCallResult).toBeDefined();
        expect(last.toolCallResult!.status).toBe('success');
        // write_result_object returns `{ok:true, key:'result'}` serialised.
        expect(last.toolCallResult!.result).toMatch(/"ok":\s*true/);
        expect(last.toolCallResult!.result).toContain('"key"');
    });
});
