import { describe, it, expect } from 'vitest';
import { findTailTurn } from '../src/services/turn-utils';
import type { ChatMessage } from '../src/services/chat-stream';

function msg(overrides: Partial<ChatMessage>): ChatMessage {
    return {
        id: 'msg-1',
        role: 'user',
        content: '',
        streaming: false,
        createdAt: 0,
        ...overrides,
    } as ChatMessage;
}

describe('findTailTurn', () => {
    it('should return the last completed Q&A pair', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: 'Hello' }),
            msg({ id: 'a1', role: 'assistant', content: 'Hi there', streaming: false }),
            msg({ id: 'u2', role: 'user', content: 'How are you?' }),
            msg({ id: 'a2', role: 'assistant', content: 'I am fine', streaming: false }),
        ];
        const { user, assistant } = findTailTurn(messages);
        expect(user?.id).toBe('u2');
        expect(assistant?.id).toBe('a2');
    });

    it('should skip streaming (in-flight) assistant messages', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: 'Hello' }),
            msg({ id: 'a1', role: 'assistant', content: 'Hi', streaming: false }),
            msg({ id: 'u2', role: 'user', content: 'Tell me more' }),
            msg({ id: 'a2', role: 'assistant', content: 'Well...', streaming: true }),
        ];
        const { user, assistant } = findTailTurn(messages);
        // Should fall back to the last completed turn
        expect(user?.id).toBe('u1');
        expect(assistant?.id).toBe('a1');
    });

    it('should skip assistant messages with empty content', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: 'Hello' }),
            msg({ id: 'a1', role: 'assistant', content: 'Hi', streaming: false }),
            msg({ id: 'u2', role: 'user', content: 'What is this?' }),
            msg({ id: 'a2', role: 'assistant', content: '', streaming: false }),
        ];
        const { user, assistant } = findTailTurn(messages);
        expect(user?.id).toBe('u1');
        expect(assistant?.id).toBe('a1');
    });

    it('should skip user messages with empty content when scanning backward', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: 'Hello' }),
            msg({ id: 'a1', role: 'assistant', content: 'Hi', streaming: false }),
            msg({ id: 'u2', role: 'user', content: '' }),
            msg({ id: 'a2', role: 'assistant', content: 'Reply to empty', streaming: false }),
        ];
        const { user, assistant } = findTailTurn(messages);
        // a2 is the last valid assistant; scanning backward from there,
        // u2 has empty content so it's skipped, landing on u1
        expect(user?.id).toBe('u1');
        expect(assistant?.id).toBe('a2');
    });

    it('should skip tool call / tool result / system messages when scanning', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: 'Create a file' }),
            msg({ id: 'a1', role: 'assistant', content: 'Sure, calling tool...', streaming: false }),
            msg({ id: 't1', role: 'assistant', content: '', streaming: false }),
            msg({ id: 'tr1', role: 'tool', content: 'File created', streaming: false }),
            msg({ id: 'u2', role: 'user', content: 'Now do another' }),
            msg({ id: 'a2', role: 'assistant', content: 'Calling another tool...', streaming: false }),
            msg({ id: 't2', role: 'assistant', content: '', streaming: false }),
            msg({ id: 'tr2', role: 'tool', content: 'Done', streaming: false }),
        ];
        const { user, assistant } = findTailTurn(messages);
        // Should skip past tool messages to find the real user message
        expect(user?.id).toBe('u2');
        expect(assistant?.id).toBe('a2');
    });

    it('should return undefined for both when no completed turn exists', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: 'Hello' }),
        ];
        const { user, assistant } = findTailTurn(messages);
        expect(user).toBeUndefined();
        expect(assistant).toBeUndefined();
    });

    it('should return only assistant when user message has empty content', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: '' }),
            msg({ id: 'a1', role: 'assistant', content: 'Hi', streaming: false }),
        ];
        const { user, assistant } = findTailTurn(messages);
        expect(user).toBeUndefined();
        expect(assistant?.id).toBe('a1');
    });

    it('should be undefined for empty message list', () => {
        const { user, assistant } = findTailTurn([]);
        expect(user).toBeUndefined();
        expect(assistant).toBeUndefined();
    });

    it('should keep aborted assistants as valid anchors', () => {
        const messages: ChatMessage[] = [
            msg({ id: 'u1', role: 'user', content: 'Hello' }),
            msg({ id: 'a1', role: 'assistant', content: 'Partial reply', streaming: false }),
        ];
        const { user, assistant } = findTailTurn(messages);
        expect(user?.id).toBe('u1');
        expect(assistant?.id).toBe('a1');
    });
});
