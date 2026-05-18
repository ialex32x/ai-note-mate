/**
 * Build the skills catalogue snippet that gets prepended to the main
 * agent's system prompt for a given user turn.
 *
 * Three escalating modes, picked transparently per turn:
 *
 *   - **Auto-inject** (top-1 similarity ≥ {@link SKILL_AUTO_INJECT_THRESHOLD}):
 *     the full body of the top-matched skill is injected inline (above
 *     the catalogue). The model can follow it directly — no `load_skill`
 *     round trip needed. The skill is marked active so subsequent turns
 *     in the same session don't re-inject it.
 *
 *   - **Strong hint** (top-1 similarity ≥ {@link SKILL_HINT_THRESHOLD}):
 *     the catalogue gets a one-line directive at the top naming the
 *     best match, but the full body stays out of context. Saves tokens
 *     vs. auto-inject while still concentrating the model's attention.
 *
 *   - **Plain shortlist**: the catalogue lists the top-K matching skills
 *     (and falls back to the best few when the threshold filters
 *     everyone out), without any extra steering. This is the historical
 *     behaviour.
 *
 * **Fallback path**: when embedding is not configured, the query is too
 * short, the embedder hasn't been initialized, or the embedding call
 * throws — return the full enabled-skill catalogue. This matches the
 * pre-embedding behaviour exactly, so a misconfigured embedding setup
 * can never *reduce* what the model can discover.
 *
 * Active-skill tracking ({@link SkillManager.getActiveSkillNames}) is
 * woven through every mode: skills whose body is already in context are
 * rendered with `[loaded]` so the model knows to reuse them. The set is
 * cleared by ChatStream's `onContextCompressed` hook so post-compression
 * the catalogue can re-trigger them again.
 */

import { findSimilar, isQueryTooShort } from '../services/text-embedding';
import { getGlobalEmbedder } from '../services/embedder';
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

    // ── Decide whether to shortlist or hand back the full catalogue ──
    //
    // Each of these branches is a "no embedding-based filtering" case;
    // the user-visible behaviour matches the pre-embedding implementation
    // exactly (modulo the new active-skill `[loaded]` marker, which is
    // additive and always safe to render).
    if (!embeddingConfig) {
        return skillManager.buildSystemPromptForSkills(enabledSkills, { activeNames });
    }
    if (isQueryTooShort(query)) {
        return skillManager.buildSystemPromptForSkills(enabledSkills, { activeNames });
    }
    const embedder = getGlobalEmbedder();
    if (!embedder) {
        console.warn('SkillCatalogue: global embedder not initialized, falling back to full catalogue');
        return skillManager.buildSystemPromptForSkills(enabledSkills, { activeNames });
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

        const droppedCount = enabledSkills.length - kept.length;
        const filterRate = enabledSkills.length > 0
            ? droppedCount / enabledSkills.length
            : 0;
        console.debug(
            `Skill catalogue filter: total=${enabledSkills.length} → kept ${kept.length}; ` +
            `dropped ${droppedCount} (filterRate=${(filterRate * 100).toFixed(1)}%, ` +
            `threshold=${similarityThreshold}, topK=${topK})`,
        );

        const shortlisted = kept.map(r => enabledSkills[r.index]!);
        const top = kept[0];
        const topSkill = top ? enabledSkills[top.index]! : null;
        const topSimilarity = top?.similarity ?? 0;

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
            && topSimilarity >= autoInjectThreshold
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
                        headerHint: formatStrongMatchHint(topSkill.name, topSimilarity, true),
                    },
                );
                const banner = [
                    '## Skill Pre-Loaded For This Turn',
                    '',
                    `The user's request strongly matches the **${topSkill.name}** skill ` +
                    `(similarity ${topSimilarity.toFixed(2)}). Its full procedure is ` +
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

        if (topSkill && topSimilarity >= hintThreshold) {
            return skillManager.buildSystemPromptForSkills(shortlisted, {
                activeNames,
                headerHint: formatStrongMatchHint(topSkill.name, topSimilarity, false),
            });
        }

        return skillManager.buildSystemPromptForSkills(shortlisted, { activeNames });
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
        return skillManager.buildSystemPromptForSkills(enabledSkills, { activeNames });
    }
}

/**
 * Compose the text that represents a single skill in the embedding
 * space. Mirrors `buildToolEmbeddingText` in spirit — combine the
 * strongest semantic signals into one newline-separated blob so cosine
 * similarity has more than just a one-liner to bite on. Skill bodies
 * are deliberately NOT included: they live out-of-prompt behind
 * `load_skill` and embedding them would dilute the ranking with
 * implementation noise.
 *
 * Includes (in order of authoring intent, which roughly mirrors signal
 * strength for the ranker):
 *   - name: the canonical identifier the model will see
 *   - description: the one-liner advertised in the catalogue
 *   - when_to_use: the natural-language trigger condition
 *   - triggers: short trigger phrases / synonyms the embedder can
 *     latch onto when the user's wording differs from the description
 *
 * Changes to this composition invalidate the embedder's per-text
 * cache (entries are keyed by sha256(text)). That's acceptable: at
 * worst one re-embed of every skill on next use.
 */
function buildSkillEmbeddingText(skill: SkillDefinition): string {
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
