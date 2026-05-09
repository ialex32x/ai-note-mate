/**
 * Types for the "follow-up suggestions" feature.
 *
 * When an assistant message ends with a set of proposed next actions
 * (e.g. "Would you like me to A / B / C?"), we extract those actions
 * and render them as one-shot quick-pick buttons after the message,
 * so that the user does not have to re-type them.
 */

/** One actionable follow-up extracted from an assistant message. */
export interface SuggestedAction {
    /** Short button label to show in the UI (truncated). */
    label: string;
    /** Full prompt that will be sent / prefilled on click. */
    prompt: string;
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
