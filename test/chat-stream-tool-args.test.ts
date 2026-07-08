import { describe, expect, it, vi } from 'vitest';
import { ChatStream } from '../src/services/chat-stream';
import type { LLMProvider } from '../src/services/llm-provider';
import type { RegisteredTool, ToolCallResult } from '../src/services/chat-stream';

function createToolCallProvider(argumentsDeltas: string[]): LLMProvider {
    let calls = 0;
    return {
        createStream: async function* () {
            const callIdx = calls++;
            if (callIdx === 0) {
                yield {
                    content: '',
                    reasoningContent: null,
                    toolCallDeltas: argumentsDeltas.map((args, index) => ({
                        index: 0,
                        id: index === 0 ? 'tc-args' : undefined,
                        function: {
                            name: index === 0 ? 'capture_args' : undefined,
                            arguments: args,
                        },
                    })),
                    finishReason: 'tool_calls',
                    usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6, cachedPromptTokens: 0 },
                };
                return;
            }
            yield {
                content: 'done',
                reasoningContent: null,
                toolCallDeltas: null,
                finishReason: 'stop',
                usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6, cachedPromptTokens: 0 },
            };
        },
        listModels: async () => ['mock-model'],
    } as LLMProvider;
}

function createCaptureArgsTool(exec: RegisteredTool['exec']): RegisteredTool {
    return {
        ondemand: false,
        schema: {
            type: 'function',
            function: {
                name: 'capture_args',
                description: 'Capture parsed arguments for tests',
                parameters: { type: 'object', properties: {} },
            },
        },
        exec,
    };
}

describe('ChatStream tool-call argument parsing', () => {
    it('recovers a valid object followed by a trailing empty-string literal', async () => {
        const exec = vi.fn(async (_chat, args): Promise<ToolCallResult> => ({
            success: true,
            type: 'object',
            content: { received: args },
        }));
        const chat = new ChatStream({});
        chat.registerTool(createCaptureArgsTool(exec));

        await chat.prompt('call with provider bug shape', {
            provider: createToolCallProvider(['{}', '""']),
        });

        expect(exec).toHaveBeenCalledTimes(1);
        expect(exec.mock.calls[0]![1]).toEqual({});
        const toolCall = chat.messages.find(m => m.role === 'tool_call');
        expect(toolCall?.toolCallResult?.status).toBe('success');
        expect(toolCall?.toolCallResult?.result).not.toContain('Failed to parse arguments');
    });

    it('does not recover malformed arguments with a non-empty trailing string literal', async () => {
        const exec = vi.fn(async (): Promise<ToolCallResult> => ({
            success: true,
            type: 'text',
            content: 'should not run',
        }));
        const chat = new ChatStream({});
        chat.registerTool(createCaptureArgsTool(exec));

        await chat.prompt('call with still-invalid args', {
            provider: createToolCallProvider(['{}', '"oops"']),
        });

        expect(exec).not.toHaveBeenCalled();
        const toolCall = chat.messages.find(m => m.role === 'tool_call');
        expect(toolCall?.toolCallResult?.status).toBe('error');
        expect(toolCall?.toolCallResult?.result).toContain('Failed to parse arguments for tool "capture_args": {}"oops"');
    });
});
