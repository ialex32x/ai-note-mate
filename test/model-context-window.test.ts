import { describe, it, expect } from 'vitest';
import {
    inferModelContextWindow,
    SAFE_FALLBACK_TOKENS,
} from '../src/services/model-context-window';

describe('inferModelContextWindow', () => {
    describe('fallback', () => {
        it('returns the safe fallback for empty / whitespace / unknown strings', () => {
            expect(inferModelContextWindow('')).toBe(SAFE_FALLBACK_TOKENS);
            expect(inferModelContextWindow('   ')).toBe(SAFE_FALLBACK_TOKENS);
            expect(inferModelContextWindow('totally-unknown-model-xyz')).toBe(SAFE_FALLBACK_TOKENS);
        });

        it('returns the safe fallback for non-string inputs', () => {
            // Caller might forward a settings value that isn't a string.
            // The function must not throw.
            expect(inferModelContextWindow(undefined as unknown as string)).toBe(SAFE_FALLBACK_TOKENS);
            expect(inferModelContextWindow(null as unknown as string)).toBe(SAFE_FALLBACK_TOKENS);
            expect(inferModelContextWindow(123 as unknown as string)).toBe(SAFE_FALLBACK_TOKENS);
        });

        it('returns a safely SMALL fallback (≤32k)', () => {
            // Locks in the "err small" invariant: an over-estimate would
            // delay emergency shrink and risk 400s for unknown models.
            expect(SAFE_FALLBACK_TOKENS).toBeLessThanOrEqual(32_000);
            expect(SAFE_FALLBACK_TOKENS).toBeGreaterThan(0);
        });
    });

    describe('OpenAI family', () => {
        it.each([
            ['gpt-4.1', 1_000_000],
            ['gpt-4.1-mini', 1_000_000],
            ['gpt-4.1-2025-04-14', 1_000_000],
            ['gpt-4o', 128_000],
            ['gpt-4o-mini', 128_000],
            ['gpt-4o-2024-08-06', 128_000],
            ['gpt-4-turbo', 128_000],
            ['gpt-4-turbo-preview', 128_000],
            ['gpt-4-32k', 32_000],
            ['gpt-4', 8_000],
            ['gpt-4-0613', 8_000],
            ['gpt-3.5-turbo', 16_000],
            ['gpt-3.5-turbo-16k', 16_000],
            ['o1', 200_000],
            ['o1-mini', 128_000],
            ['o3', 200_000],
            ['o3-mini', 200_000],
            ['o4', 200_000],
            // GPT-5 family (2026).
            ['gpt-5.4-mini', 400_000],
            ['gpt-5.5', 1_000_000],
            ['gpt-5.4', 1_000_000],
            ['gpt-5.4-2026-01-01', 1_000_000],
        ])('%s → %i', (model, expected) => {
            expect(inferModelContextWindow(model)).toBe(expected);
        });
    });

    describe('Anthropic Claude family', () => {
        it.each([
            // Claude 5.x — Fable, Mythos, Sonnet — 1M.
            ['claude-fable-5', 1_000_000],
            ['claude-fable-5-20260609', 1_000_000],
            ['claude-mythos-5', 1_000_000],
            ['claude-sonnet-5', 1_000_000],
            ['claude-sonnet-5-20260609', 1_000_000],
            // Claude Opus 4.8 — 1M (upgraded from generic 4.x).
            ['claude-opus-4-8', 1_000_000],
            ['claude-opus-4-8-20260101', 1_000_000],
            // Claude Haiku 4.5 — 200k.
            ['claude-haiku-4-5', 200_000],
            // Generic Claude 4.x — 200k.
            ['claude-opus-4-5', 200_000],
            ['claude-sonnet-4-5-20250929', 200_000],
            ['claude-haiku-4', 200_000],
            // Older "3.5" style.
            ['claude-3-5-sonnet-20241022', 200_000],
            ['claude-3-opus-20240229', 200_000],
            ['claude-3-haiku', 200_000],
            // Cursor-style mixed names should still hit the family.
            ['claude-4.6-sonnet-medium-thinking', 200_000],
            // Legacy.
            ['claude-2.1', 200_000],
            ['claude-2', 100_000],
        ])('%s → %i', (model, expected) => {
            expect(inferModelContextWindow(model)).toBe(expected);
        });
    });

    describe('Google Gemini family', () => {
        it.each([
            ['gemini-1.5-pro', 1_000_000],
            ['gemini-1.5-flash', 1_000_000],
            ['gemini-2.0-flash', 1_000_000],
            ['gemini-2.5-pro', 1_000_000],
            ['gemini-3-pro-image-preview', 1_000_000],
            // Legacy.
            ['gemini-pro', 32_000],
        ])('%s → %i', (model, expected) => {
            expect(inferModelContextWindow(model)).toBe(expected);
        });
    });

    describe('DeepSeek family', () => {
        it.each([
            // Legacy / aliased names — kept at 128k. `deepseek-chat`
            // and `deepseek-reasoner` route to v4-flash during the
            // 2026-04 → 2026-07-24 deprecation window, but we still
            // estimate conservatively because the alias contract
            // expires and the explicit `deepseek-v4-*` rule below is
            // the canonical post-migration path.
            ['deepseek-chat', 128_000],
            ['deepseek-reasoner', 128_000],
            ['deepseek-v3', 128_000],
            ['deepseek-v3.2', 128_000],
            // V4 family (2026-04) — 1M context. The rule must take
            // priority over the generic `^deepseek` fallback.
            ['deepseek-v4-pro', 1_000_000],
            ['deepseek-v4-flash', 1_000_000],
            ['deepseek-v4-flash-thinking', 1_000_000],
        ])('%s → %i', (model, expected) => {
            expect(inferModelContextWindow(model)).toBe(expected);
        });
    });

    describe('other CN families', () => {
        it.each([
            // Qwen.
            ['qwen3-coder', 128_000],
            ['qwen3.7-max', 128_000],
            ['qwen3.7-plus', 128_000],
            ['qwen3.6-flash', 1_000_000],
            ['qwen2.5-72b-instruct', 128_000],
            ['qwen-turbo', 1_000_000],
            ['qwen-plus', 128_000],
            ['qwen-max', 32_000],
            // Moonshot / Kimi.
            ['moonshot-v1-128k', 128_000],
            ['moonshot-v1-32k', 32_000],
            ['moonshot-v1-8k', 8_000],
            // Kimi K2.x (2026) — 256k.
            ['kimi-k2.7-code', 256_000],
            ['kimi-k2.7-code-highspeed', 256_000],
            ['kimi-k2.6', 256_000],
            ['kimi-k2.5', 256_000],
            // Retired K2 previews — still route via kimi-?k2 → 256k.
            ['kimi-k2-0905-preview', 256_000],
            // Zhipu GLM.
            ['glm-4-plus', 128_000],
            ['glm-4-long', 1_000_000],
            ['glm-4.5', 128_000],
            // GLM-5.2 — 1M (latest flagship, 2026).
            ['glm-5.2', 1_000_000],
        ])('%s → %i', (model, expected) => {
            expect(inferModelContextWindow(model)).toBe(expected);
        });
    });

    describe('case-insensitivity', () => {
        it('handles upper / mixed case identifiers', () => {
            expect(inferModelContextWindow('GPT-4o')).toBe(128_000);
            expect(inferModelContextWindow('GPT-5.4-MINI')).toBe(400_000);
            expect(inferModelContextWindow('Claude-Fable-5')).toBe(1_000_000);
            expect(inferModelContextWindow('Claude-Opus-4-5')).toBe(200_000);
            expect(inferModelContextWindow('DeepSeek-Chat')).toBe(128_000);
            expect(inferModelContextWindow('GLM-5.2')).toBe(1_000_000);
            expect(inferModelContextWindow('Kimi-K2.6')).toBe(256_000);
            expect(inferModelContextWindow('QWEN3.6-FLASH')).toBe(1_000_000);
        });

        it('trims surrounding whitespace', () => {
            expect(inferModelContextWindow('  gpt-4o  ')).toBe(128_000);
        });
    });

    describe('priority / ordering', () => {
        it('matches more specific GPT-3.5 over generic GPT-3', () => {
            // No `^gpt-3` rule exists, so anything starting with gpt-3
            // that isn't 3.5 falls back. This locks that intent in.
            expect(inferModelContextWindow('gpt-3.5-turbo-1106')).toBe(16_000);
        });

        it('matches o1-mini before generic o1', () => {
            expect(inferModelContextWindow('o1-mini')).toBe(128_000);
            expect(inferModelContextWindow('o1')).toBe(200_000);
        });

        it('matches gpt-5.4-mini (400k) before generic gpt-5 (1M)', () => {
            expect(inferModelContextWindow('gpt-5.4-mini')).toBe(400_000);
            expect(inferModelContextWindow('gpt-5.4')).toBe(1_000_000);
            expect(inferModelContextWindow('gpt-5')).toBe(1_000_000);
        });

        it('matches specific Claude version overrides before generic 4.x', () => {
            // Opus 4.8 overrides the generic 4.x 200k with 1M.
            expect(inferModelContextWindow('claude-opus-4-8')).toBe(1_000_000);
            // Generic 4.x still returns 200k.
            expect(inferModelContextWindow('claude-opus-4-5')).toBe(200_000);
            // Claude 5.x before generic 4.x.
            expect(inferModelContextWindow('claude-fable-5')).toBe(1_000_000);
            expect(inferModelContextWindow('claude-mythos-5')).toBe(1_000_000);
            expect(inferModelContextWindow('claude-sonnet-5')).toBe(1_000_000);
        });

        it('matches moonshot-v1-128k before generic moonshot', () => {
            expect(inferModelContextWindow('moonshot-v1-128k')).toBe(128_000);
            expect(inferModelContextWindow('moonshot-v1-8k')).toBe(8_000);
        });

        it('matches specific kimi-k2.6 before generic kimi-k2 and kimi', () => {
            expect(inferModelContextWindow('kimi-k2.6')).toBe(256_000);
            expect(inferModelContextWindow('kimi-k2.5')).toBe(256_000);
            expect(inferModelContextWindow('kimi-k2-0905-preview')).toBe(256_000);
            // Generic kimi (non-K2) still defaults to 128k.
            expect(inferModelContextWindow('kimi-latest')).toBe(128_000);
        });

        it('matches qwen3.6-flash (1M) before generic qwen3 (128k)', () => {
            expect(inferModelContextWindow('qwen3.6-flash')).toBe(1_000_000);
            expect(inferModelContextWindow('qwen3.7-max')).toBe(128_000);
            expect(inferModelContextWindow('qwen3-coder')).toBe(128_000);
        });
    });
});
