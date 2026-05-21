/**
 * Build the per-turn "Memory" system-prompt prefix.
 *
 * The output is meant to be prepended (above the skills catalogue and
 * the static system prompt) so the model treats memory facts as
 * authoritative background context for the rest of the conversation.
 *
 * Selection strategy:
 *   - Critical entries (heading ends in ` [!]`) are ALWAYS included.
 *     Together they are capped at {@link NoteAssistantPluginSettings.memoryCriticalMaxChars}
 *     so a runaway critical pool can't take over the prompt.
 *   - Relevant entries are ranked by the retriever (BM25, fused with
 *     embedding cosine via RRF when embedding is configured), then
 *     the top-K are included.
 *   - When the query is too short or the retriever produces no
 *     signal, we surface the relevant pool's first `topK` entries
 *     as a safe fallback — the note's authoring order is a
 *     meaningful default for low-signal queries.
 */

import type NoteAssistantPlugin from '../../main';
import { retrieve, isQueryTooShort } from '../retriever';
import type { MinimalModelConfig } from '../llm-provider';
import type { MemoryEntry } from './memory-note-parser';
import type { MemoryStore } from './memory-store';
import { isMemoryConfigured } from './memory-store';
import { stripCallouts } from './body-sanitizer';

/**
 * Inputs for {@link buildMemorySystemPromptPrefix}. Kept as a single
 * options bag because the caller in `chat-factory.ts` already passes a
 * shape like this to the skill catalogue builder — matching their
 * surface keeps the wiring uniform.
 */
export interface BuildMemoryPromptParams {
    plugin: NoteAssistantPlugin;
    store: MemoryStore;
    /** Current user input — drives the retriever ranking. */
    query: string;
    /**
     * Embedding provider config. `null` / `undefined` → the retriever
     * runs BM25-only over the relevant pool, which still shortlists
     * by query-term overlap. Configurations without embedding no
     * longer fall back to "first N" unconditionally — the retriever
     * gives them genuine relevance ranking too.
     */
    embeddingConfig: MinimalModelConfig | null | undefined;
    /** Forwarded to the retriever for user-initiated aborts. */
    signal?: AbortSignal;
}

const HEADING_NOTE = (
    'The following memory entries describe long-term context the user has authored or accepted across earlier sessions. Treat them as authoritative background unless the user revises them.'
);

/**
 * Build the memory snippet, or `''` when memory is disabled, the file
 * is missing/empty, or every entry was filtered out.
 *
 * Safe to call on every user turn. Non-fatal errors (file read failure,
 * embedding error) degrade silently with a console warning — memory must
 * NEVER block a chat turn.
 */
export async function buildMemorySystemPromptPrefix(
    params: BuildMemoryPromptParams,
): Promise<string> {
    const { plugin, store, query, embeddingConfig, signal } = params;

    if (!isMemoryConfigured(plugin)) return '';

    let entries: MemoryEntry[];
    try {
        entries = await store.refreshEntries();
    } catch (err) {
        console.warn('[Memory] failed to read memory note, skipping prompt prefix:', err);
        return '';
    }
    if (entries.length === 0) return '';

    const settings = plugin.settings;
    const critical = entries.filter(e => e.critical);
    const relevant = entries.filter(e => !e.critical);

    const criticalBudget = Math.max(0, settings.memoryCriticalMaxChars | 0);
    const topK = Math.max(0, settings.memoryRelevantTopK | 0);

    const criticalChosen = pickCriticalWithinBudget(critical, criticalBudget);
    const relevantChosen = await pickRelevant({
        candidates: relevant,
        query,
        topK,
        embeddingConfig: embeddingConfig ?? null,
        signal,
    });

    if (criticalChosen.length === 0 && relevantChosen.length === 0) return '';

    return renderPrefix(criticalChosen, relevantChosen);
}

// ─── Selection helpers ──────────────────────────────────────────────────

function pickCriticalWithinBudget(
    entries: readonly MemoryEntry[],
    maxChars: number,
): MemoryEntry[] {
    if (entries.length === 0) return [];
    if (maxChars <= 0) return entries.slice();

    const out: MemoryEntry[] = [];
    let used = 0;
    for (const e of entries) {
        const cost = estimateRenderCost(e);
        if (used + cost > maxChars && out.length > 0) {
            // Drop the rest rather than truncating in the middle —
            // partial bodies are confusing for the model.
            console.warn(
                `[Memory] critical memory exceeded character budget (${used}+${cost} > ${maxChars}); dropping "${e.logicalHeading}" and ${entries.length - out.length - 1} more`,
            );
            break;
        }
        out.push(e);
        used += cost;
    }
    return out;
}

