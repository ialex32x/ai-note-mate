/**
 * Per-turn sub-agent shortlister.
 *
 * The `AgentOrchestrator` calls {@link selectMatchingSubAgents} at the
 * start of every turn to decide WHICH sub-agents should appear in:
 *   - the dynamic DELEGATION block injected via `systemPromptSuffix`
 *   - the `agent` enum of the `delegate_task` tool schema
 *
 * Architecturally this is the sub-agent analogue of
 * `ChatStream._getBestMatchedTools` — same hybrid BM25 + embedding RRF
 * retriever, same `isQueryTooShort` short-query guard, same
 * sticky-on-history behaviour pattern. Pulled into its own module so
 * the orchestrator stays focused on dispatch/state and so the routing
 * decisions are unit-testable without bootstrapping a full
 * ChatStream + provider stack.
 *
 * The result is intentionally a SUBSET ordering of the input
 * `available` list (the retriever's top-K, then any sticky-on-history
 * entries appended at the end). The orchestrator passes this ordering
 * straight through to {@link buildDelegationSystemPrompt} and to the
 * `delegate_task` schema, so the model sees the most relevant
 * sub-agent first.
 */

import type { MinimalModelConfig } from './llm-provider';
import { retrieve, isQueryTooShort } from './retriever';
import { bm25Rank } from './retriever/bm25';
import type { SubAgentConfig } from './sub-agent';
import { isAbortError } from '../utils/abortable-request';

/**
 * Build the embedding / BM25 text for a single sub-agent.
 *
 * Composition mirrors `buildToolEmbeddingText` in `chat-stream.ts` so
 * the BM25 tokenizer sees the same shape of signal across tools,
 * skills, and sub-agents:
 *   1. `name` — language-neutral identifier (e.g. `vault_inspector`).
 *   2. `description` — the bulk of the semantic payload.
 *   3. `routingKeywords` — multilingual lexical triggers (already
 *      curated per sub-agent in `sub-agent-prompts.ts`); essential for
 *      BM25-only mode where embedding can't bridge synonym gaps.
 *
 * Returning a single newline-joined string keeps the ranker's input
 * uniform with tools and skills.
 */
function buildSubAgentEmbeddingText(config: SubAgentConfig): string {
    const parts: string[] = [config.name, config.description];
    if (config.routingKeywords && config.routingKeywords.length > 0) {
        parts.push(`Triggers: ${config.routingKeywords.join(', ')}`);
    }
    return parts.filter(Boolean).join('\n');
}

/**
 * Build the parallel ranker-input texts for a sub-agent list.
 *
 * The orchestrator caches this array at the start of every turn so
 * the per-iteration sync BM25 re-rank
 * ({@link refineMatchingSubAgentsSync}) doesn't have to rebuild the
 * embedding-text strings on every tool-call loop iteration. The
 * returned array is index-parallel with the input `configs` so a
 * `BM25Result.index` resolves to a sub-agent without an extra lookup.
 */
export function buildSubAgentCandidateTexts(
    configs: ReadonlyArray<SubAgentConfig>,
): string[] {
    return configs.map(buildSubAgentEmbeddingText);
}

/** Options forwarded into {@link selectMatchingSubAgents}. */
export interface SubAgentRouterOptions {
    /**
     * Maximum number of retriever-ranked sub-agents to surface.
     * Sticky-on-history entries are added on top of this cap so they
     * never get squeezed out by a particularly noisy user query.
     * Caller should pass a positive integer; the router clamps to
     * `[1, available.length]` defensively.
     */
    topK: number;
    /**
     * Embedding provider config for the hybrid retriever. `null` /
     * `undefined` → BM25-only mode (still useful thanks to the curated
     * `routingKeywords` on each sub-agent).
     */
    embeddingConfig?: MinimalModelConfig | null;
    /**
     * Forwarded to the embedder for user-initiated aborts. The router
     * re-throws `AbortError` so the orchestrator's `prompt()` unwinds
     * cleanly instead of silently shipping a stale shortlist.
     */
    signal?: AbortSignal;
    /**
     * Names of sub-agents that have already been delegated to at least
     * once in this conversation. The router UNIONS this set into the
     * retriever output — once a sub-agent has produced messages /
     * tool_calls visible to the main LLM, removing it from the
     * DELEGATION block mid-conversation would leave the model with
     * envelope references it can no longer interpret.
     */
    stickyAgentNames?: ReadonlySet<string>;
    /**
     * Last turn's shortlist, used as fallback for short / signal-poor
     * queries (typically follow-ups like "yes" / "继续"). When this is
     * empty the router falls through to the full `available` set so a
     * first-turn "ok" doesn't accidentally hide every sub-agent.
     */
    fallbackOnShortQuery?: ReadonlyArray<SubAgentConfig>;
}

