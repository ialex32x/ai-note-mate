import { describe, it, expect } from 'vitest';
import {
    computeContextPercent,
    formatContextTooltip,
    formatContextDisplayValue,
    breakdownTotalTokens,
    formatBreakdownTokens,
    breakdownPercent,
    formatBreakdownPercent,
} from '../src/utils/context-usage';

// A minimal IChatAgent stub for testing
function makeChat(lastCallTotalTokens?: number) {
    return {
        sessionTokenUsage: {
            lastCallTotalTokens: lastCallTotalTokens ?? 0,
        },
    } as any;
}

function makeBreakdown(overrides?: Partial<{
    memory: number;
    skills: number;
    baseline: number;
    suffix: number;
    conversationUser: number;
    conversationAssistant: number;
    conversationTool: number;
    summaries: number;
    toolSchemas: number;
}>): any {
    return {
        systemPrompt: {
            memory: overrides?.memory ?? 0,
            skills: overrides?.skills ?? 0,
            baseline: overrides?.baseline ?? 0,
            suffix: overrides?.suffix ?? 0,
        },
        conversation: {
            user: overrides?.conversationUser ?? 0,
            assistant: overrides?.conversationAssistant ?? 0,
            tool: overrides?.conversationTool ?? 0,
        },
        summaries: overrides?.summaries ?? 0,
        toolSchemas: overrides?.toolSchemas ?? 0,
    };
}

describe('computeContextPercent', () => {
    it('should compute percentage from token usage and max tokens', () => {
        const chat = makeChat(50_000);
        expect(computeContextPercent(chat, 200_000)).toBe(25);
    });

    it('should return 0 when lastCallTotalTokens is 0', () => {
        const chat = makeChat(0);
        expect(computeContextPercent(chat, 200_000)).toBe(0);
    });

    it('should return 0 when lastCallTotalTokens is undefined', () => {
        const chat = makeChat(undefined);
        expect(computeContextPercent(chat, 200_000)).toBe(0);
    });

    it('should return 0 when maxTokens is 0', () => {
        const chat = makeChat(50_000);
        expect(computeContextPercent(chat, 0)).toBe(0);
    });

    it('should return 0 when maxTokens is negative', () => {
        const chat = makeChat(50_000);
        expect(computeContextPercent(chat, -1)).toBe(0);
    });

    it('should round to nearest integer', () => {
        const chat = makeChat(33_333);
        expect(computeContextPercent(chat, 100_000)).toBe(33);
    });

    it('should handle 100%', () => {
        const chat = makeChat(200_000);
        expect(computeContextPercent(chat, 200_000)).toBe(100);
    });
});

describe('formatContextTooltip', () => {
    it('should format as "X / Y (Z%)"', () => {
        const chat = makeChat(50_000);
        const result = formatContextTooltip(chat, 200_000);
        expect(result).toBe('50.0K / 200.0K (25%)');
    });

    it('should return empty string when maxTokens is <= 0', () => {
        const chat = makeChat(50_000);
        expect(formatContextTooltip(chat, 0)).toBe('');
        expect(formatContextTooltip(chat, -1)).toBe('');
    });

    it('should handle 0 tokens', () => {
        const chat = makeChat(0);
        expect(formatContextTooltip(chat, 200_000)).toBe('0 / 200.0K (0%)');
    });
});

describe('formatContextDisplayValue', () => {
    it('should delegate to formatContextTooltip', () => {
        const chat = makeChat(12_345);
        const expected = formatContextTooltip(chat, 100_000);
        expect(formatContextDisplayValue(chat, 100_000)).toBe(expected);
    });
});

describe('breakdownTotalTokens', () => {
    it('should sum all layers from a ContextBreakdown', () => {
        const bd = makeBreakdown({
            memory: 100,
            skills: 200,
            baseline: 300,
            suffix: 50,
            conversationUser: 400,
            conversationAssistant: 500,
            conversationTool: 600,
            summaries: 150,
            toolSchemas: 250,
        });
        expect(breakdownTotalTokens(bd)).toBe(100 + 200 + 300 + 50 + 400 + 500 + 600 + 150 + 250);
    });

    it('should return 0 for an empty breakdown', () => {
        const bd = makeBreakdown();
        expect(breakdownTotalTokens(bd)).toBe(0);
    });
});

describe('formatBreakdownTokens', () => {
    it('should format token count with compact notation', () => {
        expect(formatBreakdownTokens(1234)).toBe('1.2K');
    });

    it('should return em-dash for zero or negative', () => {
        expect(formatBreakdownTokens(0)).toBe('—');
        expect(formatBreakdownTokens(-1)).toBe('—');
    });

    it('should return plain number for small values', () => {
        expect(formatBreakdownTokens(42)).toBe('42');
    });
});

describe('breakdownPercent', () => {
    it('should compute percentage of part relative to total', () => {
        expect(breakdownPercent(250, 1000)).toBe(25);
    });

    it('should return 0 when total is 0', () => {
        expect(breakdownPercent(250, 0)).toBe(0);
    });

    it('should return 0 when part is 0', () => {
        expect(breakdownPercent(0, 1000)).toBe(0);
    });

    it('should return 0 when part is negative', () => {
        expect(breakdownPercent(-10, 1000)).toBe(0);
    });

    it('should handle 100%', () => {
        expect(breakdownPercent(1000, 1000)).toBe(100);
    });
});

describe('formatBreakdownPercent', () => {
    it('should format as "X%"', () => {
        expect(formatBreakdownPercent(25)).toBe('25%');
    });

    it('should handle zero', () => {
        expect(formatBreakdownPercent(0)).toBe('0%');
    });

    it('should return empty string for negative values', () => {
        expect(formatBreakdownPercent(-1)).toBe('');
    });
});
