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

/** Options for {@link extractInsights}. */
export interface ExtractInsightsOptions {
    /** Upper bound on the number of insights returned. Defaults to 3. */
    limit?: number;
    /** Hard ceiling on characters fed to the extractor. Defaults to 8000. */
    maxInputChars?: number;
}
