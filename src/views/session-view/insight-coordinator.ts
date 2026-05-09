import { Notice } from 'obsidian';
import { t } from '../../i18n';
import type { ChatMessage } from '../../services/chat-stream';
import type { InsightCard } from '../../components/session';
import {
    extractInsights,
    type ConversationInsight,
    buildInsightDeepenPrompt,
} from '../../services/insights';
import { stripStructuredBlock } from '../../services/suggestions';
import type { MinimalModelConfig } from '../../services/llm-provider';

/**
 * Shared dependencies that the insight coordinator uses to talk to the
 * rest of the session view. Kept small and explicit so the coordinator
 * can be unit-tested without instantiating a real SessionView.
 */
export interface InsightDeps {
    insightCard: InsightCard;
    isStreaming(): boolean;
    /** True once the active assistant message id has been marked aborted. */
    isAborted(messageId: string): boolean;
    /** Returns the live conversation messages (main agent only). */
    getMessages(): ReadonlyArray<ChatMessage>;
    /** Returns the summarizer config, or undefined when not available. */
    getSummarizerConfig(): MinimalModelConfig | undefined;
    /** Insight extraction is toggled by settings + a min reply length. */
    insightExtractionEnabled(): boolean;
    insightExtractionMinReplyChars(): number;
    forceScrollToBottom(): void;
    maybeScrollToBottom(): void;
    /**
     * Returns the next monotonic generation id; used to drop late callbacks
     * from a superseded extraction request.
     */
    nextGeneration(): number;
    /** Current generation id (for stale-result comparison). */
    currentGeneration(): number;
    /** Submit a full-formed prompt to the chat (used by "Deepen"). */
    submitPrompt(prompt: string): void;
    /** Fill the input editor with the prompt (used when there's an unsent draft). */
    fillInputAndFocus(prompt: string): void;
    /** True iff the input editor has unsent (non-whitespace) text. */
    hasDraft(): boolean;
}

/**
 * Coordinates the conversation-insight preview card, including automatic
 * post-reply extraction and the per-bubble "Extract insights" gesture.
 *
 * Extracted from SessionView.
 */
export class InsightCoordinator {
    constructor(private readonly deps: InsightDeps) {}

