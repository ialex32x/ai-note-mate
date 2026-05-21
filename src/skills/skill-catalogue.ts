/**
 * Build the skills catalogue snippet that gets prepended to the main
 * agent's system prompt for a given user turn.
 *
 * Ranking is delegated to the shared retriever (BM25 + embedding cosine
 * fused via RRF when embedding is configured; BM25-only otherwise),
 * then capped by `filterOpts.topK`. On top of the resulting shortlist
 * three escalation modes are picked transparently per turn:
 *
 *   - **Auto-inject** (top-1 cosine ≥ {@link DEFAULT_SKILL_AUTO_INJECT_THRESHOLD}):
 *     the full body of the top-matched skill is injected inline (above
 *     the catalogue). The model can follow it directly — no `load_skill`
 *     round trip needed. The skill is marked active so subsequent turns
 *     in the same session don't re-inject it.
 *
 *   - **Strong hint** (top-1 cosine ≥ {@link DEFAULT_SKILL_HINT_THRESHOLD}):
 *     the catalogue gets a one-line directive at the top naming the
 *     best match, but the full body stays out of context. Saves tokens
 *     vs. auto-inject while still concentrating the model's attention.
 *
 *   - **Plain shortlist**: the catalogue lists the top-K matching skills,
 *     without any extra steering. This is the historical behaviour.
 *
 * Both escalation gates are cosine-based and therefore fire ONLY when
 * embedding contributed (config supplied + embedder ready + call
 * succeeded). Under pure-BM25 mode the model still gets a ranked
 * shortlist, but no hint / auto-inject — BM25 scores have no stable
 * cross-model scale to threshold against.
 *
 * **Fallback paths**:
 *   - Query too short / signal-poor → full enabled-skill catalogue.
 *   - Retriever returns zero results (BM25 found nothing AND embedding
 *     wasn't used / failed) → full catalogue. A misconfigured embedding
 *     setup can never *reduce* what the model can discover.
 *   - Retriever throws (non-abort) → full catalogue.
 *
 * Active-skill tracking ({@link SkillManager.getActiveSkillNames}) is
 * woven through every mode: skills whose body is already in context are
 * rendered with `[loaded]` so the model knows to reuse them. The set is
 * cleared by ChatStream's `onContextCompressed` hook so post-compression
 * the catalogue can re-trigger them again.
 */

import { retrieve, isQueryTooShort } from '../services/retriever';
import type { MinimalModelConfig } from '../services/llm-provider';
import type { SkillManager, SkillDefinition } from './skill-manager';

/**
 * Built-in fallback for the auto-inject cosine-similarity floor — used
 * when the caller doesn't pass an explicit value (e.g. tests, ad-hoc
 * usage). The runtime path threads the user-tunable
 * `skillAutoInjectThreshold` from settings instead so different
 * embedding models (which produce wildly different score
 * distributions — see `text-embedding-3-small` vs. BGE / Qwen) can be
 * dialed in by the user via the trigger tester.
 */
export const DEFAULT_SKILL_AUTO_INJECT_THRESHOLD = 0.75;
/**
 * Built-in fallback for the strong-hint cosine-similarity floor.
 * See {@link DEFAULT_SKILL_AUTO_INJECT_THRESHOLD} for the rationale
 * on keeping this user-tunable at the call site.
 */
export const DEFAULT_SKILL_HINT_THRESHOLD = 0.55;

/** Knobs for the per-turn skill shortlist. */
export interface SkillCatalogueFilterOptions {
    /** Cap on the number of skills surfaced after retrieval ranking. */
    topK: number;
}

export interface BuildSkillSystemPromptParams {
    skillManager: SkillManager;
    /** Current user input — drives the retriever ranking. */
    query: string;
    /**
     * Embedding provider config. When `null` / `undefined` the retriever
     * runs BM25-only — the catalogue is still ranked and shortlisted,
     * just without the semantic signal. The hint / auto-inject
     * escalations only fire when embedding IS configured (they need a
     * cosine similarity on a stable scale; the retriever surfaces that
     * via {@link RetrievalResult.cosineSimilarity}).
     */
    embeddingConfig: MinimalModelConfig | null | undefined;
    /** Tunables for the shortlist. */
    filterOpts?: SkillCatalogueFilterOptions;
    /**
     * Cosine-similarity floor for the "strong skill match" hint mode.
     * Defaults to {@link DEFAULT_SKILL_HINT_THRESHOLD} when omitted.
     * Clamped to `[0, 1]` at use-site.
     */
    hintThreshold?: number;
    /**
     * Cosine-similarity floor for the auto-inject mode. Defaults to
     * {@link DEFAULT_SKILL_AUTO_INJECT_THRESHOLD} when omitted.
     * Clamped to `[0, 1]` and pulled UP to `hintThreshold` if the user
     * accidentally configures it below the hint floor — that way the
     * escalation order (plain → hint → auto-inject) stays monotonic
     * even with misconfigured settings.
     */
    autoInjectThreshold?: number;
    /** Forwarded to the embedder for user-initiated aborts. */
    signal?: AbortSignal;
}

