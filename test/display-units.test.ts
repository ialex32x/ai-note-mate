import { describe, it, expect } from 'vitest';
import { buildDisplayUnits, findDisplayUnitIndex } from '../src/views/session-view/display-units';
import type { ChatMessage } from '../src/services/chat-stream';

describe('buildDisplayUnits', () => {
    it('expands delegate_task children after the parent tool_call', () => {
        const messages: ChatMessage[] = [
            { id: 'u1', role: 'user', content: 'hi', streaming: false, timestamp: 1 },
            {
                id: 'tc1',
                role: 'tool_call',
                content: 'delegate_task',
                streaming: false,
                timestamp: 2,
                toolCallMeta: {
                    toolCallId: 'call_parent',
                    toolName: 'delegate_task',
                    toolArgs: { agent: 'vault_inspector' },
                },
            },
        ];
        const units = buildDisplayUnits(messages, {
            getSubAgentMessages: (id) => id === 'call_parent'
                ? [{ id: 'sa1', role: 'assistant', content: 'done', streaming: false, timestamp: 3 }]
                : [],
        });
        expect(units).toHaveLength(3);
        expect(units[1].msg.id).toBe('tc1');
        expect(units[2].msg.id).toBe('sa1');
        expect(units[2].msg.subAgent?.agentName).toBe('vault_inspector');
    });

    it('findDisplayUnitIndex locates by message id', () => {
        const units = buildDisplayUnits([
            { id: 'a', role: 'user', content: 'x', streaming: false, timestamp: 1 },
            { id: 'b', role: 'assistant', content: 'y', streaming: false, timestamp: 2 },
        ]);
        expect(findDisplayUnitIndex(units, 'b')).toBe(1);
        expect(findDisplayUnitIndex(units, 'missing')).toBe(-1);
    });
});