async function pickRelevant(opts: {
    candidates: readonly MemoryEntry[];
    query: string;
    topK: number;
    embeddingConfig: MinimalModelConfig | null;
    signal?: AbortSignal;
}): Promise<MemoryEntry[]> {
    const { candidates, query, topK, embeddingConfig, signal } = opts;
    if (candidates.length === 0) return [];
    if (topK <= 0) return [];

    // On signal-poor queries (1–2 chars, follow-ups like "yes" / "继续")
    // BM25 ranking is essentially noise — let the relevant pool's
    // existing order (whatever the user authored in the memory note)
    // through unchanged instead. Skill / tool retrievers fall back to
    // the FULL surface in this case; memory uses first-N because the
    // pool can be large and exceeding `topK` would bloat the prompt.
    if (isQueryTooShort(query)) {
        return candidates.slice(0, topK);
    }

    try {
        const candidateTexts = candidates.map(buildEmbeddingText);
        const ranked = await retrieve(query, candidateTexts, {
            embeddingConfig,
            signal,
        });
        if (ranked.length === 0) {
            // No ranker produced any signal — fall back to the same
            // first-N behaviour as the short-query path so the user
            // still benefits from the relevant pool on a degenerate
            // input.
            return candidates.slice(0, topK);
        }
        const top = ranked.slice(0, topK).map(r => candidates[r.index]!).filter(Boolean);
        if (top.length === 0) return candidates.slice(0, topK);
        return top;
    } catch (err) {
        // Aborts must propagate so the chat turn can cancel cleanly;
        // other errors are non-fatal — fall back to the same simple
        // first-N behaviour as the no-embedding / short-query paths.
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        console.warn('[Memory] retriever failed, falling back:', err);
        return candidates.slice(0, topK);
    }
}

// ─── Rendering ───────────────────────────────────────────────────────────

function renderPrefix(critical: readonly MemoryEntry[], relevant: readonly MemoryEntry[]): string {
    const out: string[] = ['## Memory', '', HEADING_NOTE, ''];

    if (critical.length > 0) {
        out.push('### Always apply');
        out.push('');
        for (const e of critical) out.push(renderEntry(e));
    }

    if (relevant.length > 0) {
        out.push('### Possibly relevant to this turn');
        out.push('');
        for (const e of relevant) out.push(renderEntry(e));
    }

    out.push(''); // trailing blank line so the next prompt block starts cleanly
    return out.join('\n');
}

function renderEntry(entry: MemoryEntry): string {
    // Strip user-authored callouts before showing the body to the model
    // — those are private annotations and must not leak into the
    // prompt. After stripping, an entry whose body was *only* a
    // callout becomes effectively empty; we render it the same way as
    // a body-less entry so the model still sees the heading (it may
    // be enough of a signal on its own, e.g. "uses-imperial-units [!]").
    const body = stripCallouts(entry.body).trim();
    if (!body) return `- **${entry.logicalHeading}** _(empty)_\n`;
    return `- **${entry.logicalHeading}**: ${collapseSingleLine(body)}\n`;
}

/**
 * Memory entries are typically short; we render each on a single bullet
 * line (collapsing internal newlines into spaces) so the system prompt
 * stays compact. The original markdown still lives in the vault note —
 * the prefix is a *signal* to the model, not an archive copy.
 */
function collapseSingleLine(body: string): string {
    return body
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join(' ');
}

/**
 * Approximate the rendered character cost of one entry, used by the
 * critical-budget gate. Slightly overestimates (a few chars for the
 * bullet + bold markers) so the resulting prefix stays comfortably
 * within the user's budget rather than nudging up against it.
 */
function estimateRenderCost(entry: MemoryEntry): number {
    return entry.logicalHeading.length + entry.body.length + 12;
}

function buildEmbeddingText(entry: MemoryEntry): string {
    // Same callout-strip as `renderEntry`: keeping callouts in the
    // embedding text would let private annotations skew the similarity
    // ranking (an unrelated "[!todo] check later" note would suddenly
    // match every "todo / later" query).
    const parts = [entry.logicalHeading];
    const body = stripCallouts(entry.body).trim();
    if (body) parts.push(body);
    return parts.join('\n');
}

