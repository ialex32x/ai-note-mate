import { describe, it, expect } from 'vitest';
import { computeClaimedMcpTools } from '../src/services/custom-agents/sub-agent-builder';
import type { CustomAgentConfig } from '../src/settings/types';
import type { RegisteredTool } from '../src/services/chat-stream-types';

function makeAgent(overrides: Partial<CustomAgentConfig> & { name: string; tools: string[] }): CustomAgentConfig {
    return {
        disabled: false,
        description: '',
        systemPrompt: '',
        profile: undefined,
        ...overrides,
    } as CustomAgentConfig;
}

function makeTool(name: string): RegisteredTool {
    return {
        schema: {
            function: {
                name,
                description: '',
                parameters: { type: 'object', properties: {} },
            },
        },
    } as RegisteredTool;
}

describe('computeClaimedMcpTools', () => {
    it('should return empty set when no agents exist', () => {
        const result = computeClaimedMcpTools([], [makeTool('search')]);
        expect(result.size).toBe(0);
    });

    it('should return empty set when no registered tools exist', () => {
        const agents = [makeAgent({ name: 'Agent1', tools: ['search'] })];
        const result = computeClaimedMcpTools(agents, []);
        expect(result.size).toBe(0);
    });

    it('should claim a tool matching exact name pattern', () => {
        const agents = [makeAgent({ name: 'Agent1', tools: ['search'] })];
        const tools = [makeTool('search')];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.has('search')).toBe(true);
        expect(result.size).toBe(1);
    });

    it('should claim a tool matching wildcard pattern', () => {
        const agents = [makeAgent({ name: 'Agent1', tools: ['vault_*'] })];
        const tools = [makeTool('vault_search'), makeTool('vault_read'), makeTool('web_search')];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.has('vault_search')).toBe(true);
        expect(result.has('vault_read')).toBe(true);
        expect(result.has('web_search')).toBe(false);
        expect(result.size).toBe(2);
    });

    it('should NOT claim tools when agent is disabled', () => {
        const agents = [
            makeAgent({ name: 'Agent1', tools: ['search'], disabled: true }),
        ];
        const tools = [makeTool('search')];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.size).toBe(0);
    });

    it('should NOT claim tools when agent has empty name', () => {
        const agents = [
            makeAgent({ name: '', tools: ['search'] }),
        ];
        const tools = [makeTool('search')];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.size).toBe(0);
    });

    it('should NOT claim tools when agent name is whitespace-only', () => {
        const agents = [
            makeAgent({ name: '   ', tools: ['search'] }),
        ];
        const tools = [makeTool('search')];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.size).toBe(0);
    });

    it('should NOT claim tools when agent has empty tool patterns', () => {
        const agents = [
            makeAgent({ name: 'Agent1', tools: [] }),
        ];
        const tools = [makeTool('search')];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.size).toBe(0);
    });

    it('should deduplicate when multiple agents claim the same tool', () => {
        const agents = [
            makeAgent({ name: 'Agent1', tools: ['search'] }),
            makeAgent({ name: 'Agent2', tools: ['search'] }),
        ];
        const tools = [makeTool('search')];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.size).toBe(1);
        expect(result.has('search')).toBe(true);
    });

    it('should handle multiple agents with different patterns', () => {
        const agents = [
            makeAgent({ name: 'Reader', tools: ['vault_*'] }),
            makeAgent({ name: 'Web', tools: ['web_*'] }),
        ];
        const tools = [
            makeTool('vault_search'),
            makeTool('web_search'),
            makeTool('rss_fetch'),
        ];
        const result = computeClaimedMcpTools(agents, tools);
        expect(result.has('vault_search')).toBe(true);
        expect(result.has('web_search')).toBe(true);
        expect(result.has('rss_fetch')).toBe(false);
        expect(result.size).toBe(2);
    });
});
