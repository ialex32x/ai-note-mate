import type { IChatAgent } from '../services/chat-stream';
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
 * X uses exact locale format, Y uses compact K/M,
 * e.g. `"12,345 / 128.0K (10%)"`.
 */
export function formatContextTooltip(
    chat: IChatAgent,
    maxTokens: number,
): string {
    const lastCallTotal = chat.sessionTokenUsage.lastCallTotalTokens ?? 0;
    if (maxTokens <= 0 || lastCallTotal <= 0) return '';
    const pct = Math.round((lastCallTotal / maxTokens) * 100);
    return `${lastCallTotal.toLocaleString()} / ${formatCompact(maxTokens)} (${pct}%)`;
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
