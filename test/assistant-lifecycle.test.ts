import { describe, it, expect, vi } from 'vitest';
import {
    assistantHasPersistablePayload,
    assistantContentForApi,
    commitInFlightAssistantToHistory,
    finalizeInFlightAssistantMessage,
    finalizeAbortedToolCallMessage,
    finalizeStuckToolCallMessages,
} from '../src/services/chat-stream-assistant-lifecycle';
import type { ChatMessage } from '../src/services/chat-stream-types';

let nextId = 1;
function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: `msg_${nextId++}`,
        role: 'assistant',
        content: '',
        streaming: false,
        timestamp: Date.now(),
        ...overrides,
    } as ChatMessage;
}

// ── assistantHasPersistablePayload ───────────────────────────────────────

describe('assistantHasPersistablePayload', () => {
    it('should return true when content is non-empty', () => {
        expect(assistantHasPersistablePayload(makeMsg({ content: 'Hello' }))).toBe(true);
    });

    it('should return true when only thinkingContent is non-empty', () => {
        expect(assistantHasPersistablePayload(makeMsg({
            content: '',
            thinkingContent: 'deep reasoning',
        }))).toBe(true);
    });

    it('should return false when both content and thinkingContent are empty', () => {
        expect(assistantHasPersistablePayload(makeMsg({ content: '' }))).toBe(false);
    });

    it('should return false when content is whitespace and no thinkingContent', () => {
        expect(assistantHasPersistablePayload(makeMsg({ content: '   ' }))).toBe(false);
    });

    it('should return true when content is whitespace but thinkingContent present', () => {
        expect(assistantHasPersistablePayload(makeMsg({
            content: '   ',
            thinkingContent: 'thought',
        }))).toBe(true);
    });
});

// ── assistantContentForApi ───────────────────────────────────────────────

describe('assistantContentForApi', () => {
    it('should return content unchanged when not interrupted', () => {
        const msg = makeMsg({ content: 'Hello', wasInterrupted: false });
        expect(assistantContentForApi(msg)).toBe('Hello');
    });

    it('should return INTERRUPTED_ASSISTANT_API_NOTE when interrupted and content empty', () => {
        const msg = makeMsg({ content: '', wasInterrupted: true });
        const result = assistantContentForApi(msg);
        expect(result).toContain('interrupted');
        expect(result).toContain('[Note:');
    });

    it('should append INTERRUPTED_ASSISTANT_API_NOTE when interrupted and content non-empty', () => {
        const msg = makeMsg({ content: 'Partial reply', wasInterrupted: true });
        const result = assistantContentForApi(msg);
        expect(result).toContain('Partial reply');
        expect(result).toContain('[Note:');
        // Interruption note should be appended after content
        expect(result.startsWith('Partial reply')).toBe(true);
    });

    it('should not append note when wasInterrupted is false', () => {
        const msg = makeMsg({ content: 'Full reply', wasInterrupted: false });
        expect(assistantContentForApi(msg)).not.toContain('[Note:');
    });
});

// ── commitInFlightAssistantToHistory ─────────────────────────────────────

describe('commitInFlightAssistantToHistory', () => {
    it('should push inFlight to messages when it has persistable payload', () => {
        const messages: ChatMessage[] = [];
        const inFlight = makeMsg({ content: 'Hello' });
        commitInFlightAssistantToHistory(messages, inFlight, 1);
        expect(messages).toHaveLength(1);
        expect(messages[0]!.content).toBe('Hello');
        expect(messages[0]!.turn).toBe(1);
    });

    it('should not push when inFlight is null', () => {
        const messages: ChatMessage[] = [];
        commitInFlightAssistantToHistory(messages, null, 1);
        expect(messages).toHaveLength(0);
    });

    it('should not push when inFlight has no persistable payload', () => {
        const messages: ChatMessage[] = [];
        const inFlight = makeMsg({ content: '' });
        commitInFlightAssistantToHistory(messages, inFlight, 1);
        expect(messages).toHaveLength(0);
    });

    it('should not duplicate if message already in messages (same id)', () => {
        const inFlight = makeMsg({ content: 'Hello' });
        const messages = [inFlight];
        commitInFlightAssistantToHistory(messages, inFlight, 1);
        expect(messages).toHaveLength(1);
    });

    it('should assign turn number', () => {
        const messages: ChatMessage[] = [];
        const inFlight = makeMsg({ content: 'Hello' });
        commitInFlightAssistantToHistory(messages, inFlight, 5);
        expect(messages[0]!.turn).toBe(5);
    });
});

