import { describe, it, expect, vi } from 'vitest';
import { SubAgent } from '../src/services/sub-agent';
import type { SubAgentConfig } from '../src/services/sub-agent';
import type { RegisteredTool, ToolCallResult } from '../src/services/chat-stream';

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

    it('should truncate large results when exceeding resultMaxTokens', async () => {
        const largeResponse = 'x'.repeat(50000); // Well above threshold to trigger truncation fallback
        const config: SubAgentConfig = {
            name: 'large-result-agent',
            description: 'Large result agent',
            systemPrompt: 'You are a large result agent.',
            tools: [],
            resultMaxTokens: 100, // Very low threshold to trigger summarization
        };

        const agent = new SubAgent(config);
        const result = await agent.execute('Generate large output', {
            provider: createMockProvider(largeResponse) as any,
        });

        // Summary should be shorter than full content
        expect(result.fullContent).toBe(largeResponse);
        expect(result.summary.length).toBeLessThan(result.fullContent.length);
        expect(result.summary).toContain('Result');
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
