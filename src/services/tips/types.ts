import type NoteAssistantPlugin from 'main';

/**
 * Minimal adapter the tip system needs from the session view. Kept as a
 * narrow interface (rather than importing `SessionView` directly) so tip
 * definitions cannot reach into view internals — they only consume what
 * is explicitly contracted here.
 */
export interface TipSessionViewAdapter {
    /** True when the currently-bound runtime is producing output. */
    isStreaming(): boolean;
    /**
     * Submit a user prompt to the active session as if the user had typed
     * it and pressed Send. Used by tips whose execute flow ends with a
     * concrete chat turn.
     */
    sendPromptForTip(text: string): Promise<void>;
    /**
     * Park a prompt in the input editor as a draft so the user can review
     * and refine before sending manually. Mirrors the "fill or refuse"
     * semantics of {@link SessionView.fillPromptDraft}: refused (returns
     * false + Notice) when the input already contains user-authored text.
     */
    fillPromptDraft(text: string): boolean;
}

/**
 * Runtime context handed to every tip predicate / preview / execute call.
 * Tips MUST treat this as read/write only where allowed by the docstring
 * on the specific method — `available`, `disqualified`, and `preview`
 * must be pure (no side effects), while `execute` is the only place
 * settings or chat may be mutated.
 */
export interface TipContext {
    plugin: NoteAssistantPlugin;
    sessionView: TipSessionViewAdapter;
}

/**
 * A single, user-visible settings change a tip will perform when the
 * user confirms "Try it". Surfaced in the preview panel so the
 * settings-mutation step never feels like a black box.
 */
export interface TipSettingsChange {
    /** Localized label for the affected setting (e.g. "Skill search paths"). */
    label: string;
    /** Optional pre-change value, omitted when adding from empty. */
    before?: string;
    /** Localized representation of the value after the change. */
    after: string;
}

/**
 * Snapshot of what `execute` is about to do, rendered into the
 * confirmation panel. All fields are display-only — modifying the
 * returned object has no effect on the actual execution.
 */
export interface TipPreview {
    /** One-sentence description of what the tip will do, in human language. */
    description: string;
    /** Settings the tip will add or change. Omit when nothing changes. */
    settingsChanges?: TipSettingsChange[];
    /** Prompt the tip will send (or park) into the AI session, if any. */
    prompt?: string;
}

/**
 * Declarative definition of an onboarding tip. Add new ones to the
 * built-in registry by exporting a definition from
 * `src/services/tips/builtin/` and listing it in `builtin/index.ts`.
 */
export interface TipDefinition {
    /**
     * Stable id, persisted in `settings.knownTipIds`. Once released this
     * MUST NOT be renamed; treat it the same way as command ids.
     */
    readonly id: string;
    /** i18n key for the popover title (sentence case, short). */
    readonly titleKey: string;
    /** i18n key for the popover body (1–3 sentences). */
    readonly bodyKey: string;

    /**
     * Whether the conditions for this tip to be useful are currently met
     * (e.g. "no skill search paths configured"). MUST be pure.
     */
    available(ctx: TipContext): boolean;

    /**
     * Disqualifying conditions — when true, the tip is hidden even if
     * `available` is true. Typically the "negation" check requested by
     * the design (e.g. "a skill path already exists" disqualifies the
     * create-first-skill tip). Kept as a separate predicate so tips can
     * express richer "show iff X and not Y" logic without nesting. MUST
     * be pure.
     */
    disqualified(ctx: TipContext): boolean;

    /**
     * Build the preview snapshot rendered in the confirmation panel.
     * MUST be pure — no settings writes, no chat dispatch.
     *
     * Optional: omit `preview` to opt out of the confirmation step
     * entirely. "Try it" will then call {@link execute} immediately.
     * Reserved for tips whose action is itself harmless and self-
     * explanatory (e.g. opening a settings panel) so the extra click
     * would feel like busywork. Tips that mutate settings or send a
     * prompt should always provide a preview.
     */
    preview?(ctx: TipContext): TipPreview;

    /**
     * Carry out the tip. Called after the user has reviewed the
     * preview and confirmed, or — when {@link preview} is omitted —
     * directly when the user clicks "Try it". May read/write
     * `plugin.settings`, call `plugin.saveSettings()`, and dispatch a
     * chat turn through the adapter. The caller is responsible for
     * marking the tip known.
     */
    execute(ctx: TipContext): Promise<void>;
}
