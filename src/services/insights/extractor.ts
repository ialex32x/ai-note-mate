import type { MinimalModelConfig } from '../llm-provider';
import { createChatCompletion } from '../context-reducer';
import { stripStructuredBlock } from '../suggestions';
import {
    INSIGHT_EXTRACTION_SYSTEM_PROMPT,
    buildInsightUserPrompt,
} from './prompts';
import type {
    ConversationInsight,
    ExtractInsightsInput,
    ExtractInsightsOptions,
} from './types';

const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_INPUT_CHARS = 8000;
const MAX_TITLE_LEN = 60;
const MAX_SUMMARY_LEN = 400;
const MAX_TAGS = 5;
const MAX_LINKED_NOTES = 5;

/**
 * One-shot, stateless LLM call that extracts candidate knowledge
 * nuggets from a single user→assistant turn. Returns an empty array
 * on any failure (network, parse, empty output) — the caller decides
 * whether to hide the card or render "no insights".
 *
 * This deliberately reuses {@link createChatCompletion} (the same
 * channel as the context summarizer and edit-history rewrite) so no
 * new provider plumbing is introduced.
 */
export async function extractInsights(
    modelConfig: MinimalModelConfig,
    input: ExtractInsightsInput,
    options: ExtractInsightsOptions = {},
): Promise<ConversationInsight[]> {
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 10));
    const maxChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;

    const userText = truncate(input.userMessage ?? '', Math.floor(maxChars / 3));
    // Strip any structured follow-up block so the extractor doesn't
    // try to turn "suggestion labels" into insights.
    const assistantRaw = stripStructuredBlock(input.assistantMessage ?? '');
    const assistantText = truncate(assistantRaw, maxChars - userText.length);

    if (!assistantText.trim()) return [];

    const system = INSIGHT_EXTRACTION_SYSTEM_PROMPT.replace('{limit}', String(limit));
    const userPrompt = buildInsightUserPrompt(userText, assistantText);

    let raw: string;
    try {
        raw = await createChatCompletion(modelConfig, [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
        ]);
    } catch (err) {
        console.warn('[Insights] extraction LLM call failed:', err);
        return [];
    }

    if (!raw || !raw.trim()) return [];
    const parsed = parseInsightJson(raw);
    if (!parsed) return [];

    return normalize(parsed, limit);
}

// ─── Parsing ───────────────────────────────────────────────────────────

/**
 * Tolerant JSON extraction:
 *  - accepts a bare JSON array
 *  - accepts ```json ... ``` fences
 *  - accepts the array embedded in surrounding prose (picks the first
 *    balanced `[...]` it finds)
 */
function parseInsightJson(raw: string): unknown[] | null {
    const trimmed = raw.trim();

    // 1) Strip common code fences.
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const candidate = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;

    // 2) Fast path: whole candidate is JSON.
    const direct = tryParseArray(candidate);
    if (direct) return direct;

    // 3) Fallback: find the first `[` ... matching `]` in the string.
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
        const v = JSON.parse(s);
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

// ─── Normalization ─────────────────────────────────────────────────────

function normalize(raw: unknown[], limit: number): ConversationInsight[] {
    const out: ConversationInsight[] = [];
    const seenTitles = new Set<string>();

    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;

        const title = cleanString(obj.title, MAX_TITLE_LEN);
        const summary = cleanString(obj.summary, MAX_SUMMARY_LEN);
        if (!title || !summary) continue;

        const key = title.toLowerCase();
        if (seenTitles.has(key)) continue;
        seenTitles.add(key);

        const tags = toStringArray(obj.tags, MAX_TAGS, 24)
            .map((t) => t.toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-'))
            .filter((t) => t.length > 0);

        const linkedNotes = toStringArray(obj.linkedNotes, MAX_LINKED_NOTES, 120)
            // Strip any stray wiki-link wrappers.
            .map((n) => n.replace(/^\[\[|\]\]$/g, '').trim())
            .filter((n) => n.length > 0);

        out.push({ title, summary, tags, linkedNotes });
        if (out.length >= limit) break;
    }
    return out;
}

function cleanString(v: unknown, max: number): string {
    if (typeof v !== 'string') return '';
    const s = v.replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= max) return s;
    return s.slice(0, max - 1).trimEnd() + '…';
}

function toStringArray(v: unknown, maxItems: number, maxItemLen: number): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
        if (typeof item !== 'string') continue;
        const s = item.trim();
        if (!s) continue;
        out.push(s.length <= maxItemLen ? s : s.slice(0, maxItemLen - 1) + '…');
        if (out.length >= maxItems) break;
    }
    return out;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n…[truncated]';
}
