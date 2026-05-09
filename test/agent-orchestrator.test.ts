import { describe, it, expect, vi } from 'vitest';
import { AgentOrchestrator } from '../src/services/agent-orchestrator';
import type { SubAgentConfig } from '../src/services/sub-agent';
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
