import NoteAssistantPlugin from 'main';
import { IChatAgent } from '../../services/chat-stream';
import { getActiveProfile } from '../../settings';
import {
    createSummarizerConfig,
    createEmbeddingConfig,
    createToolFilterOptions,
    createProviderForActiveProfileOf,
} from '../../services/chat-factory';
import { CMInput } from '../../components/cm-input';
import { DraftInputController } from '../../components/session';
import { SessionPromptOptimizer } from './session-prompt-optimizer';
import { ScrollController } from './scroll-controller';
import { BubbleListController } from './bubble-list-controller';
import { SessionRuntimeBinder } from './session-runtime-binder';

export interface SendHandlerDeps {
    plugin: NoteAssistantPlugin;
    cmInput: CMInput;
    draftController: DraftInputController;
    promptOptimizer: SessionPromptOptimizer;
    scroller: ScrollController;
    bubbleList: BubbleListController;
    runtimeBinder: SessionRuntimeBinder;
    getStreaming: () => boolean;
    getChat: () => IChatAgent | undefined;
}

/**
 * Owns the user-message send pipeline: the send/stop button handler,
 * the shared `sendPrompt` wrapper that injects per-turn options, and
 * the post-abort idle wait used by edit/truncate flows.
 */
export class SendHandler {
    private readonly deps: SendHandlerDeps;

    constructor(deps: SendHandlerDeps) {
        this.deps = deps;
    }

    /**
     * Wait until the active runtime's chat turn finishes (idle), or
     * until `timeoutMs` elapses. Used after {@link IChatAgent.abort}
     * so follow-up mutations (edit / truncate) don't race the epilogue.
     */
    waitForChatIdle(timeoutMs = 10_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        return new Promise(resolve => {
            const tick = () => {
                if (!this.deps.getStreaming()) {
                    resolve(true);
                    return;
                }
                if (Date.now() >= deadline) {
                    resolve(false);
                    return;
                }
                window.setTimeout(tick, 50);
            };
            tick();
        });
    }

    async handleSend(): Promise<void> {
        const text = this.deps.cmInput.getContent().trim();

        if (this.deps.getStreaming()) {
            // Pressing the stop button should also kill any refinement
            // running on the side — the user clearly wants the chat
            // engine to wind down, and a stale refinement coming back
            // afterwards would write into an already-cleared draft.
            this.deps.promptOptimizer.abort();
            this.deps.getChat()?.abort();
            return;
        }

        if (!text) return;

        // A user clicking send has made up their mind about the draft
        // they want to ship — anything coming back from an in-flight
        // refinement would be applied to an empty input (post-clear)
        // or, worse, the next turn's draft. Cancel before we clear.
        this.deps.promptOptimizer.abort();

        this.deps.cmInput.clear();

        // Clear draft input since message is being sent
        this.deps.draftController.clearDraft();

        await this.sendPrompt(text);
    }

    /**
     * Send a user prompt to the active runtime's chat agent. Thin wrapper
     * around `chat.prompt(text, ...)` that injects the per-turn options
     * shared by every entry point that submits a user message — the
     * primary input box (`handleSend`), follow-up suggestion clicks, and
     * the inline "continue" button on the tail error bubble.
     *
     * Does NOT touch `cmInput` or the draft controller — those are
     * responsibilities of input-bound entry points like `handleSend`.
     * Also does NOT guard against `isStreaming`; callers that have
     * abort-on-streaming semantics (e.g. the send button) must handle
     * that themselves before calling.
     *
     * The user bubble is rendered from inside chat.prompt()'s
     * synchronous onUserMessage callback so it can be keyed by the
     * agent's real message id (not a separately-minted optimistic
     * id). This is what keeps the message branch-able afterwards —
     * SessionManager.branchSession looks up the anchor by id in the
     * agent's own message cache. See chat-stream.ts: IChatAgent.prompt.
     */
    async sendPrompt(text: string): Promise<void> {
        await this.deps.runtimeBinder.ensureRuntimeAttached().chat.prompt(text, {
            allowedCapabilities: this.deps.plugin.settings.allowedCapabilities,
            provider: createProviderForActiveProfileOf(this.deps.plugin),
            // Pull thinkingLevel from the active profile. Older profiles
            // saved before this field existed leave it `undefined`, which
            // the providers treat the same as "auto" (param omitted).
            thinkingLevel: getActiveProfile(this.deps.plugin.settings).thinkingLevel,
            summarizer: createSummarizerConfig(this.deps.plugin),
            embedding: createEmbeddingConfig(this.deps.plugin),
            embeddingFilter: createToolFilterOptions(this.deps.plugin),
            onUserMessage: (msg) => {
                this.deps.bubbleList.append(msg);
                this.deps.bubbleList.refreshJumpButtonsForPrevTurn(msg);
                this.deps.scroller.forceScrollToBottom();
            },
        });
    }
}