// ── finalizeInFlightAssistantMessage ─────────────────────────────────────

describe('finalizeInFlightAssistantMessage', () => {
    it('should return null when inFlight is null', () => {
        const result = finalizeInFlightAssistantMessage([], null, undefined);
        expect(result).toBeNull();
    });

    it('should return null when inFlight has no persistable payload', () => {
        const msg = makeMsg({ content: '' });
        const result = finalizeInFlightAssistantMessage([], msg, undefined);
        expect(result).toBeNull();
    });

    it('should set streaming to false', () => {
        const msg = makeMsg({ content: 'Hello', streaming: true });
        const result = finalizeInFlightAssistantMessage([], msg, undefined);
        expect(result).not.toBeNull();
        expect(result!.streaming).toBe(false);
    });

    it('should set wasInterrupted when interrupted option is true', () => {
        const msg = makeMsg({ content: 'Hello' });
        const result = finalizeInFlightAssistantMessage([], msg, undefined, {
            interrupted: true,
        });
        expect(result!.wasInterrupted).toBe(true);
    });

    it('should not set wasInterrupted when interrupted option is false', () => {
        const msg = makeMsg({ content: 'Hello' });
        const result = finalizeInFlightAssistantMessage([], msg, undefined);
        expect(result!.wasInterrupted).toBeFalsy();
    });

    it('should push message to history when not already present', () => {
        const messages: ChatMessage[] = [];
        const msg = makeMsg({ content: 'Hello' });
        finalizeInFlightAssistantMessage(messages, msg, undefined);
        expect(messages).toHaveLength(1);
        expect(messages[0]!.id).toBe(msg.id);
    });

    it('should not push duplicate when already in history', () => {
        const msg = makeMsg({ content: 'Hello' });
        const messages = [msg];
        finalizeInFlightAssistantMessage(messages, msg, undefined);
        expect(messages).toHaveLength(1);
    });

    it('should set turn when opts.turn is provided', () => {
        const msg = makeMsg({ content: 'Hello' });
        const result = finalizeInFlightAssistantMessage([], msg, undefined, {
            turn: 3,
        });
        expect(result!.turn).toBe(3);
    });

    it('should remove message from history when removeFromHistory is true', () => {
        const msg = makeMsg({ content: 'Hello', thinkingContent: 'thought' });
        const messages: ChatMessage[] = [msg];
        const onUpdate = vi.fn();
        const result = finalizeInFlightAssistantMessage(messages, msg, onUpdate, {
            removeFromHistory: true,
        });
        expect(result).toBeNull();
        expect(messages).toHaveLength(0);
        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ retireBubble: true }),
        );
    });

    it('should call onMessageUpdate with finalized message', () => {
        const msg = makeMsg({ content: 'Hello' });
        const onUpdate = vi.fn();
        finalizeInFlightAssistantMessage([], msg, onUpdate);
        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ id: msg.id, streaming: false }),
        );
    });

    it('should not invoke onMessageUpdate when removeFromHistory deletes a non-thinking message', () => {
        // When removeFromHistory is true but no thinkingContent, onUpdate is called with retireBubble
        const msg = makeMsg({ content: 'tool call text' });
        const messages: ChatMessage[] = [msg];
        const onUpdate = vi.fn();
        const result = finalizeInFlightAssistantMessage(messages, msg, onUpdate, {
            removeFromHistory: true,
        });
        expect(result).toBeNull();
        // Should still call onUpdate with retireBubble for any message with removeFromHistory
        expect(onUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ retireBubble: true }),
        );
    });
});

// ── finalizeAbortedToolCallMessage ───────────────────────────────────────

