import type { MinimalModelConfig } from '../llm-provider';
import { createChatCompletion } from '../context-compression';
import { stripStructuredBlock } from '../suggestions';
import {
    INSIGHT_EXTRACTION_SYSTEM_PROMPT,
    FREEFORM_TAG_SECTION,
    buildInsightUserPrompt,
    buildRestrictedTagSection,
} from './prompts';
import type {
    ConversationInsight,
    ExtractInsightsInput,
    ExtractInsightsOptions,
} from './types';
import { isAbortError } from '../../utils/abortable-request';

const DEFAULT_LIMIT = 3;
const DEFAULT_MAX_INPUT_CHARS = 8000;
const MAX_TITLE_LEN = 60;
const MAX_SUMMARY_LEN = 400;
const MAX_TAGS = 5;
const MAX_LINKED_NOTES = 5;
/**
 * Cap the number of tags we actually quote into the system prompt. Vaults
 * with thousands of tags would otherwise blow the context window; we still
 * use the *full* vocabulary for post-filtering so rarely-used tags stay
 * reachable if the model happens to guess them correctly.
 */
const MAX_TAGS_IN_PROMPT = 200;

/**
 * One-shot, stateless LLM call that extracts candidate knowledge
 * nuggets from a single user→assistant turn. Returns an empty array
 * on any failure (network, parse, empty output) — the caller decides
 * whether to hide the card or render "no insights".
 *
 * This deliberately reuses {@link createChatCompletion} (the same
 * channel as other auxiliary one-shot calls) so no new provider plumbing
 * is introduced.
 *
 * `signal` is forwarded to the LLM call so the caller (auto-runner
 * wired to `runtime.disposeSignal`, manual bubble action, …) can
 * abort extraction mid-flight when the owning runtime is torn down.
 * Aborts are RE-THROWN (not swallowed into an empty result) so the
 * caller can distinguish "extraction produced nothing" from "runtime
 * went away" and avoid clobbering UI state with a fake terminal.
 */
export async function extractInsights(
    modelConfig: MinimalModelConfig,
    input: ExtractInsightsInput,
    options: ExtractInsightsOptions = {},
    signal?: AbortSignal,
): Promise<ConversationInsight[]> {
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 10));
    const maxChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;

    const userText = truncate(input.userMessage ?? '', Math.floor(maxChars / 3));
    // Strip any structured follow-up block so the extractor doesn't
    // try to turn "suggestion labels" into insights.
    const assistantRaw = stripStructuredBlock(input.assistantMessage ?? '');
    const assistantText = truncate(assistantRaw, maxChars - userText.length);

    if (!assistantText.trim()) return [];

    // Tag vocabulary: when the host provides the vault's existing tags,
    // we restrict the model to pick from them (see prompts.ts). Otherwise
    // fall back to the legacy free-form mode.
    const availableTags = normalizeAvailableTags(options.availableTags);
    const tagSection =
        availableTags.length > 0
            ? buildRestrictedTagSection(availableTags.slice(0, MAX_TAGS_IN_PROMPT))
            : FREEFORM_TAG_SECTION;
    const allowedTagLookup = availableTags.length > 0 ? buildTagLookup(availableTags) : null;

    const system = INSIGHT_EXTRACTION_SYSTEM_PROMPT
        .replace('{limit}', String(limit))
        .replace('{tagSection}', tagSection);
    const userPrompt = buildInsightUserPrompt(userText, assistantText);

    let raw: string;
    try {
        raw = await createChatCompletion(modelConfig, [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
        ], signal);
    } catch (err) {
        // Aborts MUST propagate — see the function-level doc. The auto
        // runner uses this distinction to skip the "extraction failed"
        // UI state (which would mislabel a disposed-runtime cancellation
        // as a real failure).
        if (isAbortError(err)) throw err;
        console.warn('[Insights] extraction LLM call failed:', err);
        return [];
    }

    if (!raw || !raw.trim()) return [];
    const parsed = parseInsightJson(raw);
    if (!parsed) return [];

    return normalize(parsed, limit, allowedTagLookup);
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
        const v = JSON.parse(s) as unknown;
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

// ─── Normalization ─────────────────────────────────────────────────────

function normalize(
    raw: unknown[],
    limit: number,
    allowedTagLookup: Map<string, string> | null,
): ConversationInsight[] {
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

        const tags = normalizeTagList(obj.tags, allowedTagLookup);

        const linkedNotes = toStringArray(obj.linkedNotes, MAX_LINKED_NOTES, 120)
            // Strip any stray wiki-link wrappers.
            .map((n) => n.replace(/^\[\[|\]\]$/g, '').trim())
            .filter((n) => n.length > 0);

        out.push({ title, summary, tags, linkedNotes });
        if (out.length >= limit) break;
    }
    return out;
}

/**
 * Normalise + optionally whitelist-filter the `tags` field on a raw
 * insight entry.
 *
 * When `allowedTagLookup` is non-null, we:
 *   - drop any tag that isn't in the vault's existing vocabulary
 *   - rewrite survivors to the canonical form recorded in the lookup
 *     (so we don't accidentally invent casing variants like `Project`
 *     vs `project`)
 *
 * When it's null, we fall back to the legacy free-form cleanup:
 * lowercase, strip leading '#', collapse whitespace to '-'.
 */
function normalizeTagList(
    raw: unknown,
    allowedTagLookup: Map<string, string> | null,
): string[] {
    const items = toStringArray(raw, MAX_TAGS, 64)
        .map((t) => t.replace(/^#+/, '').trim())
        .filter((t) => t.length > 0);

    if (allowedTagLookup) {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const t of items) {
            const canonical = allowedTagLookup.get(t.toLowerCase());
            if (!canonical) continue; // not in vocabulary — drop
            if (seen.has(canonical)) continue;
            seen.add(canonical);
            out.push(canonical);
            if (out.length >= MAX_TAGS) break;
        }
        return out;
    }

    // Free-form path (legacy behaviour).
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of items) {
        const normalised = t.toLowerCase().replace(/\s+/g, '-');
        if (!normalised || seen.has(normalised)) continue;
        seen.add(normalised);
        out.push(normalised);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

function normalizeAvailableTags(raw: ReadonlyArray<string> | undefined): string[] {
    if (!raw || raw.length === 0) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        // Accept both "#tag" and "tag"; store as bare.
        const bare = item.trim().replace(/^#+/, '').trim();
        if (!bare) continue;
        const key = bare.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(bare);
    }
    return out;
}

/** Build a case-insensitive lookup from normalised tag → canonical form. */
function buildTagLookup(tags: ReadonlyArray<string>): Map<string, string> {
    const map = new Map<string, string>();
    for (const t of tags) {
        const key = t.toLowerCase();
        if (!map.has(key)) map.set(key, t);
    }
    return map;
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
