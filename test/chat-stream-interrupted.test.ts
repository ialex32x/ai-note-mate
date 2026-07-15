import { describe, it, expect, vi } from 'vitest';
import { ChatStream } from '../src/services/chat-stream';
import type { LLMProvider } from '../src/services/llm-provider';
import type { ChatMessageParam } from '../src/services/llm-provider';

const INTERRUPTED_NOTE =
    '[Note: this assistant reply was interrupted before completion.]';

function createFailAfterPartialProvider(partial: string): LLMProvider {
    return {
        createStream: async function* () {
            yield {
                content: partial,
                reasoningContent: null,
                toolCallDeltas: null,
                finishReason: null,
                usage: null,
            };
            throw new Error('stream failed mid-flight');
        },
        listModels: async () => ['mock-model'],
    } as LLMProvider;
}

function createSuccessProvider(response: string = 'follow-up ok'): LLMProvider {
    return {
        createStream: async function* () {
            yield {
                content: response,
                reasoningContent: null,
                toolCallDeltas: null,
                finishReason: 'stop',
                usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
            };
        },
        listModels: async () => ['mock-model'],
    } as LLMProvider;
}

describe('ChatStream interrupted assistant persistence', () => {
    it('commits partial assistant text to history when the stream errors', async () => {
        const onError = vi.fn();
        const chat = new ChatStream({ onError });

        await chat.prompt('hello', {
            provider: createFailAfterPartialProvider('Partial reply'),
        });

        expect(chat.state).toBe('error');
        expect(onError).toHaveBeenCalledTimes(1);

        const assistants = chat.messages.filter(m => m.role === 'assistant');
        expect(assistants).toHaveLength(1);
        expect(assistants[0]!.content).toBe('Partial reply');
        expect(assistants[0]!.streaming).toBe(false);
        expect(assistants[0]!.wasInterrupted).toBe(true);
    });

    it('commits partial assistant text when the user aborts mid-stream', async () => {
        const onAbort = vi.fn();
        const chat = new ChatStream({ onAbort });

        const provider: LLMProvider = {
            createStream: async function* (_messages, _tools, signal) {
                yield {
                    content: 'Streaming ',
                    reasoningContent: null,
                    toolCallDeltas: null,
                    finishReason: null,
                    usage: null,
                };
                await new Promise<void>((resolve, reject) => {
                    const onAbortSignal = () => {
                        reject(new DOMException('Aborted', 'AbortError'));
                    };
                    if (signal?.aborted) {
                        onAbortSignal();
                        return;
                    }
                    signal?.addEventListener('abort', onAbortSignal, { once: true });
                    setTimeout(resolve, 500);
                });
            },
            listModels: async () => ['mock-model'],
        } as LLMProvider;

        const turn = chat.prompt('hello', { provider });
        await new Promise(r => setTimeout(r, 20));
        chat.abort();
        await turn;

        expect(chat.state).toBe('aborted');
        expect(onAbort).toHaveBeenCalledTimes(1);

        const assistants = chat.messages.filter(m => m.role === 'assistant');
        expect(assistants).toHaveLength(1);
        expect(assistants[0]!.content).toBe('Streaming ');
        expect(assistants[0]!.wasInterrupted).toBe(true);
    });

    it('routes abort through the epilogue when the user stops during the first-round pre-flight build', async () => {
        // Regression: a new session's first turn is aborted while the
        // abort-aware pre-flight work (memory / skill embedding retrieval
        // inside _buildEffectiveSystemPrompt) is still running, before the
        // provider stream starts. The AbortError must NOT escape prompt();
        // it has to flow through the normal abort epilogue so the persist
        // hooks fire — otherwise the brand-new session is never written and
        // vanishes on reload.
        const onAbort = vi.fn();
        let createStreamCalled = false;

        const chat = new ChatStream({
            onAbort,
            // Simulate blocking, abort-aware retrieval that rejects with
            // AbortError the instant the user stops.
            systemPromptPrefix: (_input, signal) =>
                new Promise<string>((_resolve, reject) => {
                    const onAbortSignal = () =>
                        reject(new DOMException('Aborted', 'AbortError'));
                    if (signal?.aborted) {
                        onAbortSignal();
                        return;
                    }
                    signal?.addEventListener('abort', onAbortSignal, { once: true });
                }),
        });

        const provider: LLMProvider = {
            createStream: async function* () {
                createStreamCalled = true;
                yield {
                    content: 'should never stream',
                    reasoningContent: null,
                    toolCallDeltas: null,
                    finishReason: 'stop',
                    usage: null,
                };
            },
            listModels: async () => ['mock-model'],
        } as LLMProvider;

        const turn = chat.prompt('hello', { provider });
        await new Promise(r => setTimeout(r, 20));
        chat.abort();
        // Before the fix, this would reject with AbortError; after the fix
        // the epilogue swallows it and resolves normally.
        await turn;

        expect(chat.state).toBe('aborted');
        expect(onAbort).toHaveBeenCalledTimes(1);
        expect(createStreamCalled).toBe(false);

        // The user's first message survives so the session is persistable.
        const users = chat.messages.filter(m => m.role === 'user');
        expect(users).toHaveLength(1);
        expect(users[0]!.content).toBe('hello');

        // The turn is recorded as aborted in history (display-only).
        const aborted = chat.messages.filter(
            m => m.role === 'system' && m.content === 'aborted',
        );
        expect(aborted).toHaveLength(1);
    });

    it('includes the interrupted API note on the next prompt', async () => {
        const chat = new ChatStream({});
        let capturedMessages: ChatMessageParam[] | undefined;

        await chat.prompt('first', {
            provider: createFailAfterPartialProvider('Partial reply'),
        });

        await chat.prompt('second', {
            provider: {
                createStream: vi.fn(async function* (messages: ChatMessageParam[]) {
                    capturedMessages = messages;
                    yield {
                        content: 'follow-up ok',
                        reasoningContent: null,
                        toolCallDeltas: null,
                        finishReason: 'stop',
                        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8, cachedPromptTokens: 0 },
                    };
                }),
                listModels: async () => ['mock-model'],
            } as LLMProvider,
        });

        expect(capturedMessages).toBeDefined();
        const assistant = capturedMessages!.find(m => m.role === 'assistant');
        expect(assistant?.content).toContain('Partial reply');
        expect(assistant?.content).toContain(INTERRUPTED_NOTE);
    });

    it('reuses the streaming message id on successful completion', async () => {
        const updates: Array<{ id: string; streaming: boolean }> = [];
        const chat = new ChatStream({
            onMessageUpdate: (msg) => {
                updates.push({ id: msg.id, streaming: msg.streaming });
            },
        });

        await chat.prompt('hello', {
            provider: createSuccessProvider('Done'),
        });

        const assistants = chat.messages.filter(m => m.role === 'assistant');
        expect(assistants).toHaveLength(1);
        expect(assistants[0]!.content).toBe('Done');
        expect(assistants[0]!.wasInterrupted).toBeUndefined();

        const streamIds = updates.map(u => u.id);
        expect(streamIds.every(id => id === assistants[0]!.id)).toBe(true);
        expect(updates.at(-1)?.streaming).toBe(false);
    });
});