/**
 * Shortlist sub-agents against the current user query.
 *
 * Behaviour by mode:
 *   - **Empty `available`** → returns `[]`.
 *   - **Short query** (`isQueryTooShort`) → returns `fallbackOnShortQuery`
 *     when supplied (continuity with the previous turn), otherwise just the
 *     sticky union. No longer falls back to the full `available` set — a
 *     first-turn "hello" doesn't need every DELEGATION block injected.
 *   - **Retriever succeeded, ≥ 1 candidate scored** → top-K by fused
 *     score, plus the sticky union.
 *   - **Retriever returned 0 candidates** AND embedding was actually
 *     in use → trust the negative signal and return only the sticky
 *     union (possibly empty → DELEGATION block skipped entirely).
 *     This is the deliberate token-savings path for casual chat turns.
 *   - **Retriever returned 0 candidates** AND we were in BM25-only
 *     mode → fall back to the full `available` list. BM25 misses
 *     synonyms; dropping every sub-agent on a lexical miss would be
 *     too eager when no semantic signal was available.
 *   - **Retriever threw a non-Abort error** → fall back to the full
 *     `available` list. Abort errors re-throw.
 */
export async function selectMatchingSubAgents(
    query: string,
    available: ReadonlyArray<SubAgentConfig>,
    opts: SubAgentRouterOptions,
): Promise<SubAgentConfig[]> {
    if (available.length === 0) return [];

    const requestedTopK = Math.floor(opts.topK);
    const topK = Math.max(
        1,
        Math.min(available.length, Number.isFinite(requestedTopK) ? requestedTopK : 1),
    );
    const stickyAgentNames = opts.stickyAgentNames ?? new Set<string>();

    const applySticky = (selected: SubAgentConfig[]): SubAgentConfig[] => {
        if (stickyAgentNames.size === 0) return selected;
        const selectedNames = new Set(selected.map(s => s.name));
        const out = [...selected];
        for (const cfg of available) {
            if (stickyAgentNames.has(cfg.name) && !selectedNames.has(cfg.name)) {
                out.push(cfg);
            }
        }
        return out;
    };

    // Short / signal-poor query: prefer last turn's shortlist so the
    // user's "continue" / "yes" picks up where the previous turn left
    // off. When there IS no last turn, return only sticky agents
    // rather than the full set — injecting every sub-agent's
    // DELEGATION block on a first-turn "hello" costs ~800+ tokens
    // for no benefit. The model can still respond helpfully without
    // delegation; proper routing kicks in on the next substantive query.
    if (isQueryTooShort(query)) {
        const fallback = opts.fallbackOnShortQuery && opts.fallbackOnShortQuery.length > 0
            ? Array.from(opts.fallbackOnShortQuery)
            : [];
        return applySticky(fallback);
    }

    const usedEmbedding = !!opts.embeddingConfig;
    let rankedIndices: number[];
    try {
        const candidates = available.map(buildSubAgentEmbeddingText);
        const result = await retrieve(query, candidates, {
            embeddingConfig: opts.embeddingConfig ?? null,
            signal: opts.signal,
        });
        rankedIndices = result.map(r => r.index);
    } catch (err) {
        if (isAbortError(err)) throw err;
        console.warn('[SubAgentRouter] retriever failed, falling back to full sub-agent set:', err);
        return applySticky([...available]);
    }

    if (rankedIndices.length === 0) {
        // See doc comment: with embedding configured an empty ranking
        // is a positive "nothing matches" signal (= save tokens, skip
        // DELEGATION); without embedding it's an absence-of-signal and
        // we conservatively keep everyone available.
        return applySticky(usedEmbedding ? [] : [...available]);
    }

    const selected = rankedIndices.slice(0, topK).map(i => available[i]!);
    return applySticky(selected);
}

// ─────────────────────────────────────────────────────────────────
// Per-iteration sync re-rank
// ─────────────────────────────────────────────────────────────────

