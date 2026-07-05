import { describe, it, expect } from 'vitest';
import {
    toolResultApiContent,
    backfillChatMessageBudgetHints,
    generateId,
    toMediaAttachment,
    inferKindFromMime,
    mediaKindLabel,
} from '../src/services/chat-stream-helpers';
import type { ToolCallResultInfo, ChatMessage, ChatMessageParam } from '../src/services/chat-stream-types';

// ── toolResultApiContent ─────────────────────────────────────────────────

describe('toolResultApiContent', () => {
    it('should return result as-is for success status', () => {
        const res: ToolCallResultInfo = { status: 'success', result: 'file content' };
        expect(toolResultApiContent(res)).toBe('file content');
    });

    it('should prefix with "Error:" for error status when missing', () => {
        const res: ToolCallResultInfo = { status: 'error', result: 'permission denied' };
        expect(toolResultApiContent(res)).toBe('Error: permission denied');
    });

    it('should NOT double-prefix when error result already starts with "Error:"', () => {
        const res: ToolCallResultInfo = { status: 'error', result: 'Error: permission denied' };
        expect(toolResultApiContent(res)).toBe('Error: permission denied');
    });

    it('should handle warning status without prefix', () => {
        const res: ToolCallResultInfo = { status: 'warning', result: 'partial data' };
        expect(toolResultApiContent(res)).toBe('partial data');
    });
});

// ── generateId ──────────────────────────────────────────────────────────

describe('generateId', () => {
    it('should return a non-empty string', () => {
        expect(generateId().length).toBeGreaterThan(0);
    });

    it('should contain a timestamp prefix and random suffix', () => {
        const id = generateId();
        const parts = id.split('-');
        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatch(/^\d+$/); // timestamp
        expect(parts[1]!.length).toBeGreaterThan(0); // random suffix
    });

    it('should produce unique IDs on successive calls', () => {
        const ids = new Set(Array.from({ length: 100 }, () => generateId()));
        expect(ids.size).toBe(100);
    });
});

// ── inferKindFromMime ───────────────────────────────────────────────────

describe('inferKindFromMime', () => {
    it('should return "audio" for audio/* MIME types', () => {
        expect(inferKindFromMime('audio/mpeg')).toBe('audio');
        expect(inferKindFromMime('audio/wav')).toBe('audio');
        expect(inferKindFromMime('AUDIO/MP4')).toBe('audio');
    });

    it('should return "video" for video/* MIME types', () => {
        expect(inferKindFromMime('video/mp4')).toBe('video');
        expect(inferKindFromMime('video/webm')).toBe('video');
    });

    it('should return "pdf" for application/pdf', () => {
        expect(inferKindFromMime('application/pdf')).toBe('pdf');
    });

    it('should return "image" for unknown MIME types', () => {
        expect(inferKindFromMime('application/octet-stream')).toBe('image');
        expect(inferKindFromMime('text/plain')).toBe('image');
    });

    it('should return "image" for image/* MIME types (unlisted but default)', () => {
        expect(inferKindFromMime('image/png')).toBe('image');
        expect(inferKindFromMime('image/jpeg')).toBe('image');
    });
});

// ── mediaKindLabel ──────────────────────────────────────────────────────

describe('mediaKindLabel', () => {
    it('should return correct labels for each kind', () => {
        expect(mediaKindLabel('image')).toBe('Image');
        expect(mediaKindLabel('audio')).toBe('Audio');
        expect(mediaKindLabel('video')).toBe('Video');
        expect(mediaKindLabel('pdf')).toBe('PDF');
    });
});

// ── toMediaAttachment ───────────────────────────────────────────────────