/**
 * Compose the catalogue text prepended to the main agent's system prompt.
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

    // Resolve the escalation thresholds. Clamp to [0, 1] and force the
    // auto-inject floor to be at least the hint floor — keeps the
    // plain → hint → auto-inject escalation monotonic even if the user
    // accidentally configures auto-inject below hint.
    const hintThreshold = clamp01(params.hintThreshold ?? DEFAULT_SKILL_HINT_THRESHOLD);
    const autoInjectThreshold = Math.max(
        hintThreshold,
        clamp01(params.autoInjectThreshold ?? DEFAULT_SKILL_AUTO_INJECT_THRESHOLD),
    );

    const activeNames = skillManager.getActiveSkillNames();

    // Short / signal-poor queries don't drive a meaningful retrieval
    // ranking on either ranker (BM25 over 1–2 chars is noisy, cosine
    // even more so). Fall back to the full catalogue in those cases
    // so a "yes" / "继续" follow-up never starves the model of skills.
    if (isQueryTooShort(query)) {
        return skillManager.buildSystemPromptForSkills(enabledSkills, { activeNames });
    }

    const topK = Math.max(1, Math.floor(filterOpts?.topK ?? enabledSkills.length));

    try {
        const candidateTexts = enabledSkills.map(buildSkillEmbeddingText);
        const ranked = await retrieve(query, candidateTexts, {
            embeddingConfig: embeddingConfig ?? null,
            signal,
        });

        // ── Zero-pass fallback ─────────────────────────────────────
        // If NO ranker covered anything (BM25 found no query-term
        // overlap AND embedding unconfigured / failed) we degrade to
        // the full catalogue — better to give the model everything
        // than to silently hide skills based on a non-result. When
        // we do have a ranking, top up to `min(3, topK)` so a very
        // short ranking still leaves a workable surface area.
        let kept: typeof ranked;
        if (ranked.length === 0) {
            // No signal anywhere; fall back to the historical full
            // catalogue behaviour.
            return skillManager.buildSystemPromptForSkills(enabledSkills, { activeNames });
        } else {
            const sliced = ranked.slice(0, topK);
            const fallbackCount = Math.min(3, topK, enabledSkills.length);
            kept = sliced.length < fallbackCount
                ? ranked.slice(0, fallbackCount)
                : sliced;
        }

        // ── Diagnostics ─────────────────────────────────────────────
        // Per-skill table mirroring the tool retriever shape. Skills
        // that produced no signal (BM25-only mode + zero term overlap)
        // are appended at the bottom so the table is still complete.
        const passedIndices = new Set(kept.map(s => s.index));
        const scoredIndices = new Set(ranked.map(s => s.index));
        const scoreTable: Array<{
            name: string;
            score: number;
            bm25: number | null;
            cosine: number | null;
            passed: boolean;
        }> = ranked.map(s => ({
            name: enabledSkills[s.index]!.name,
            score: Number(s.score.toFixed(4)),
            bm25: s.bm25Score !== undefined ? Number(s.bm25Score.toFixed(4)) : null,
            cosine: s.cosineSimilarity !== undefined ? Number(s.cosineSimilarity.toFixed(4)) : null,
            passed: passedIndices.has(s.index),
        }));
        for (let i = 0; i < enabledSkills.length; i++) {
            if (scoredIndices.has(i)) continue;
            scoreTable.push({
                name: enabledSkills[i]!.name,
                score: 0,
                bm25: null,
                cosine: null,
                passed: passedIndices.has(i),
            });
        }
        console.debug(scoreTable);

        const droppedCount = enabledSkills.length - kept.length;
        const filterRate = enabledSkills.length > 0
            ? droppedCount / enabledSkills.length
            : 0;
        const mode = embeddingConfig
            ? (ranked.some(r => r.cosineSimilarity !== undefined) ? 'hybrid' : 'bm25')
            : 'bm25';
        console.debug(
            `Skill catalogue retriever: total=${enabledSkills.length} → kept ${kept.length}; ` +
            `dropped ${droppedCount} (filterRate=${(filterRate * 100).toFixed(1)}%, ` +
            `topK=${topK}, mode=${mode})`,
        );

        const shortlisted = kept.map(r => enabledSkills[r.index]!);
        const top = kept[0];
        const topSkill = top ? enabledSkills[top.index]! : null;
        // Hint / auto-inject thresholds are cosine-based. They only
        // fire when the embedding ranker actually contributed (so we
        // have a stable score scale); without embedding, the model
        // still sees the BM25-ordered catalogue but no escalation.
        const topCosine = top?.cosineSimilarity;

        // ── Mode escalation: auto-inject > hint > plain ──
        //
        // Auto-inject only when the top match is well above the hint
        // threshold AND the skill isn't already loaded in this session
        // (the [loaded] marker is enough; injecting again wastes tokens).
        // The body is prepended *above* the catalogue so the model sees
        // the procedure first; the catalogue still appears below so the
        // model knows the full skill universe and that this one is now
        // loaded.
        if (topSkill
            && topCosine !== undefined
            && topCosine >= autoInjectThreshold
            && !activeNames.has(topSkill.name)
        ) {
            const instructions = skillManager.buildSkillInstructions(topSkill.name);
            if (instructions) {
                skillManager.activateSkill(topSkill.name);
                // Refresh the snapshot so the catalogue below also tags
                // the just-injected skill as [loaded].
                const refreshedActive = skillManager.getActiveSkillNames();
                const catalogue = skillManager.buildSystemPromptForSkills(
                    shortlisted,
                    {
                        activeNames: refreshedActive,
                        headerHint: formatStrongMatchHint(topSkill.name, topCosine, true),
                    },
                );
                const banner = [
                    '## Skill Pre-Loaded For This Turn',
                    '',
                    `The user's request strongly matches the **${topSkill.name}** skill ` +
                    `(similarity ${topCosine.toFixed(2)}). Its full procedure is ` +
                    'inlined immediately below — follow it directly, no `load_skill` ' +
                    'call needed.',
                    '',
                    instructions,
                    '',
                ].join('\n');
                return `${banner}\n${catalogue}`;
            }
            // Instructions unavailable (skill was removed mid-turn?) — fall
            // through to the hint branch so we still surface the match.
        }

        if (topSkill && topCosine !== undefined && topCosine >= hintThreshold) {
            return skillManager.buildSystemPromptForSkills(shortlisted, {
                activeNames,
                headerHint: formatStrongMatchHint(topSkill.name, topCosine, false),
            });
        }

        return skillManager.buildSystemPromptForSkills(shortlisted, { activeNames });
    } catch (err) {
        // Aborts propagate through the retriever as DOMException — let
        // the surrounding prompt() flow handle them; for everything
        // else log + fall back so a broken retriever path never
        // blocks skill discovery.
        if (err instanceof DOMException && err.name === 'AbortError') {
            throw err;
        }
        console.error('SkillCatalogue: retriever failed, falling back to full catalogue', err);
        return skillManager.buildSystemPromptForSkills(enabledSkills, { activeNames });
    }
}

/**
 * Compose the text that represents a single skill in the embedding /
 * BM25 candidate space. Mirrors `buildToolEmbeddingText` in spirit —
 * combine the strongest semantic signals into one newline-separated
 * blob so cosine similarity (and BM25 term overlap) has more than
 * just a one-liner to bite on. Skill bodies are deliberately NOT
 * included: they live out-of-prompt behind `load_skill` and embedding
 * them would dilute the ranking with implementation noise.
 *
 * Includes (in order of authoring intent, which roughly mirrors signal
 * strength for the ranker):
 *   - name: the canonical identifier the model will see
 *   - description: the one-liner advertised in the catalogue
 *   - when_to_use: the natural-language trigger condition
 *   - triggers: short trigger phrases / synonyms the embedder can
 *     latch onto when the user's wording differs from the description
 *
 * Exported so the trigger-tester in the Skills settings section can
 * feed the retriever exactly the same candidate text the runtime sees
 * — guaranteeing the tester's ranking is byte-for-byte what a real
 * chat turn would produce.
 *
 * Changes to this composition invalidate the embedder's per-text
 * cache (entries are keyed by sha256(text)). That's acceptable: at
 * worst one re-embed of every skill on next use.
 */
