/**
 * Types for the "conversation insight extraction" feature (direction C,
 * phase 1 + 2).
 *
 * After an assistant message finishes streaming, we optionally run a
 * one-shot, stateless LLM call against a cheap summarizer profile to
 * extract candidate "insight" cards — short, reusable nuggets that the
 * user could sediment into their vault as standalone notes.
 *
 * Phase 2 only previews these cards at the tail of the conversation
 * (read-only; the "adopt" button is disabled with a "coming soon"
 * tooltip). Phase 3 will handle actual persistence into the vault.
 */

/** A single candidate knowledge nugget extracted from one user/assistant turn. */
export interface ConversationInsight {
    /** Short, human-readable concept name (<= ~30 chars recommended). */
    title: string;
    /**
     * One or two sentences capturing the essence of the concept in the
     * user's own language. Kept short on purpose; the full explanation
     * still lives in the assistant reply.
     */
    summary: string;
    /** Zero or more short tag keywords (lowercased, no `#` prefix). */
    tags: string[];
    /**
     * Zero or more wiki-link-style note titles that the assistant's
     * reply explicitly referenced. Used later (phase 3) to suggest
     * back-links from the new note. Never invented by the extractor.
     */
    linkedNotes: string[];
}

/** Input bundle passed to the extractor. */
export interface ExtractInsightsInput {
    /**
     * The raw text of the latest user message (markdown, may include
     * file references). Used as the "question" side of the turn.
     */
    userMessage: string;
    /**
     * The final assistant reply for this turn (markdown). Structured
     * follow-up blocks should already be stripped by the caller.
     */
    assistantMessage: string;
}

/**
 * Phase of the insight card lifecycle for a given assistant turn.
 *
 * - `loading`: extraction is in flight. Never persisted (transient).
 * - `results`: extraction returned at least one insight.
 * - `empty`: extraction completed but produced no insights.
 * - `error`: extraction failed (network / parse error / no summarizer).
 */
export type InsightCardPhase = 'loading' | 'results' | 'empty' | 'error';

/**
 * Session-level state of the insight preview card, owned by the
 * SessionRuntime and persisted (sans `loading` phase) into the session
 * metadata so that switching away and back, or reloading the plugin,
 * does not lose previously-extracted insights — mirroring the way
 * unsent draft input is preserved at the session level.
 *
 * Bound to a specific assistant `messageId` so the view can detect
 * staleness on replay (i.e. the persisted state belongs to an older
 * turn that's no longer the tail of the conversation).
 */
export interface InsightCardState {
    messageId: string;
    phase: InsightCardPhase;
    /**
     * Insight entries. Only meaningful when `phase === 'results'`; an
     * empty array for any other phase. Kept on the union shape rather
     * than hidden behind a discriminator so consumers don't have to
     * narrow before reading the length.
     */
    insights: ConversationInsight[];
    /**
     * Why this extraction was triggered. The view uses this to decide
     * between gentle (`auto`, respect user scroll) and assertive
     * (`manual`, always scroll the card into view) feedback. Persisted
     * forms always carry `'auto'` after a reload — the manual gesture
     * is, by definition, in the past.
     */
    cause: 'auto' | 'manual';
}

/** Options for {@link extractInsights}. */
export interface ExtractInsightsOptions {
    /** Upper bound on the number of insights returned. Defaults to 3. */
    limit?: number;
    /** Hard ceiling on characters fed to the extractor. Defaults to 8000. */
    maxInputChars?: number;
    /**
     * Optional whitelist of tags that already exist in the user's vault
     * (bare form, without a leading '#'). When provided the extractor
     * instructs the model to pick tags EXCLUSIVELY from this list and
     * post-filters any stray invention. When omitted, tagging falls back
     * to free-form generation.
     */
    availableTags?: ReadonlyArray<string>;
}
