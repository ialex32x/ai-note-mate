import type { IChatAgent, ContextBreakdown } from '../services/chat-stream';
import { formatCompact } from './format';

/**
 * Compute the single-turn context-window usage percentage based on the
 * most recent API call's total tokens and the model's context window.
 *
 * Returns a value in 0–100 (integer), or 0 when either parameter is
 * unavailable or zero.
 */
export function computeContextPercent(
    chat: IChatAgent,
    maxTokens: number,
): number {
    const lastCallTotal = chat.sessionTokenUsage.lastCallTotalTokens ?? 0;
    if (maxTokens <= 0 || lastCallTotal <= 0) return 0;
    return Math.round((lastCallTotal / maxTokens) * 100);
}

/**
 * Build a tooltip/display string showing the context breakdown.
 * Both X and Y use compact K/M format,
 * e.g. `"12.3K / 128.0K (10%)"`.
 */
export function formatContextTooltip(
    chat: IChatAgent,
    maxTokens: number,
): string {
    const lastCallTotal = chat.sessionTokenUsage.lastCallTotalTokens ?? 0;
    if (maxTokens <= 0) return '';
    const pct = Math.round((lastCallTotal / maxTokens) * 100);
    return `${formatCompact(lastCallTotal)} / ${formatCompact(maxTokens)} (${pct}%)`;
}

/**
 * Build the display value for the Context row in the panel.
 * Same format as {@link formatContextTooltip}.
 */
export function formatContextDisplayValue(
    chat: IChatAgent,
    maxTokens: number,
): string {
    return formatContextTooltip(chat, maxTokens);
}

/**
 * Compute the total estimated tokens from a {@link ContextBreakdown}.
 * Sums all layers: system prompt (memory + skills + baseline + suffix),
 * conversation (user + assistant + tool), summaries, and tool schemas.
 */
export function breakdownTotalTokens(bd: ContextBreakdown): number {
    return (
        bd.systemPrompt.memory +
        bd.systemPrompt.skills +
        bd.systemPrompt.baseline +
        bd.systemPrompt.suffix +
        bd.conversation.user +
        bd.conversation.assistant +
        bd.conversation.tool +
        bd.summaries +
        bd.toolSchemas
    );
}

/**
 * Format a token count compactly (e.g. 1234 → "1,234").
 */
export function formatBreakdownTokens(tokens: number): string {
    if (tokens <= 0) return '—';
    return formatCompact(tokens);
}

/**
 * Compute the percentage of one category relative to the breakdown total.
 */
export function breakdownPercent(part: number, total: number): number {
    if (total <= 0 || part <= 0) return 0;
    return Math.round((part / total) * 100);
}

/**
 * Format a percentage as a compact string, e.g. "12%".
 */
export function formatBreakdownPercent(pct: number): string {
    if (pct < 0) return '';
    return `${pct}%`;
}