export function buildSkillEmbeddingText(skill: SkillDefinition): string {
    const parts: string[] = [skill.name];
    if (skill.description) parts.push(skill.description);
    if (skill.whenToUse) parts.push(skill.whenToUse);
    if (skill.triggers && skill.triggers.length > 0) {
        parts.push(skill.triggers.join(', '));
    }
    return parts.filter(Boolean).join('\n');
}

/** Clamp `n` to `[0, 1]`, mapping NaN to 0. */
function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/**
 * Format the one-line header hint used by the strong-match and auto-
 * inject modes. Kept here (rather than in `SkillManager`) because the
 * exact wording is tightly coupled to the catalogue's "STEP 0" framing
 * and only the catalogue builder needs to produce it.
 */
function formatStrongMatchHint(
    name: string,
    similarity: number,
    autoInjected: boolean,
): string {
    const sim = similarity.toFixed(2);
    if (autoInjected) {
        return `> **Auto-loaded skill this turn:** \`${name}\` (similarity ${sim}). ` +
            'Its full procedure is provided above. Follow it directly without ' +
            'calling `load_skill` again.';
    }
    return `> **Strong skill match this turn:** \`${name}\` (similarity ${sim}). ` +
        'Strongly consider calling `load_skill({ "name": "' + name + '" })` ' +
        'and following its procedure before doing anything else.';
}
