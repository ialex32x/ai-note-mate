/**
 * One-shot, stateless LLM call that derives memory operations from a
 * single user→assistant turn. Mirrors {@link ../insights/extractor}: a
 * cheap summarizer-class model is asked to emit a strict JSON array
 * that the runner then applies to the {@link MemoryStore}.
 *
 * Returns an empty array on any failure (network, parse error, empty
 * output) — memory extraction must never break the chat flow.
 */

import type { MinimalModelConfig } from '../llm-provider';
import { createChatCompletion } from '../context-reducer';
import { stripStructuredBlock } from '../suggestions';
import {
    MEMORY_EXTRACTION_SYSTEM_PROMPT,
    buildMemoryUserPrompt,
} from './prompts';
import type { MemoryEntry } from './memory-note-parser';
import { stripCriticalSuffix } from './heading-format';
import { stripCallouts } from './body-sanitizer';

const DEFAULT_MAX_INPUT_CHARS = 8000;
const MAX_HEADING_LEN = 60;
const MAX_BODY_LEN = 600;

/** A single memory op the runner should apply. */
export type MemoryExtractOp =
    | { op: 'upsert'; heading: string; critical: boolean; body: string }
    | { op: 'delete'; heading: string };

export interface ExtractMemoryInput {
    userMessage: string;
    assistantMessage: string;
    existing: ReadonlyArray<MemoryEntry>;
}

export interface ExtractMemoryOptions {
    /** Maximum upsert operations per call. */
    maxUpserts: number;
    /** Maximum delete operations per call. */
    maxDeletes: number;
    /** Hard ceiling on characters fed to the extractor. Default 8000. */
    maxInputChars?: number;
}

export async function extractMemoryOps(
    modelConfig: MinimalModelConfig,
    input: ExtractMemoryInput,
    options: ExtractMemoryOptions,
): Promise<MemoryExtractOp[]> {
    const maxUpserts = Math.max(0, options.maxUpserts | 0);
    const maxDeletes = Math.max(0, options.maxDeletes | 0);
    if (maxUpserts === 0 && maxDeletes === 0) return [];

    const maxChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    const userText = truncate(input.userMessage ?? '', Math.floor(maxChars / 3));
    const assistantRaw = stripStructuredBlock(input.assistantMessage ?? '');
    const assistantText = truncate(assistantRaw, maxChars - userText.length);
    if (!assistantText.trim()) return [];

    // The extractor's "what already exists" snapshot must mirror what
    // the per-turn prompt builder shows the model: callouts stripped,
    // so the extractor doesn't see user annotations and decide to
    // "consolidate" them into a new entry (or to delete entries whose
    // only delta is a callout the model can't read).
    const existingForPrompt = input.existing.map(e => ({
        heading: e.logicalHeading,
        critical: e.critical,
        body: stripCallouts(e.body),
    }));

    const system = MEMORY_EXTRACTION_SYSTEM_PROMPT
        .replace('{maxUpserts}', String(maxUpserts))
        .replace('{maxDeletes}', String(maxDeletes));
    const userPrompt = buildMemoryUserPrompt({
        userMessage: userText,
        assistantMessage: assistantText,
        existingEntries: existingForPrompt,
    });

    let raw: string;
    try {
        raw = await createChatCompletion(modelConfig, [
            { role: 'system', content: system },
            { role: 'user', content: userPrompt },
        ]);
    } catch (err) {
        console.warn('[Memory] extraction LLM call failed:', err);
        return [];
    }
    if (!raw || !raw.trim()) return [];

    const parsed = parseMemoryJson(raw);
    if (!parsed) return [];

    return normalize(parsed, maxUpserts, maxDeletes);
}

// ─── Parsing (tolerant of code fences / surrounding prose) ──────────────

function parseMemoryJson(raw: string): unknown[] | null {
    const trimmed = raw.trim();
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    const candidate = fenceMatch ? (fenceMatch[1] ?? '').trim() : trimmed;

    const direct = tryParseArray(candidate);
    if (direct) return direct;

    // Find first balanced `[...]` substring.
    const start = candidate.indexOf('[');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < candidate.length; i++) {
        const ch = candidate[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
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

// ─── Normalisation + cap enforcement ────────────────────────────────────

function normalize(raw: unknown[], maxUpserts: number, maxDeletes: number): MemoryExtractOp[] {
    const out: MemoryExtractOp[] = [];
    let upserts = 0;
    let deletes = 0;
    const seenHeadings = new Set<string>();

    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const obj = entry as Record<string, unknown>;

        const op = typeof obj.op === 'string' ? obj.op.toLowerCase() : '';
        const headingRaw = typeof obj.heading === 'string' ? obj.heading : '';
        // Defensive: strip the marker if the model put it in even though
        // the prompt told it not to. The runtime sets criticality from
        // the `critical` field.
        const heading = stripCriticalSuffix(headingRaw).slice(0, MAX_HEADING_LEN).trim();
        if (!heading) continue;
        // Reject duplicate headings within the same extraction so the
        // store doesn't get two operations that flip each other.
        const dedupeKey = `${op}::${heading.toLowerCase()}`;
        if (seenHeadings.has(dedupeKey)) continue;
        seenHeadings.add(dedupeKey);

        if (op === 'upsert') {
            if (upserts >= maxUpserts) continue;
            const body = cleanBody(obj.body);
            if (!body) continue;
            const critical = obj.critical === true;
            out.push({ op: 'upsert', heading, critical, body });
            upserts++;
        } else if (op === 'delete') {
            if (deletes >= maxDeletes) continue;
            out.push({ op: 'delete', heading });
            deletes++;
        }
        // Unknown ops are silently dropped — easier than failing the
        // whole batch when the model emits one experimental entry.
    }
    return out;
}

function cleanBody(v: unknown): string {
    if (typeof v !== 'string') return '';
    const s = v.replace(/\r/g, '').trim();
    if (!s) return '';
    if (s.length <= MAX_BODY_LEN) return s;
    return s.slice(0, MAX_BODY_LEN - 1).trimEnd() + '…';
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n…[truncated]';
}