/** Options forwarded into {@link refineMatchingSubAgentsSync}. */
export interface SubAgentRefineOptions {
    /**
     * Max number of NEW sub-agents the BM25 re-rank can add on top of
     * `baselineShortlist`. Sticky-on-history entries are appended on
     * top of this cap. Caller passes a positive integer; we clamp to
     * `[1, available.length]` defensively.
     */
    topK: number;
    /**
     * The turn-level shortlist computed by the async router
     * ({@link selectMatchingSubAgents}). The sync re-rank UNIONS new
     * BM25 hits on top of this baseline — it never removes entries.
     * Rationale: the turn-level embedding pass has already done the
     * semantically-rich filtering against the user's original query;
     * undoing its work mid-turn would amplify the noise from a
     * single iteration's assistant text.
     */
    baselineShortlist: ReadonlyArray<SubAgentConfig>;
    /**
     * Same semantics as in {@link SubAgentRouterOptions} — the union
     * is applied AFTER the BM25 additions so a sub-agent already
     * dispatched earlier in the conversation can never silently
     * disappear from the per-iteration shortlist either.
     */
    stickyAgentNames?: ReadonlySet<string>;
}

/**
 * Per-iteration BM25-sync re-rank.
 *
 * Called from {@link AgentOrchestrator}'s `dynamicTools` callback —
 * which ChatStream re-evaluates on EVERY tool-call loop iteration —
 * to catch mid-turn intent shifts that the once-per-turn async
 * router cannot see. Example: a turn starts with "find notes about
 * cats" (router picks `vault_inspector` only); after iteration 1
 * the assistant text says "I'll also look up authoritative info on
 * the web"; this function re-ranks against `userInput + lastAssistantText`,
 * BM25 hits `web`'s `search` / `web` / `internet` triggers and adds
 * it to the shortlist so iteration 2's `delegate_task.agent` enum
 * lists `web` as a valid option.
 *
 * Sync-by-design because `dynamicTools` is sync. We deliberately
 * skip the embedding pass for this hop:
 *   - the async embedding-shortlist already covers semantically
 *     similar matches and is preserved as `baselineShortlist`;
 *   - per-iteration latency budget is tight (every iteration runs a
 *     provider streaming call right after this);
 *   - the curated `routingKeywords` on each sub-agent give BM25
 *     enough lexical surface to catch obvious intent signals
 *     (search/web/code/translate/…).
 *
 * UNION semantics — never shrinks. The returned list is exactly:
 *   1. `baselineShortlist`, in its original order (preserves the
 *      DELEGATION text's mention order).
 *   2. Top-K NEW BM25 hits not already in (1).
 *   3. Sticky-on-history entries not already in (1) or (2).
 *
 * Short / signal-poor `enrichedQuery` (per `isQueryTooShort`):
 * skips the BM25 step entirely and just returns the baseline + sticky.
 */
export function refineMatchingSubAgentsSync(
    enrichedQuery: string,
    available: ReadonlyArray<SubAgentConfig>,
    candidateTexts: ReadonlyArray<string>,
    opts: SubAgentRefineOptions,
): SubAgentConfig[] {
    if (available.length === 0) return [];

    const requestedTopK = Math.floor(opts.topK);
    const topK = Math.max(
        1,
        Math.min(available.length, Number.isFinite(requestedTopK) ? requestedTopK : 1),
    );

    // Seed the result with the baseline (preserves order so the
    // delegate_task enum mirrors the DELEGATION text's listing order).
    const result: SubAgentConfig[] = [...opts.baselineShortlist];
    const added = new Set(result.map(c => c.name));

    const appendStickyAdditions = (): SubAgentConfig[] => {
        if (!opts.stickyAgentNames || opts.stickyAgentNames.size === 0) return result;
        for (const cfg of available) {
            if (opts.stickyAgentNames.has(cfg.name) && !added.has(cfg.name)) {
                result.push(cfg);
                added.add(cfg.name);
            }
        }
        return result;
    };

    // Short queries: skip BM25 (its signal is noise on 1–2 char inputs).
    // The baseline already represents the user's actual intent for this
    // turn — keep it, then layer sticky on top.
    if (isQueryTooShort(enrichedQuery)) {
        return appendStickyAdditions();
    }

    // BM25 re-rank against the enriched query. The first `topK` NEW
    // candidates (i.e. NOT already in baseline) get appended. Sub-
    // agents that score but are already in baseline are ignored — no
    // duplication, no re-ordering of the baseline.
    let bm25Added = 0;
    const ranked = bm25Rank(enrichedQuery, candidateTexts);
    for (const r of ranked) {
        if (bm25Added >= topK) break;
        const cfg = available[r.index];
        if (!cfg) continue;
        if (added.has(cfg.name)) continue;
        result.push(cfg);
        added.add(cfg.name);
        bm25Added++;
    }

    return appendStickyAdditions();
}
