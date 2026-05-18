/**
 * Build the skills catalogue snippet that gets appended to the main
 * agent's system prompt for a given user turn.
 *
 * Two modes, picked transparently:
 *
 *   - **Embedding shortlist** (preferred when an embedding profile is
 *     configured and the query is "long enough" — see {@link isQueryTooShort}):
 *     embed the user's query plus each enabled skill's
 *     `name + description`, rank by cosine similarity, then advertise
 *     only the top `topK` skills whose score clears `similarityThreshold`.
 *     Mirrors the same shortlist pattern `ChatStream._getBestMatchedTools`
 *     uses for on-demand tools, including the zero-pass fallback
 *     (when *every* skill is filtered out, keep `min(3, topK)` best
 *     scoring ones so the model still has a workable surface area).
 *
 *   - **Full catalogue fallback**: when embedding is not configured,
 *     the query is too short, the embedder hasn't been initialized,
 *     or the embedding call throws — return every enabled skill. This
 *     matches the pre-embedding behaviour exactly, so a misconfigured
 *     embedding setup can never *reduce* what the model can discover.
 *
 * The returned text is intentionally indistinguishable between modes
 * (no "this is a shortlist" hint) so the model treats every advertised
 * skill as the full available set — preventing it from guessing at
 * names that happened to be filtered out this turn.
 */

import { findSimilar, isQueryTooShort } from '../services/text-embedding';
import { getGlobalEmbedder } from '../services/embedder';
import type { MinimalModelConfig } from '../services/llm-provider';
import type { SkillManager, SkillDefinition } from './skill-manager';

/** Knobs for the embedding-based shortlist. Same shape as `EmbeddingFilterOptions`. */
export interface SkillCatalogueFilterOptions {
    /** Minimum cosine similarity, clamped to `[0, 1]`. */
    similarityThreshold: number;
    /** Cap on the number of skills surfaced after filtering. */
    topK: number;
}

export interface BuildSkillSystemPromptParams {
    skillManager: SkillManager;
    /** Current user input — drives the embedding similarity ranking. */
    query: string;
    /**
     * Embedding provider config. `null` / `undefined` → no shortlisting,
     * the full catalogue is returned (assuming any skills are enabled).
     */
    embeddingConfig: MinimalModelConfig | null | undefined;
    /** Tunables for the shortlist. Required when `embeddingConfig` is given. */
    filterOpts?: SkillCatalogueFilterOptions;
    /** Forwarded to the embedder for user-initiated aborts. */
    signal?: AbortSignal;
}

/**
 * Compose the catalogue text appended to the main agent's system prompt.
 *
 * Safe to call on every user turn:
 *   - Skill descriptions are embedded only once each — the shared
 *     {@link Embedder} caches per-text vectors keyed by sha256(text),
 *     so subsequent turns only pay for the query embedding.
 *   - Any failure (embedder uninitialized, network error, provider
 *     mismatch …) falls back to the full catalogue and logs a warning.
 */
export async function buildSkillSystemPromptForQuery(
    params: BuildSkillSystemPromptParams,
): Promise<string> {
    const { skillManager, query, embeddingConfig, filterOpts, signal } = params;

    const enabledSkills = skillManager.getSkills();
    if (enabledSkills.length === 0) {
        return '';
    }

    // ── Decide whether to shortlist or hand back the full catalogue ──
    //
    // Each of these branches is a "no embedding-based filtering" case;
    // the user-visible behaviour matches the pre-embedding implementation
    // exactly, so a misconfigured or absent embedding stack never reduces
    // what the model can discover.
    if (!embeddingConfig) {
        return skillManager.buildSystemPromptForSkills(enabledSkills);
    }
    if (isQueryTooShort(query)) {
        return skillManager.buildSystemPromptForSkills(enabledSkills);
    }
    const embedder = getGlobalEmbedder();
    if (!embedder) {
        console.warn('SkillCatalogue: global embedder not initialized, falling back to full catalogue');
        return skillManager.buildSystemPromptForSkills(enabledSkills);
    }

    const similarityThreshold = Math.max(0, Math.min(1, filterOpts?.similarityThreshold ?? 0));
    const topK = Math.max(1, Math.floor(filterOpts?.topK ?? enabledSkills.length));

    try {
        await embedder.updateConfig(embeddingConfig);

        const texts = [query, ...enabledSkills.map(buildSkillEmbeddingText)];
        const vectors = await embedder.embed(texts, signal);
        const queryEmbedding = vectors[0]!;
        const skillEmbeddings = vectors.slice(1);

        const allRanked = findSimilar(queryEmbedding, skillEmbeddings, enabledSkills.length, 0);
        let kept = allRanked
            .filter(r => r.similarity >= similarityThreshold)
            .slice(0, topK);

        // Zero-pass fallback: if the threshold kicked everyone out,
        // retain the best few so the model still has *something* to
        // pick from. Respects the caller's topK cap (someone who set
        // topK=1 doesn't want 3 fallback entries) and the genuine
        // "no skills enabled" case (already returned above).
        if (kept.length === 0 && allRanked.length > 0) {
            const fallbackCount = Math.min(3, topK, allRanked.length);
            kept = allRanked.slice(0, fallbackCount);
        }

        const shortlisted = kept.map(r => enabledSkills[r.index]!);

        // Detailed per-skill similarity log — same shape as the tool
        // filter's diagnostic table so users / devs can read both logs
        // with the same mental model.
        const passedIndices = new Set(kept.map(s => s.index));
        const scoreTable = allRanked.map(s => ({
            name: enabledSkills[s.index]!.name,
            similarity: Number(s.similarity.toFixed(4)),
            passed: passedIndices.has(s.index),
        }));
        console.debug(scoreTable);

        const droppedCount = enabledSkills.length - shortlisted.length;
        const filterRate = enabledSkills.length > 0
            ? droppedCount / enabledSkills.length
            : 0;
        console.debug(
            `Skill catalogue filter: total=${enabledSkills.length} → kept ${shortlisted.length}; ` +
            `dropped ${droppedCount} (filterRate=${(filterRate * 100).toFixed(1)}%, ` +
            `threshold=${similarityThreshold}, topK=${topK})`,
        );

        return skillManager.buildSystemPromptForSkills(shortlisted);
    } catch (err) {
        // The Embedder already marked itself as `unavailable` (see
        // Embedder.embed); we just degrade to the full catalogue here.
        // Aborts propagate through the embedder as DOMException — let
        // the surrounding prompt() flow handle them; for everything else
        // log + fall back so a broken embedding profile never blocks
        // skill discovery.
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
        }
        console.error('SkillCatalogue: embedding failed, falling back to full catalogue', err);
        return skillManager.buildSystemPromptForSkills(enabledSkills);
    }
}

/**
 * Compose the text that represents a single skill in the embedding
 * space. Mirrors `buildToolEmbeddingText` in spirit — combine the
 * strongest semantic signal (name + description) into one newline-
 * separated blob so cosine similarity has more than just a one-liner
 * to bite on. Skill bodies are deliberately NOT included: they live
 * out-of-prompt behind `load_skill` and embedding them would dilute
 * the ranking with implementation noise.
 *
 * Changes to this composition invalidate the embedder's per-text
 * cache (entries are keyed by sha256(text)). That's acceptable: at
 * worst one re-embed of every skill on next use.
 */
function buildSkillEmbeddingText(skill: SkillDefinition): string {
    return [skill.name, skill.description ?? ''].filter(Boolean).join('\n');
}
