/**
 * LLM-based follow-up suggestion extraction.
 *
 * Used as a fallback when deterministic extraction (structured block +
 * heuristic parsing) produces no results. Makes one stateless LLM call
 * that generates 2–4 natural next-action suggestions from the last
 * user→assistant turn.
 *
 * Architecture: this is a pure async function — no runtime state, no
 * persistence. The caller (SessionView) owns the lifecycle (abort on
 * new turn / dispose) and decides when to render the result.
 */

import type { MinimalModelConfig } from '../llm-provider';
import { createChatCompletion } from '../context-compression';
import { stripStructuredBlock } from './extractor';
import { stripMarkdownToPlainText } from '../../utils/markdown-sanitizer';
import type { SuggestedAction } from './types';
import { isAbortError } from 'utils/abortable-request';

const DEFAULT_LIMIT = 4;
const DEFAULT_LABEL_MAX = 40;
const MAX_INPUT_CHARS = 6000;

/**
 * System prompt for the suggestion-generation LLM call.
 *
 * We ask for JSON so parsing is deterministic. A fenced code block is
 * tolerated but not required.
 */
export const SUGGESTION_EXTRACTION_SYSTEM_PROMPT = `\
You generate natural follow-up suggestions for a user who just received an AI assistant's reply inside a personal notes app (Obsidian). Given the user's latest question and the assistant's reply, suggest 2–4 concise next actions the user might want to take.

Return ONLY a JSON array — no prose, no explanations, no trailing text
(optionally wrapped in a \`\`\`json code fence):

[
  {"label": "short action text (≤ 40 chars)", "prompt": "complete instruction to send as the user"},
  ...
]

Rules:
- "label" is a concise ACTION phrase (imperative or noun phrase), ≤ 40 chars. Never a question — do NOT end with "?" / "？".
- "prompt" is a complete, standalone first-person instruction the user could reasonably send as their next message.
- Use the SAME LANGUAGE as the user's message for both fields.
- Each entry is ONE option only. Never bundle multiple options with "or" / "或者" / "または" / "아니면".
- Suggestions should be natural extensions of the conversation: elaborate on a sub-topic, verify or test a result, apply the answer to a related file/context, compare with alternatives, ask for a worked example, check edge-cases, etc.
- Do NOT suggest actions that merely echo or restate what was already done in the reply.
- If genuinely no meaningful follow-up exists (e.g. purely conversational exchange like greetings), return an empty array "[]".
- At most 4 entries, ordered by usefulness.
`;

/** Build the user-role message fed to the suggestion extractor LLM. */
function buildSuggestionUserPrompt(userMessage: string, assistantMessage: string): string {
    return [
        'USER MESSAGE:',
        '"""',
        userMessage.trim(),
        '"""',
        '',
        'ASSISTANT REPLY:',
        '"""',
        assistantMessage.trim(),
        '"""',
        '',
        'Generate 2-4 follow-up suggestions as a JSON array.',
    ].join('\n');
}

/**
 * One-shot LLM call that generates follow-up suggestions from the last
 * user→assistant turn.
 *
 * Returns an empty array on any failure (network, parse, empty output,
 * no valid suggestions after normalization) — the caller can silently
 * skip the bar. AbortErrors are RE-THROWN so the caller (SessionView)
 * can distinguish "no suggestions" from "cancelled mid-flight".
 */
export async function extractSuggestionsViaLLM(
    modelConfig: MinimalModelConfig,
    userMessage: string,
    assistantMessage: string,
    signal?: AbortSignal,
): Promise<SuggestedAction[]> {
    const assistantText = stripStructuredBlock(assistantMessage).trim();
    if (!assistantText) return [];

    const truncatedUser = truncate(userMessage.trim(), Math.floor(MAX_INPUT_CHARS / 2));
    const truncatedAssistant = truncate(assistantText, MAX_INPUT_CHARS - truncatedUser.length);

    const system = SUGGESTION_EXTRACTION_SYSTEM_PROMPT;
    const userPrompt = buildSuggestionUserPrompt(truncatedUser, truncatedAssistant);

    let raw: string;
    try {
        raw = await createChatCompletion(modelConfig, [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
        ], signal);
    } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn('[Suggestions] LLM extraction call failed:', err);
        return [];
    }

    if (!raw || !raw.trim()) return [];

    const parsed = parseSuggestionJson(raw);
    if (!parsed) return [];

    return normalize(parsed, DEFAULT_LIMIT, DEFAULT_LABEL_MAX);
}

// ─── Parsing ───────────────────────────────────────────────────────────

/** Tolerant JSON extraction: bare array, ```json fence, or first balanced [...]. */
function parseSuggestionJson(raw: string): unknown[] | null {
    const trimmed = raw.trim();

    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const candidate = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;

    const direct = tryParseArray(candidate);
    if (direct) return direct;

    const start = candidate.indexOf('[');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i];
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) {
                const slice = candidate.slice(start, i + 1);
                const arr = tryParseArray(slice);
                if (arr) return arr;
                break;
            }
        }
    }
    return null;
}

function tryParseArray(s: string): unknown[] | null {
    try {
        const v = JSON.parse(s) as unknown;
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

// ─── Normalization ─────────────────────────────────────────────────────

function normalize(raw: unknown[], limit: number, labelMax: number): SuggestedAction[] {
    const out: SuggestedAction[] = [];
    const seen = new Set<string>();

    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;

        const label = cleanLabel(obj.label, labelMax);
        const prompt = cleanPrompt(obj.prompt);
        if (!label || !prompt) continue;

        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({ label, prompt });
        if (out.length >= limit) break;
    }
    return out;
}

function cleanLabel(v: unknown, max: number): string {
    if (typeof v !== 'string') return '';
    // Strip markdown formatting before truncating — the label is rendered
    // as plain text on a button, so **bold** / `code` / [links] etc. must
    // not leak through. Mirrors what extractor.ts does in its normalize().
    let s = stripMarkdownToPlainText(v).trim();
    // Strip trailing question marks — labels must be action phrases.
    s = s.replace(/[?？]+$/, '').trim();
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, max - 1).trimEnd() + '…';
}

function cleanPrompt(v: unknown): string {
    if (typeof v !== 'string') return '';
    return v.trim();
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max);
}
