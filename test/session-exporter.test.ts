import { describe, it, expect } from 'vitest';
import { sessionToMarkdown } from '../src/services/session-exporter';
import type { ChatMessage } from '../src/services/chat-stream';

function msg(overrides: Partial<ChatMessage> & { role: string }): ChatMessage {
    return {
        id: 'msg',
        role: 'user',
        content: '',
        streaming: false,
        createdAt: 0,
        ...overrides,
    } as ChatMessage;
}

function userMsg(content: string, attachments?: { cachePath: string; fileName: string }[]): ChatMessage {
    return msg({ role: 'user', content, attachments } as any);
}

function assistantMsg(content: string, thinkingContent?: string): ChatMessage {
    return msg({ role: 'assistant', content, thinkingContent } as any);
}

describe('sessionToMarkdown', () => {
    it('should start with a session header', () => {
        const result = sessionToMarkdown([]);
        expect(result).toContain('# AI Session Export');
    });

    it('should format a user message', () => {
        const messages: ChatMessage[] = [userMsg('Hello')];
        const result = sessionToMarkdown(messages);
        expect(result).toContain('## User');
        expect(result).toContain('Hello');
    });

    it('should format an assistant message', () => {
        const messages: ChatMessage[] = [assistantMsg('Hi there')];
        const result = sessionToMarkdown(messages);
        expect(result).toContain('## Assistant');
        expect(result).toContain('Hi there');
    });

    it('should format user then assistant messages in order', () => {
        const messages: ChatMessage[] = [
            userMsg('What is AI?'),
            assistantMsg('AI stands for Artificial Intelligence.'),
        ];
        const result = sessionToMarkdown(messages);
        const userIdx = result.indexOf('## User');
        const assistantIdx = result.indexOf('## Assistant');
        expect(userIdx).toBeLessThan(assistantIdx);
        expect(result).toContain('What is AI?');
        expect(result).toContain('Artificial Intelligence');
    });

    it('should skip tool and system messages', () => {
        const messages: ChatMessage[] = [
            userMsg('Hello'),
            msg({ role: 'tool' as any, content: 'tool result' }),
            assistantMsg('Hi'),
            msg({ role: 'system' as any, content: 'system prompt' }),
        ];
        const result = sessionToMarkdown(messages);
        // Only one User and one Assistant heading should appear
        expect((result.match(/## User/g) || []).length).toBe(1);
        expect((result.match(/## Assistant/g) || []).length).toBe(1);
        expect(result).not.toContain('tool result');
        expect(result).not.toContain('system prompt');
    });

    it('should include thinking content in a collapsible block', () => {
        const messages: ChatMessage[] = [
            assistantMsg('Final answer', 'I reasoned step by step...'),
        ];
        const result = sessionToMarkdown(messages);
        expect(result).toContain('<details>');
        expect(result).toContain('<summary>Thinking</summary>');
        expect(result).toContain('I reasoned step by step...');
        expect(result).toContain('</details>');
        expect(result).toContain('Final answer');
    });

    it('should not emit empty details block when no thinking content', () => {
        const messages: ChatMessage[] = [assistantMsg('Simple answer')];
        const result = sessionToMarkdown(messages);
        expect(result).not.toContain('<details>');
        expect(result).not.toContain('Thinking');
    });

    it('should handle empty assistant content gracefully', () => {
        const messages: ChatMessage[] = [
            userMsg('Hello'),
            assistantMsg(''),
        ];
        const result = sessionToMarkdown(messages);
        expect(result).toContain('## Assistant');
        // No extra blank lines after the heading beyond the standard separator
    });

    it('should handle empty user content gracefully', () => {
        const messages: ChatMessage[] = [userMsg('')];
        const result = sessionToMarkdown(messages);
        expect(result).toContain('## User');
    });

    it('should include attachment image references when attachmentMap is provided', () => {
        const messages: ChatMessage[] = [
            userMsg('Check this image', [
                { cachePath: '.cache/img/photo.png', fileName: 'photo.png' },
            ]),
        ];
        const attachmentMap = new Map<string, string>();
        attachmentMap.set('.cache/img/photo.png', 'photo.png');
        const result = sessionToMarkdown(messages, attachmentMap);
        expect(result).toContain('![photo.png]');
        expect(result).toContain(encodeURI('photo.png'));
    });

    it('should skip attachments not present in attachmentMap', () => {
        const messages: ChatMessage[] = [
            userMsg('Check this', [
                { cachePath: '.cache/img/a.png', fileName: 'a.png' },
                { cachePath: '.cache/img/b.png', fileName: 'b.png' },
            ]),
        ];
        // Only map one of the two attachments
        const attachmentMap = new Map<string, string>();
        attachmentMap.set('.cache/img/a.png', 'a.png');
        const result = sessionToMarkdown(messages, attachmentMap);
        expect(result).toContain('![a.png]');
        expect(result).not.toContain('b.png');
    });

    it('should handle multiple user-assistant exchanges', () => {
        const messages: ChatMessage[] = [
            userMsg('First question'),
            assistantMsg('First answer'),
            userMsg('Second question'),
            assistantMsg('Second answer'),
        ];
        const result = sessionToMarkdown(messages);
        expect((result.match(/## User/g) || []).length).toBe(2);
        expect((result.match(/## Assistant/g) || []).length).toBe(2);
        expect(result.indexOf('First question')).toBeLessThan(result.indexOf('First answer'));
        expect(result.indexOf('Second question')).toBeLessThan(result.indexOf('Second answer'));
    });

    it('should not crash on messages with no role', () => {
        // Edge case: some synthetic messages may have unusual roles
        const messages: ChatMessage[] = [
            { id: 'x', role: undefined as any, content: 'unknown', streaming: false, createdAt: 0 } as ChatMessage,
        ];
        // Should not throw
        const result = sessionToMarkdown(messages);
        expect(result).toContain('# AI Session Export');
    });
});
