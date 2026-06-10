import { setIcon, Notice } from 'obsidian';
import { t } from '../../i18n';
import { optimizePrompt, PromptOptimizationError } from '../../services/prompt-optimizer';
import { findTailTurn } from '../../services/turn-utils';
import { isAbortError } from '../../utils/abortable-request';
import { createSummarizerConfig } from '../../services/chat-factory';
import type { ChatMessage } from '../../services/chat-stream';
import type { CMInput } from '../../components/cm-input';
import type { DraftInputController } from '../../components/session';
import type NoteAssistantPlugin from 'main';

export interface SessionPromptOptimizerDeps {
    cmInput: CMInput;
    optimizeBtn: HTMLButtonElement;
    /** Whether the attached runtime is currently streaming. */
    isStreaming: () => boolean;
    draftController: DraftInputController;
    /** Messages from the active chat agent (for tail-turn disambiguation). */
    getChatMessages: () => readonly ChatMessage[];
    plugin: NoteAssistantPlugin;
}

/**
 * Owns the "Refine prompt" button lifecycle for a {@link SessionView}.
 * Extracted from session-view.ts so the three tightly-coupled methods
 * (`handleOptimizePrompt`, `abortInFlightOptimize`, `updateAvailability`)
 * live in a dedicated controller with a well-defined Deps interface.
 */
export class SessionPromptOptimizer {
    private abortController: AbortController | null = null;

    constructor(private readonly deps: SessionPromptOptimizerDeps) {}

    // ── Public API ───────────────────────────────────────────────────────

    /** Click handler wired to the toolbar s Refine prompt s button. */
    handleClick = (): void => {
        void this.run();
    };

    /**
     * Cancel any in-flight prompt-refinement request and reset the
     * button's busy visuals immediately.
     *
     * Called from every code path that invalidates the refinement's
     * target draft — view close, session switch, and "send now" —
     * so the LLM tokens aren't spent on a result we'd just discard.
     */
    abort(): void {
        const controller = this.abortController;
        if (!controller) return;
        this.abortController = null;
        controller.abort();
        this.resetButtonVisuals();
        this.updateAvailability();
    }

    /**
     * Recompute whether the "Refine prompt" button should be clickable.
     *
     * Disabled when ANY of:
     *   - the draft is empty / whitespace-only,
     *   - a turn is currently streaming,
     *   - a refinement call is already in flight.
     *
     * Cheap enough to call on every keystroke + every lock change.
     */
    updateAvailability(): void {
        const btn = this.deps.optimizeBtn;
        if (!btn) return;
        const busy = this.abortController !== null;
        const empty = this.deps.cmInput.getContent().trim().length === 0;
        const locked = this.deps.isStreaming();
        btn.disabled = busy || empty || locked;
    }

    // ── Internals ────────────────────────────────────────────────────────

    private resetButtonVisuals(): void {
        const btn = this.deps.optimizeBtn;
        btn.removeClass('is-busy');
        setIcon(btn, 'wand-sparkles');
    }

    /**
     * Pipeline:
     *   1. Validate the draft is non-empty and no other refinement is
     *      already running.
     *   2. Resolve the summarizer model config.
     *   3. Locate the most recent completed assistant turn for
     *      disambiguation context.
     *   4. Issue the one-shot LLM call. The button enters a "busy"
     *      visual state until the call resolves.
     *   5. On success, replace the draft with the refined text and
     *      persist through the draft controller.
     */
    private async run(): Promise<void> {
        const draft = this.deps.cmInput.getContent().trim();
        if (!draft) return;
        if (this.deps.isStreaming()) {
            new Notice(t('view.sessionBusy'));
            return;
        }
        if (this.abortController) return;

        const modelConfig = createSummarizerConfig(this.deps.plugin);
        if (!modelConfig) {
            new Notice(t('view.optimizePromptUnavailable'));
            return;
        }

        const { user, assistant } = findTailTurn(this.deps.getChatMessages());
        const userMessage = (user?.content ?? '').trim();
        const assistantReply = (assistant?.content ?? '').trim();

        const controller = new AbortController();
        this.abortController = controller;
        setIcon(this.deps.optimizeBtn, 'loader-2');
        this.deps.optimizeBtn.addClass('is-busy');
        this.updateAvailability();

        try {
            const refined = await optimizePrompt(
                modelConfig,
                { draft, userMessage, assistantReply },
                controller.signal,
            );
            // Only apply the result when the draft hasn't changed
            // underneath us during the call.
            const currentDraft = this.deps.cmInput.getContent().trim();
            if (currentDraft !== draft) return;

            this.deps.cmInput.setContent(refined);
            this.deps.cmInput.focus();
            this.deps.draftController.scheduleSave();
        } catch (err) {
            if (isAbortError(err)) {
                // Silent — caller-initiated cancellation needs no notice.
                return;
            }
            if (err instanceof PromptOptimizationError) {
                new Notice(t('view.optimizePromptFailed'));
                return;
            }
            console.warn('[PromptOptimizer] refinement failed:', err);
            new Notice(t('view.optimizePromptFailed'));
        } finally {
            // Identity guard — `abort()` (view close / session switch /
            // send) may have already nulled the field on our behalf.
            if (this.abortController === controller) {
                this.abortController = null;
                this.resetButtonVisuals();
                this.updateAvailability();
            }
        }
    }
}
