/**
 * Types for the "follow-up suggestions" feature.
 *
 * When an assistant message ends with a set of proposed next actions
 * (e.g. "Would you like me to A / B / C?"), we extract those actions
 * and render them as one-shot quick-pick buttons after the message,
 * so that the user does not have to re-type them.
 */

/**
 * A client-side action attached to a suggestion. When present, picking the
 * suggestion executes this action directly (e.g. opening a note) instead of
 * round-tripping through the LLM via `prompt`. The `prompt` field is still
 * required as a fallback for when the action cannot be carried out (e.g.
 * the target note no longer exists in the vault).
 *
 * Keep this as a discriminated union so additional kinds (reveal-in-finder,
 * run-command, ...) can be added later without breaking existing callers.
 */
export type SuggestedClientAction =
    | {
          kind: 'open-note';
          /**
           * Vault-relative path or linkpath of the note to open. May be a
           * bare basename ("Project plan"), with or without ".md", or a
           * subfolder path. Resolved at click time via the metadata cache;
           * if resolution fails we fall back to sending `prompt`.
           */
          path: string;
      };

/** One actionable follow-up extracted from an assistant message. */
export interface SuggestedAction {
    /** Short button label to show in the UI (truncated). */
    label: string;
    /** Full prompt that will be sent / prefilled on click. */
    prompt: string;
    /**
     * Optional client-side action. When set, the host should attempt this
     * first and only fall back to sending `prompt` when execution fails.
     */
    action?: SuggestedClientAction;
}

/** Options passed to the extractor. */
export interface ExtractOptions {
    /** Whether to try parsing the structured `<!--suggestions ... -->` block. */
    allowStructured: boolean;
    /** Max number of actions returned. */
    limit?: number;
    /** Max length of each label. */
    labelMaxLength?: number;
}

/**
 * Runtime-owned state for the follow-up suggestion bar, persisted into
 * session metadata so the bar survives plugin reload and session
 * switching. Mirrors {@link InsightCardState} from the insights module.
 */
export type SuggestionCardPhase = 'loading' | 'results' | 'empty' | 'error';

export interface SuggestionCardState {
    /** Assistant message id this state is anchored to. */
    messageId: string;
    phase: SuggestionCardPhase;
    suggestions: SuggestedAction[];
    /** Whether extraction was auto (on-finish) or manual (future use). */
    cause: 'auto' | 'manual';
}