describe('toMediaAttachment', () => {
    it('should return null for non-object input', () => {
        expect(toMediaAttachment('string')).toBeNull();
        expect(toMediaAttachment(42)).toBeNull();
        expect(toMediaAttachment(null)).toBeNull();
        expect(toMediaAttachment(undefined)).toBeNull();
    });

    it('should return null when mimeType is missing', () => {
        expect(toMediaAttachment({ base64: 'abc' })).toBeNull();
    });

    it('should return null when base64 is missing', () => {
        expect(toMediaAttachment({ mimeType: 'image/png' })).toBeNull();
    });

    it('should parse valid media attachment with image inference', () => {
        const result = toMediaAttachment({
            mimeType: 'image/png',
            base64: 'iVBORw0KGgo=',
        });
        expect(result).not.toBeNull();
        expect(result!.kind).toBe('image');
        expect(result!.mimeType).toBe('image/png');
        expect(result!.base64).toBe('iVBORw0KGgo=');
        expect(result!.sourcePath).toBeUndefined();
    });

    it('should use explicit kind when provided', () => {
        const result = toMediaAttachment({
            kind: 'audio',
            mimeType: 'audio/wav',
            base64: 'AAAA',
        });
        expect(result!.kind).toBe('audio');
    });

    it('should include sourcePath when path is provided', () => {
        const result = toMediaAttachment({
            path: '/path/to/image.png',
            mimeType: 'image/png',
            base64: 'abc',
        });
        expect(result!.sourcePath).toBe('/path/to/image.png');
    });

    it('should infer kind from MIME type when kind is missing (audio)', () => {
        const result = toMediaAttachment({
            mimeType: 'audio/mp3',
            base64: 'AAAA',
        });
        expect(result!.kind).toBe('audio');
    });
});

// ── backfillChatMessageBudgetHints ──────────────────────────────────────

describe('backfillChatMessageBudgetHints', () => {
    function makeToolCall(id: string, resultLen: number): ChatMessage {
        return {
            role: 'tool_call',
            id: `msg-${id}`,
            content: `tool ${id}`,
            streaming: false,
            timestamp: 0,
            toolCallMeta: { toolCallId: id, toolName: id, toolArgs: {} },
            toolCallResult: { status: 'success', result: 'x'.repeat(resultLen) },
        } as ChatMessage;
    }

    function makeApiToolResult(id: string, hintLen: number, hint?: string): ChatMessageParam {
        return {
            role: 'tool_result',
            toolCallId: id,
            content: 'x'.repeat(hintLen),
            contentBudgetHint: hint ?? `hint:${id}`,
            contentBudgetHintForLength: hintLen,
        } as unknown as ChatMessageParam;
    }

    it('should backfill hints when toolCallId and length match', () => {
        const msgs = [makeToolCall('tc1', 100)];
        const apiResults = [makeApiToolResult('tc1', 100, 'compressed')];
        backfillChatMessageBudgetHints(msgs, apiResults);
        expect(msgs[0]!.contentBudgetHint).toBe('compressed');
        expect(msgs[0]!.contentBudgetHintForLength).toBe(100);
    });

    it('should NOT backfill when length does not match (stale hint)', () => {
        const msgs = [makeToolCall('tc1', 200)]; // result is 200 chars
        const apiResults = [makeApiToolResult('tc1', 100, 'compressed')]; // but hint says 100
        backfillChatMessageBudgetHints(msgs, apiResults);
        expect(msgs[0]!.contentBudgetHint).toBeUndefined();
    });

    it('should NOT backfill when no api results match', () => {
        const msgs = [makeToolCall('tc1', 100)];
        backfillChatMessageBudgetHints(msgs, []);
        expect(msgs[0]!.contentBudgetHint).toBeUndefined();
    });

    it('should NOT backfill when toolCallMeta is missing', () => {
        const msgs = [{ ...makeToolCall('tc1', 100), toolCallMeta: undefined }];
        const apiResults = [makeApiToolResult('tc1', 100)];
        backfillChatMessageBudgetHints(msgs, apiResults);
        expect(msgs[0]!.contentBudgetHint).toBeUndefined();
    });

    it('should skip api results that are not tool_result', () => {
        const msgs = [makeToolCall('tc1', 100)];
        const apiResults = [
            { role: 'user', content: 'hello' } as ChatMessageParam,
        ];
        backfillChatMessageBudgetHints(msgs, apiResults);
        expect(msgs[0]!.contentBudgetHint).toBeUndefined();
    });

    it('should handle multiple tool calls independently', () => {
        const msgs = [
            makeToolCall('tc1', 50),
            makeToolCall('tc2', 80),
        ];
        const apiResults = [
            makeApiToolResult('tc1', 50, 'hint1'),
            makeApiToolResult('tc2', 80, 'hint2'),
        ];
        backfillChatMessageBudgetHints(msgs, apiResults);
        expect(msgs[0]!.contentBudgetHint).toBe('hint1');
        expect(msgs[1]!.contentBudgetHint).toBe('hint2');
    });

    it('should be a no-op with empty message array', () => {
        expect(() => backfillChatMessageBudgetHints([], [])).not.toThrow();
    });
});