    /**
     * If the user has insight extraction enabled, run a one-shot, stateless
     * call (using the context summarizer profile) to surface candidate
     * "knowledge nuggets" as a read-only card at the tail of the
     * conversation. Phase 2: preview only — adoption to vault is gated.
     */
    async maybeShowInsightCard(): Promise<void> {
        if (!this.deps.insightExtractionEnabled()) {
            this.deps.insightCard.hide();
            return;
        }

        // Locate the most recent assistant message and the user message
        // that triggered it (skipping intermediate tool/sub-agent traffic).
        const messages = this.deps.getMessages();
        let assistant: ChatMessage | undefined;
        let user: ChatMessage | undefined;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!m) continue;
            if (!assistant) {
                if (m.role === 'assistant' && !m.streaming && m.content) {
                    if (this.deps.isAborted(m.id)) {
                        // Aborted reply: skip extraction entirely.
                        this.deps.insightCard.hide();
                        return;
                    }
                    assistant = m;
                }
                continue;
            }
            if (m.role === 'user' && m.content) {
                user = m;
                break;
            }
        }
        if (!assistant || !user) {
            this.deps.insightCard.hide();
            return;
        }

        // Threshold guard: skip very short replies to avoid token waste.
        const replyText = stripStructuredBlock(assistant.content ?? '').trim();
        const minLen = Math.max(0, this.deps.insightExtractionMinReplyChars() | 0);
        if (replyText.length < minLen) {
            this.deps.insightCard.hide();
            return;
        }

        await this.runExtraction(user, assistant, { force: false });
    }

    /**
     * Click handler for the per-bubble "Extract insights" action — a manual
     * counterpart to {@link maybeShowInsightCard}.
     *
     * Differences from the auto path:
     *   - Bypasses the `insightExtractionEnabled` toggle and the minimum
     *     reply length: this is an explicit user gesture.
     *   - Surfaces a Notice when no summarizer profile is configured (the
     *     auto path stays silent on purpose, but a manual gesture deserves
     *     visible feedback).
     *   - Pairs the assistant message with its preceding user message when
     *     one exists, falling back to an empty user prompt otherwise so
     *     the extractor still has something to anchor against.
     */
    handleExtractForMessage(assistant: ChatMessage): void {
        // Don't fight an in-flight chat turn. The action bar button doesn't
        // disable itself globally, so we guard here.
        if (this.deps.isStreaming()) {
            new Notice(t('view.cannotSwitchWhileStreaming'));
            return;
        }

        // Walk back from this assistant message to its triggering user
        // turn. We allow extraction even when no preceding user message
        // exists — the extractor handles an empty user prompt fine.
        const messages = this.deps.getMessages();
        let user: ChatMessage | undefined;
        const assistantIdx = messages.findIndex((m) => m.id === assistant.id);
        if (assistantIdx > 0) {
            for (let i = assistantIdx - 1; i >= 0; i--) {
                const m = messages[i];
                if (m && m.role === 'user' && m.content) {
                    user = m;
                    break;
                }
            }
        }

        const summarizerConfig = this.deps.getSummarizerConfig();
        if (!summarizerConfig) {
            new Notice(t('view.insightExtractionUnavailable'));
            return;
        }

        void this.runExtraction(user, assistant, { force: true });
    }

    /**
     * Click handler for the per-item "Deepen" button on the insight card.
     *
     * Sends a normal user message into the current chat session so the
     * model can use the full toolchain. The new assistant reply will
     * naturally trigger another insight-extraction pass.
     */
    handleDeepen(insight: ConversationInsight): void {
        if (this.deps.isStreaming()) return;

        const prompt = buildInsightDeepenPrompt({
            title: insight.title,
            summary: insight.summary,
            tags: insight.tags,
            linkedNotes: insight.linkedNotes,
        });

        if (this.deps.hasDraft()) {
            // Don't trash the user's in-progress message — surface the
            // generated prompt so they can decide what to do.
            this.deps.fillInputAndFocus(prompt);
            return;
        }

        this.deps.submitPrompt(prompt);
    }

    /**
     * Shared extraction pipeline used by both the automatic post-reply
     * trigger and the manual per-bubble action. Mounts the Insights block,
     * runs the one-shot LLM call, and renders the results — taking care to
     * drop stale callbacks if the user has moved on.
     */
    private async runExtraction(
        user: ChatMessage | undefined,
        assistant: ChatMessage,
        opts: { force: boolean },
    ): Promise<void> {
        const summarizerConfig = this.deps.getSummarizerConfig();
        if (!summarizerConfig) {
            // No summarizer configured (or no API key) — silently skip on
            // the auto path; the manual path validates this earlier and
            // shows a Notice, so reaching here on the manual path is rare.
            this.deps.insightCard.hide();
            return;
        }

        const messageId = assistant.id;
        const requestGen = this.deps.nextGeneration();
        const manual = opts.force;

        // Mount the loading card immediately so the user sees progress.
        // On the manual path we force-scroll so the card is guaranteed
        // visible even when the trigger was a history bubble.
        this.deps.insightCard.showLoading(messageId);
        if (manual) {
            this.deps.forceScrollToBottom();
        } else {
            this.deps.maybeScrollToBottom();
        }

        let insights: ConversationInsight[] = [];
        let failed = false;
        try {
            insights = await extractInsights(summarizerConfig, {
                userMessage: user?.content ?? '',
                assistantMessage: assistant.content ?? '',
            });
        } catch (err) {
            console.warn('[Insights] extraction failed:', err);
            failed = true;
        }

        // Drop the result if anything moved on (new turn / cleared / etc.)
        if (this.deps.currentGeneration() !== requestGen) return;
        if (this.deps.insightCard.messageId !== messageId) return;

        if (failed) {
            this.deps.insightCard.showError(messageId);
            if (manual) this.deps.forceScrollToBottom();
            return;
        }
        this.deps.insightCard.showResults(messageId, insights);
        if (manual) {
            // Always keep the card in view on the manual path (including
            // the "No insights" empty state).
            this.deps.forceScrollToBottom();
        } else if (insights.length > 0) {
            this.deps.maybeScrollToBottom();
        }
    }
}