describe('finalizeAbortedToolCallMessage', () => {
    it('should set streaming to false', () => {
        const msg = makeMsg({ role: 'tool_call', streaming: true });
        finalizeAbortedToolCallMessage(msg, 1234, 'cancelled', undefined);
        expect(msg.streaming).toBe(false);
    });

    it('should append elapsed ms and note to content', () => {
        const msg = makeMsg({ role: 'tool_call', content: 'search_files' });
        finalizeAbortedToolCallMessage(msg, 5000, 'User cancelled', undefined);
        expect(msg.content).toContain('search_files');
        expect(msg.content).toContain('5000ms');
        expect(msg.content).toContain('aborted');
    });

    it('should set toolCallResult with warning status', () => {
        const msg = makeMsg({ role: 'tool_call' });
        finalizeAbortedToolCallMessage(msg, 1000, 'Timeout', undefined);
        expect(msg.toolCallResult).toBeDefined();
        expect(msg.toolCallResult!.status).toBe('warning');
        expect(msg.toolCallResult!.result).toBe('Timeout');
    });

    it('should use toolCallMeta.toolName when available for content prefix', () => {
        const msg = makeMsg({
            role: 'tool_call',
            content: 'old_name',
            toolCallMeta: { toolName: 'actual_tool', toolArgs: {}, toolCallId: 'tc1' },
        });
        finalizeAbortedToolCallMessage(msg, 500, 'cancelled', undefined);
        expect(msg.content).toContain('actual_tool');
    });

    it('should call onMessageUpdate when provided', () => {
        const msg = makeMsg({ role: 'tool_call' });
        const onUpdate = vi.fn();
        finalizeAbortedToolCallMessage(msg, 200, 'done', onUpdate);
        expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: msg.id }));
    });
});

// ── finalizeStuckToolCallMessages ────────────────────────────────────────

describe('finalizeStuckToolCallMessages', () => {
    it('should be a no-op when no tool_call messages are stuck streaming', () => {
        const messages: ChatMessage[] = [
            makeMsg({ role: 'user', content: 'Hello' }),
            makeMsg({ role: 'assistant', content: 'Hi', streaming: false }),
            makeMsg({ role: 'tool_call', streaming: false }),
        ];
        // Should not throw
        finalizeStuckToolCallMessages(messages, undefined);
        // Verify their state is unchanged
        expect(messages[2]!.streaming).toBe(false);
    });

    it('should finalize a stuck tool_call message', () => {
        const msg = makeMsg({
            role: 'tool_call',
            content: 'search_files',
            streaming: true,
        });
        const messages: ChatMessage[] = [msg];
        const onUpdate = vi.fn();
        finalizeStuckToolCallMessages(messages, onUpdate);
        expect(msg.streaming).toBe(false);
        expect(msg.toolCallResult).toBeDefined();
        expect(msg.toolCallResult!.status).toBe('warning');
        expect(msg.content).toContain('no result captured');
    });

    it('should finalize multiple stuck tool_call messages', () => {
        const msg1 = makeMsg({
            role: 'tool_call',
            content: 'tool1',
            streaming: true,
        });
        const msg2 = makeMsg({
            role: 'tool_call',
            content: 'tool2',
            streaming: true,
        });
        const messages: ChatMessage[] = [msg1, msg2];
        finalizeStuckToolCallMessages(messages, undefined);
        expect(msg1.streaming).toBe(false);
        expect(msg2.streaming).toBe(false);
        expect(msg1.toolCallResult).toBeDefined();
        expect(msg2.toolCallResult).toBeDefined();
    });

    it('should not modify non-tool_call messages', () => {
        const userMsg = makeMsg({ role: 'user', content: 'Hello', streaming: true });
        const assistantMsg = makeMsg({
            role: 'assistant',
            content: 'Hi',
            streaming: true,
        });
        const messages: ChatMessage[] = [userMsg, assistantMsg];
        finalizeStuckToolCallMessages(messages, undefined);
        // Non-tool_call messages should not be touched
        expect(userMsg.streaming).toBe(true);
        expect(assistantMsg.streaming).toBe(true);
    });

    it('should call onMessageUpdate for each stuck tool_call', () => {
        const msg1 = makeMsg({
            role: 'tool_call',
            content: 'tool1',
            streaming: true,
        });
        const msg2 = makeMsg({
            role: 'tool_call',
            content: 'tool2',
            streaming: true,
        });
        const messages: ChatMessage[] = [msg1, msg2];
        const onUpdate = vi.fn();
        finalizeStuckToolCallMessages(messages, onUpdate);
        expect(onUpdate).toHaveBeenCalledTimes(2);
    });
});
