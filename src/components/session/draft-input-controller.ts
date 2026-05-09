import type { SessionManager } from '../../session-manager';

/**
 * Manages debounced draft input saving/restoring for the session view.
 * Extracted from SessionView to reduce its complexity.
 */
export class DraftInputController {
    private timer: number | null = null;
    private lastSavedDraft: string = '';

    private static readonly DEFAULT_DELAY = 20000;

    constructor(
        private sessionManager: SessionManager,
        private getContent: () => string,
        private setContent: (value: string) => void,
        private delayMs: number = DraftInputController.DEFAULT_DELAY,
    ) {}

    /** Schedule a debounced draft save (called on input change) */
    scheduleSave(): void {
        this.clearTimer();
        this.timer = window.setTimeout(() => {
            this.save();
        }, this.delayMs);
    }

    /** Save draft immediately and clear timer (called before session switch) */
    async flush(): Promise<void> {
        this.clearTimer();
        await this.save();
    }

    /** Clear the draft save timer without saving */
    clearTimer(): void {
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /** Clear timer and reset internal state (called during session switch cleanup) */
    reset(): void {
        this.clearTimer();
        this.lastSavedDraft = '';
    }

    /** Restore draft input from session metadata */
    restore(): void {
        const draft = this.sessionManager.getDraftInput();
        if (draft) {
            this.setContent(draft);
            this.lastSavedDraft = draft;
        } else {
            this.lastSavedDraft = '';
        }
    }

    /** Clear draft completely (called when message is sent) */
    clearDraft(): void {
        this.clearTimer();
        this.lastSavedDraft = '';
        this.sessionManager.setDraftInput('');
    }

    /** Save draft input if it differs from last saved value */
    private async save(): Promise<void> {
        const currentDraft = this.getContent();
        if (currentDraft === this.lastSavedDraft) {
            return;
        }
        this.lastSavedDraft = currentDraft;
        this.sessionManager.setDraftInput(currentDraft);
        await this.sessionManager.saveMetadata();
    }
}
