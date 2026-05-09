import type { App } from 'obsidian';
import type { ChatMessage } from '../../services/chat-stream';

/**
 * Shared dependency container passed to all bubble sub-modules.
 *
 * Bubble sub-modules (sub-agent badges, thinking section, tool-call detail,
 * user content, context menus, speech controller, action bar, etc.) are kept
 * as mostly-stateless pure functions that receive a `BubbleContext`. This
 * avoids threading the same 4–5 collaborators through every function's
 * signature while still making the dependency surface explicit.
 *
 * The context is constructed once by {@link BubbleRenderer} and shared by
 * reference across renders. Methods on the context proxy back into the
 * renderer so that lifecycle hooks (e.g. `register` for cleanup) stay
 * attached to the owning `Component`.
 */
export interface BubbleContext {
    /** Obsidian app instance — used for vault lookups, markdown rendering, workspace ops. */
    readonly app: App;

    /**
     * Called by sub-modules after they add/mutate content so the host view
     * can keep the chat scrolled to the latest message when appropriate.
     */
    onScrollNeeded(): void;

    /**
     * Lazily-created positioned layer that sub-modules should mount floating
     * UI (dropdowns, popovers) into. The layer acts as the containing block
     * for `position: absolute`, insulating anchored popups from ancestor
     * `transform`/`filter`/`contain` that would otherwise hijack
     * `position: fixed`.
     */
    getFloatingLayer(): HTMLElement;

    /**
     * Proxies `Component.register` on the owning `BubbleRenderer` so
     * sub-modules can attach teardown callbacks that run when the renderer
     * unloads (e.g. closing open dropdowns, removing document-level
     * listeners).
     */
    register(cb: () => void): void;

    /**
     * Optional host callback fired when the user triggers "Extract insights"
     * on an assistant reply. Absent when the host hasn't opted into the
     * feature — the action bar should simply omit the button in that case.
     */
    readonly onExtractInsights?: (msg: ChatMessage) => void;
}
