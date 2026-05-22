import { App, Modal } from 'obsidian';

/**
 * Base class for modals that expose their outcome through a single
 * Promise returned by {@link waitForResult}.
 *
 * The pattern this class replaces was repeated almost verbatim across
 * every confirm / picker modal in this plugin:
 *
 *     private resultResolver: ((r: T) => void) | null = null;
 *     private resolved = false;
 *     waitForResult(): Promise<T> {
 *         return new Promise(r => { this.resultResolver = r; this.open(); });
 *     }
 *     private resolve(v: T) { if (this.resolved) return; ... }
 *     onClose() { this.resolve(<cancel value>); ... }
 *
 * Subclass contract:
 *  - Build the UI in {@link onOpen}; call {@link resolve} (then usually
 *    {@link close}) when the user confirms.
 *  - Implement {@link cancelValue} to provide the value forwarded when
 *    the modal is dismissed without an explicit confirmation (Esc /
 *    outside-click / programmatic `close()`).
 *  - If you override {@link onClose} for your own DOM teardown, call
 *    `super.onClose()` FIRST so the cancel-on-dismiss guard fires
 *    before contentEl is wiped.
 *
 * Resolution semantics:
 *  - {@link resolve} is idempotent: only the first call wins. This is
 *    what makes "click Confirm → close() → onClose() → resolve(cancel)"
 *    safe without a separate guard in every subclass.
 *  - Calling {@link waitForResult} more than once is not supported; the
 *    second call would race with the first promise's lifecycle. Create a
 *    new modal instance per interaction (which is what every existing
 *    call site already does).
 */
export abstract class PromiseModal<T> extends Modal {
    private resultResolver: ((value: T) => void) | null = null;
    private resolved = false;

    constructor(app: App) {
        super(app);
    }

    /** Opens the modal and resolves with the user's choice (or the cancel value). */
    waitForResult(): Promise<T> {
        return new Promise<T>((resolve) => {
            this.resultResolver = resolve;
            this.open();
        });
    }

    /**
     * Idempotently resolve the modal's promise. Safe to call from any
     * confirm-button handler and from {@link onClose}; subsequent calls
     * are no-ops and the first value wins.
     */
    protected resolve(value: T): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resultResolver?.(value);
        this.resultResolver = null;
    }

    /** Whether {@link resolve} has already been called. */
    protected get isResolved(): boolean {
        return this.resolved;
    }

    /**
     * Value to resolve with when the modal is dismissed without an
     * explicit confirmation (Esc / outside-click / programmatic close).
     */
    protected abstract cancelValue(): T;

    /**
     * Default close handler: forwards the cancel value to any unresolved
     * promise. Subclasses overriding this MUST call `super.onClose()`
     * so the cancel-on-dismiss guard still fires.
     */
    onClose(): void {
        this.resolve(this.cancelValue());
    }
}
