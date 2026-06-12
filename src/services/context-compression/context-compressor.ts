import type { ChatMessageRole, MinimalModelConfig } from "../llm-provider";
import type { ArtifactStore } from "../artifact-store";

import {
    type HistoryMessage,
    type ContextCompressionOptions,
    type ContextCompressionResult,
    type ConversationSummary,
    type PromptConfig,
} from "./types";
import {
    DEFAULT_COMPRESSION_THRESHOLD_FALLBACK,
    COMPRESSION_WINDOW_FRACTION,
    ESTIMATED_TO_REAL_RATIO,
    DEFAULT_SLIDING_WINDOW_SIZE,
    DEFAULT_MAX_SUMMARIES_THRESHOLD,
} from "./constants";
import { estimateTokens, estimateMessagesTokens, isValidBudgetHint } from "./token-estimation";
import { shrinkToolResultContent } from "./envelope-shrink";
import { ensureToolSequenceIntegrity as _ensureToolSequenceIntegrity, toolResultRunEnd as _toolResultRunEnd } from "./tool-sequence";
import { validateAndSanitizeForLLM as _validateAndSanitizeForLLM } from "./validate";
import { collapseToolMessagesForSummary } from "./tool-collapse";
import { summarizeConversation } from "./summarizer";

export class ContextCompressor {
    /**
     * Build the message list to send to the LLM with hierarchical context compression.
     *
     * Key design:
     * - The original `rawMessages` is NEVER modified. It's used for UI display only.
     * - Summaries are stored separately and passed in via `existingSummaries`.
     * - Each summary tracks `lastMessageIndex` — the position in rawMessages where
     *   summarization stopped. Only messages AFTER this index are eligible for new summaries.
     *
     * @param rawMessages - Complete original messages (for UI display, not modified)
     * @param existingSummaries - Previously generated summaries (stored externally)
     * @returns Messages to send to LLM, plus any new summary that should be persisted
     */
    static async compress<T extends HistoryMessage>(
        modelConfig: MinimalModelConfig,
        prompt: PromptConfig,
        rawMessages: T[],
        existingSummaries: ConversationSummary[] = [],
        options?: ContextCompressionOptions,
        signal?: AbortSignal,
        onSummarizing?: () => void,
    ): Promise<ContextCompressionResult<T>> {
        // ── 0. Resolve effective tunables ─────────────────────────────────
        // Each option follows the "<=0 = use built-in default" convention so
        // the on-disk profile shape stays trivial (0 means "I don't care").

        // 0a. Model context window — must be resolved FIRST because the
        // default compression threshold is now computed as a fraction of
        // the model window rather than using a fixed value.
        const modelContextWindow = options?.modelContextWindow && options.modelContextWindow > 0
            ? options.modelContextWindow
            : 0;

        // 0b. Compression threshold. When the user hasn't set an explicit
        // value (<=0), compute a default proportional to the model's context
        // window. Falls back to a fixed safe floor when the window is unknown.
        const threshold = (options?.compressionThreshold && options.compressionThreshold > 0)
            ? options.compressionThreshold
            : modelContextWindow > 0
                ? Math.round(modelContextWindow * COMPRESSION_WINDOW_FRACTION / ESTIMATED_TO_REAL_RATIO)
                : DEFAULT_COMPRESSION_THRESHOLD_FALLBACK;

        const windowSize = (options?.slidingWindowSize && options.slidingWindowSize > 0)
            ? options.slidingWindowSize
            : DEFAULT_SLIDING_WINDOW_SIZE;
        const maxSummaries = (options?.maxSummariesThreshold && options.maxSummariesThreshold > 0)
            ? options.maxSummariesThreshold
            : DEFAULT_MAX_SUMMARIES_THRESHOLD;
        const accessoryTokens = options?.accessoryTokens && options.accessoryTokens > 0
            ? options.accessoryTokens
            : 0;
        // B-1: artifact store, when provided, lets the shrink stage spill
        // historical envelope `result` / `extras` into out-of-prompt
        // storage. `null` is treated identically to `undefined` —
        // disables spilling, falls back to the legacy generic truncation.
        const artifactStore = options?.artifactStore ?? null;

        // ── 1. Separate system messages (always preserved) ────────────────
        const systemMessages = rawMessages.filter(msg => msg.role === "system");
        const nonSystemMessages = rawMessages.filter(msg => msg.role !== "system");

        // ── 2. Find the starting point for new summarization ────────────
        // Only summarize messages that haven't been summarized yet.
        //
        // Primary anchor: the `messageId` recorded on the most-recent summary.
        // This is stable even if the message array is rebuilt (e.g. after a
        // session reload with newly-materialized tool_result messages that
        // shift positional indices). The old `lastMessageIndex` is kept as a
        // fallback for (a) summaries produced before `messageId` was
        // populated, and (b) defensive recovery when the id can no longer be
        // located (user deleted messages mid-conversation, etc.).
        let cutoffIndex = 0;
        if (existingSummaries.length > 0) {
            const lastSummary = existingSummaries.reduce(
                (a, b) => (a.lastMessageIndex >= b.lastMessageIndex ? a : b),
            );
            const anchorId = lastSummary.messageId;
            let resolvedByID = -1;
            if (anchorId) {
                const idx = nonSystemMessages.findIndex(m => m.id === anchorId);
                if (idx >= 0) {
                    // `lastMessageIndex` represents the first UN-summarized
                    // position; the anchor message IS summarized, so the new
                    // cutoff is one past it.
                    resolvedByID = idx + 1;
                }
            }
            if (resolvedByID >= 0) {
                cutoffIndex = resolvedByID;
                if (resolvedByID !== lastSummary.lastMessageIndex) {
                    console.debug("[ContextCompressor] cutoff anchored by id (", anchorId,
                        ") →", resolvedByID, "(recorded index was", lastSummary.lastMessageIndex, ")");
                }
            } else {
                cutoffIndex = Math.max(...existingSummaries.map(s => s.lastMessageIndex));
                if (anchorId) {
                    console.warn("[ContextCompressor] cutoff anchor id", anchorId,
                        "not found; falling back to recorded index", cutoffIndex);
                }
            }
            // Defensive clamp: the recorded index may point past the current
            // array length if messages were pruned externally.
            if (cutoffIndex > nonSystemMessages.length) cutoffIndex = nonSystemMessages.length;
            if (cutoffIndex < 0) cutoffIndex = 0;
        }

        // Get only the non-system messages that are AFTER the cutoff
        const unsummarizedMessages = nonSystemMessages.slice(cutoffIndex);

        // Snap + shrink the tail the same way we will when building messagesToSend,
        // so the threshold check matches the real provider payload (not the full
        // tool_result bodies kept in raw history for UI / summarizer fidelity).
        const snappedForBudget = existingSummaries.length > 0
            ? ContextCompressor.sliceFromNextTurnBoundary(unsummarizedMessages)
            : unsummarizedMessages;
        const shrunkTailForBudget = ContextCompressor.shrinkLargeToolResults(snappedForBudget, artifactStore);

        // ── 3. Estimate tokens ─────────────────────────────────────────────
        const systemTokens = estimateMessagesTokens(systemMessages);
        const unsummarizedTokens = estimateMessagesTokens(shrunkTailForBudget);
        const summaryTokens = existingSummaries.reduce((sum, s) => sum + estimateTokens(s.content), 0);

        // ── 4. Decide whether compression is needed ───────────────────────
        // The threshold is checked against an **approximation of the real
        // payload** sent to the LLM:
        //   - system messages (prompt + skills, persistent overhead)
        //   - the unsummarized tail after shrink (see shrunkTailForBudget above)
        //   - existing summaries (assistant messages we will replay)
        //   - accessoryTokens supplied by the caller, typically the JSON
        //     size of tool schemas which never enter `rawMessages`.
        // Without `systemTokens + accessoryTokens` the threshold drifts
        // from what the provider actually receives and we either compress
        // way too late (small windows) or way too eagerly (large windows).
        const effectiveTokens = systemTokens + unsummarizedTokens + summaryTokens + accessoryTokens;

        // Two independent triggers:
        //   - `overThreshold`  → the conversation is genuinely large enough
        //                        that we should fold older history into a
        //                        Level-1 summary;
        //   - `needsLevel2`    → summaries themselves have piled up to the
        //                        point that the next compression pass should
        //                        merge them into a Level-2+ summary instead
        //                        of producing yet another peer Level-1 entry.
        // Previously `needsLevel2` was only inspected when `overThreshold`
        // was already true, which meant a long-running session with a large
        // threshold could accumulate dozens of Level-1 summaries forever
        // without ever triggering Level-2. Splitting the two conditions
        // here fixes that slow leak.
        const overThreshold = effectiveTokens > threshold;
        const needsLevel2 = existingSummaries.length >= maxSummaries;

        if (!overThreshold && !needsLevel2) {
            // console.log(`ContextCompressor: No compression needed (effective tokens: ${effectiveTokens}, threshold: ${threshold})`);
            // No new compression needed - send summaries + unsummarized messages
            // (skip the raw messages that are already covered by existing summaries)
            const summaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));

            // Build archive note if there are summaries (meaning some messages are archived)
            const archiveNoteMessages: HistoryMessage[] = existingSummaries.length > 0 ? [{
                role: "assistant" as ChatMessageRole,
                content: `[Note: ${cutoffIndex} previous turns archived. Use \`retrieve_chat_history\` tool for details.]`,
            }] : [];

            // No compression needed - but if there are existing summaries, context IS compressed
            // Reuse the shrink pass already computed for the threshold check.
            const finalMessagesToSend = [
                ...systemMessages,
                ...summaryMessages,
                ...archiveNoteMessages,
                ..._ensureToolSequenceIntegrity(shrunkTailForBudget),
            ] as T[];
            const sanitizedNoCompress = _validateAndSanitizeForLLM(finalMessagesToSend);
            const { messages: postEmergencyNoCompress, shrunk: emergencyShrunkNoCompress } =
                ContextCompressor.emergencyShrink(sanitizedNoCompress, accessoryTokens, threshold, artifactStore, modelContextWindow);
            return {
                messagesToSend: postEmergencyNoCompress,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
                emergencyShrunk: emergencyShrunkNoCompress,
            };
        }

        // ── 5. Determine what to compress ──────────────────────────────────
        let messagesToSummarize: HistoryMessage[];
        let newSummaryLevel: number;

        if (existingSummaries.length >= maxSummaries) {
            // ── Level 2+: Summarize the existing summaries ─────────────────
            messagesToSummarize = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));
            newSummaryLevel = (existingSummaries[0]?.level ?? 1) + 1;
        } else {
            // ── Level 1: Summarize unsummarized messages ────────────────────
            messagesToSummarize = unsummarizedMessages;
            newSummaryLevel = 1;
        }

        // ── 6. Split into old (to summarize) and recent (sliding window) ─
        // Two strategies depending on which level we are producing:
        //   * Level 1: the input is the raw conversation — we snap backward
        //     to a turn boundary so the recent window always starts at a
        //     `user` message and the final turn (with its tool chain) is
        //     preserved intact.
        //   * Level 2+: the input is entirely synthetic assistant messages
        //     (previous summaries). There are no "turns" or tool chains, so
        //     we simply summarize ALL of them into one higher-level summary
        //     and keep nothing in the recent window.
        let splitIndex: number;
        if (newSummaryLevel === 1) {
            const turnBoundaries = ContextCompressor.findTurnBoundaries(messagesToSummarize);
            splitIndex = Math.max(0, messagesToSummarize.length - windowSize);
            if (splitIndex > 0) {
                let snappedIndex = 0;
                for (const boundary of turnBoundaries) {
                    if (boundary <= splitIndex) snappedIndex = boundary;
                    else break;
                }
                splitIndex = snappedIndex;
            }
        } else {
            // Level 2+ — summarize all existing summaries.
            splitIndex = messagesToSummarize.length;
        }

        // Edge case: if all messages fit in the window, no need to summarize
        if (splitIndex === 0) {
            // console.log("ContextCompressor: All messages fit within sliding window, no compression needed");
            // Convert existingSummaries to message format for LLM
            const summaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));
            // All messages fit in window - but if there are existing summaries, context IS compressed.
            // Shrink consumed oversized tool_results here too, consistent with the
            // no-compression and compressed branches (Bug 2): the previous code
            // sent the raw bodies and relied solely on emergencyShrink. This also
            // keeps budget-hint caching uniform across all return paths.
            const assembled = [
                ...systemMessages,
                ...summaryMessages,
                ..._ensureToolSequenceIntegrity(
                    ContextCompressor.shrinkLargeToolResults(messagesToSummarize, artifactStore),
                ),
            ] as T[];
            const sanitizedFitsWindow = _validateAndSanitizeForLLM(assembled);
            const { messages: postEmergencyFitsWindow, shrunk: emergencyShrunkFitsWindow } =
                ContextCompressor.emergencyShrink(sanitizedFitsWindow, accessoryTokens, threshold, artifactStore, modelContextWindow);
            return {
                messagesToSend: postEmergencyFitsWindow,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
                emergencyShrunk: emergencyShrunkFitsWindow,
            };
        }

        // Feed the raw old messages to the summarizer. `summarizeConversation`
        // internally calls `collapseToolMessagesForSummary` to fold the tool
        // chains into narrative assistant messages before summarizing, so we
        // must NOT pre-collapse here (doing so would either double-wrap or
        // destroy the toolCalls metadata that collapseToolMessagesForSummary
        // relies on).
        const oldMessages = messagesToSummarize.slice(0, splitIndex);
        const recentMessages = messagesToSummarize.slice(splitIndex);

        // ── 7. Calculate the message index for the new summary ─────────────
        // For Level 1: the new summary covers up to (cutoffIndex + splitIndex).
        // For Level 2+: the merged summary REPLACES the existing Level-1
        //   summaries, which collectively covered [0, cutoffIndex). It does
        //   NOT cover the recent raw window (those messages were never fed to
        //   the summarizer) — so its coverage is exactly `cutoffIndex`. Using
        //   `nonSystemMessages.length` here was a bug: it claimed the recent
        //   raw messages as summarized and they were silently lost on the next
        //   turn (docs/context-compression-bug-report.md §2, Bug 1(d)).
        const newSummaryLastIndex = newSummaryLevel === 1
            ? cutoffIndex + splitIndex
            : cutoffIndex;

        // ── 8. Get the message ID of the last summarized message ──────────
        // For Level 1: last message in oldMessages (before split).
        // For Level 2+: anchor at the SAME message that defined `cutoffIndex`
        //   (the existing summary with the greatest coverage), so the merged
        //   summary's id-anchor stays consistent with its `lastMessageIndex`.
        let lastSummarizedMessageId: string | undefined;
        if (newSummaryLevel === 1) {
            const lastMsg = oldMessages[oldMessages.length - 1];
            lastSummarizedMessageId = lastMsg?.id;
        } else {
            const cutoffAnchorSummary = existingSummaries.reduce(
                (a, b) => (a.lastMessageIndex >= b.lastMessageIndex ? a : b),
            );
            lastSummarizedMessageId = cutoffAnchorSummary?.messageId;
        }

        // ── 9. Generate summary via LLM ─────────────────────────────────────
        // ── 9a. Determine prefix based on summary level ───────────────────
        const summaryPrefix = newSummaryLevel === 1
            ? "[Conversation Summary]\n"
            : `[Summary of Previous Summaries (Level ${newSummaryLevel})]\n`;

        // Notify the caller that summarization is about to begin (0% false-positive
        // — all threshold checks are complete and we know summarization will run).
        onSummarizing?.();

        const summaryContent = await summarizeConversation(modelConfig, prompt, oldMessages, newSummaryLevel, signal);

        // ── 9b. Summary generation failed — degrade to "no compression" ───
        // A null return means the summarizer threw; inserting an empty assistant
        // message would be rejected by some OpenAI-compatible gateways. We fall
        // back to sending the raw (non-compressed) context this turn and let the
        // next turn try again.
        if (summaryContent === null) {
            console.warn("[ContextCompressor] summarizeConversation returned null; degrading to no-compression for this turn");
            const fallbackSummaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));
            const fallbackArchiveNote: HistoryMessage[] = existingSummaries.length > 0 ? [{
                role: "assistant" as ChatMessageRole,
                content: `[Note: ${cutoffIndex} previous turns archived. Use \`retrieve_chat_history\` tool for details.]`,
            }] : [];
            const fallbackShrunk = ContextCompressor.shrinkLargeToolResults(unsummarizedMessages, artifactStore);
            const fallbackAssembled = [
                ...systemMessages,
                ...fallbackSummaryMessages,
                ...fallbackArchiveNote,
                ..._ensureToolSequenceIntegrity(fallbackShrunk),
            ] as T[];
            const sanitizedFallback = _validateAndSanitizeForLLM(fallbackAssembled);
            const { messages: postEmergencyFallback, shrunk: emergencyShrunkFallback } =
                ContextCompressor.emergencyShrink(sanitizedFallback, accessoryTokens, threshold, artifactStore, modelContextWindow);
            return {
                messagesToSend: postEmergencyFallback,
                newSummary: null,
                compressed: existingSummaries.length > 0,
                lastMessageIndex: cutoffIndex,
                emergencyShrunk: emergencyShrunkFallback,
            };
        }

        // ── 10. Create new summary to persist ──────────────────────────────
        // Store content WITH prefix so future reduces get it automatically
        const newSummary: ConversationSummary = {
            content: summaryPrefix + summaryContent,
            level: newSummaryLevel,
            createdAt: Date.now(),
            lastMessageIndex: newSummaryLastIndex,
            messageId: lastSummarizedMessageId,
        };

        // ── 11. Build messages to send to LLM ────────────────────────────────
        const latestSummaryMessage: HistoryMessage = {
            role: "assistant",
            content: newSummary.content, // already has prefix
        };

        // Summary block + recent window differ by level:
        //
        //   * Level 1 (append): the existing summaries stay, the new Level-1
        //     summary is appended after them, and the recent window is the
        //     messages after the sliding-window split.
        //
        //   * Level 2+ (replace): the merged summary REPLACES the existing
        //     summaries, so we must NOT re-emit them — doing so duplicated the
        //     same history N times in the prompt and let summaries grow without
        //     bound (docs/context-compression-bug-report.md §2, Bug 1(b)/(c)).
        //     The recent raw window (`snappedForBudget`) is preserved here;
        //     the old code used the empty `recentMessages` slice and dropped
        //     the entire recent conversation — including the CURRENT user turn
        //     — from the prompt (Bug 1(a)).
        let summaryBlock: HistoryMessage[];
        let keptRecentMessages: HistoryMessage[];
        if (newSummaryLevel === 1) {
            const summaryMessages: HistoryMessage[] = existingSummaries.map(s => ({
                role: "assistant" as ChatMessageRole,
                content: s.content,
            }));
            summaryBlock = [...summaryMessages, latestSummaryMessage];
            keptRecentMessages = recentMessages;
        } else {
            summaryBlock = [latestSummaryMessage];
            keptRecentMessages = snappedForBudget;
        }

        // Build archive note: inform LLM about archived messages before summaries
        const archiveNoteMessage: HistoryMessage = {
            role: "assistant" as ChatMessageRole,
            content: `[Note: previous turns are archived. Use \`retrieve_chat_history\` tool for details.]`,
        };

        // Ensure tool message sequence integrity in the final messagesToSend
        const finalMessagesToSend = [
            ...systemMessages,
            ...summaryBlock,
            archiveNoteMessage,
            ..._ensureToolSequenceIntegrity(
                ContextCompressor.shrinkLargeToolResults(keptRecentMessages, artifactStore),
            ),
        ] as T[];

        const sanitizedCompressed = _validateAndSanitizeForLLM(finalMessagesToSend);
        const { messages: postEmergencyCompressed, shrunk: emergencyShrunkCompressed } =
            ContextCompressor.emergencyShrink(sanitizedCompressed, accessoryTokens, threshold, artifactStore, modelContextWindow);

        // Level-1 appends; Level-2+ replaces the whole summary set with the
        // single merged summary. The two are mutually exclusive — see
        // `ContextCompressionResult.summariesReplacement`.
        const isReplacement = newSummaryLevel >= 2;
        return {
            messagesToSend: postEmergencyCompressed,
            newSummary: isReplacement ? null : newSummary,
            summariesReplacement: isReplacement ? [newSummary] : null,
            compressed: true,
            lastMessageIndex: newSummaryLastIndex,
            emergencyShrunk: emergencyShrunkCompressed,
        };
    }

    /**
     * Copy shrink-stage budget hints from the assembled prompt onto live
     * message buffers (matched by `toolCallId`).
     *
     * Full tool results stay in `content` / `toolCallResult.result` for UI
     * and summarizer fidelity; hints let later passes reuse the shrunk view
     * without re-walking multi-megabyte bodies or re-spilling artifacts.
     */
    static backfillBudgetHints(
        source: HistoryMessage[],
        ...targets: HistoryMessage[][]
    ): void {
        const hints = new Map<string, { hint: string; hintLen: number }>();
        for (const src of source) {
            if (src.role !== 'tool_result' || !src.toolCallId) continue;
            const hint = src.contentBudgetHint;
            const hintLen = src.contentBudgetHintForLength;
            if (hint == null || hintLen == null) continue;
            hints.set(src.toolCallId, { hint, hintLen });
        }
        if (hints.size === 0) return;

        for (const target of targets) {
            for (const tgt of target) {
                if (tgt.role !== 'tool_result' || !tgt.toolCallId) continue;
                const entry = hints.get(tgt.toolCallId);
                if (!entry || tgt.content.length !== entry.hintLen) continue;
                tgt.contentBudgetHint = entry.hint;
                tgt.contentBudgetHintForLength = entry.hintLen;
            }
        }
    }

    /** @deprecated Use {@link backfillBudgetHints}. */
    static syncBudgetHintsFromSent<T extends HistoryMessage>(
        target: T[],
        source: T[],
    ): void {
        ContextCompressor.backfillBudgetHints(source, target);
    }

    /**
     * Collapse ALL tool call sequences into narrative assistant messages
     * **for summarizer input only**.
     *
     * Delegates to the extracted standalone function to avoid a circular
     * dependency with the summarizer module.
     */
    static collapseToolMessagesForSummary<T extends HistoryMessage>(messages: T[]): T[] {
        return collapseToolMessagesForSummary(messages);
    }

    // ─────────────────────────────────────────────
    // Private helpers (delegates to standalone functions
    // extracted to sibling modules; kept as class methods
    // for backward-compat with tests that access them
    // via `(ContextCompressor as any)`).
    // ─────────────────────────────────────────────

    /**
     * @internal Delegate to the standalone {@link _toolResultRunEnd}.
     * Tests access this via `(ContextCompressor as any).toolResultRunEnd`.
     */
    private static toolResultRunEnd(messages: HistoryMessage[], assistantIndex: number): number {
        return _toolResultRunEnd(messages, assistantIndex);
    }

    /**
     * @internal Delegate to the standalone {@link _ensureToolSequenceIntegrity}.
     * Tests access this via `(ContextCompressor as any).ensureToolSequenceIntegrity`.
     */
    private static ensureToolSequenceIntegrity<T extends HistoryMessage>(messages: T[]): T[] {
        return _ensureToolSequenceIntegrity(messages);
    }

    /**
     * @internal Delegate to the standalone {@link _validateAndSanitizeForLLM}.
     * Tests access this via `(ContextCompressor as any).validateAndSanitizeForLLM`.
     */
    private static validateAndSanitizeForLLM<T extends HistoryMessage>(messages: T[]): T[] {
        return _validateAndSanitizeForLLM(messages);
    }

    /**
     * Last-resort budget recovery — applied to the fully-assembled
     * messages list when its estimated token count exceeds the
     * **adaptive emergency line**.
     *
     * Why this exists: primary compression operates on the **history**
     * portion of the prompt (everything older than the recent window).
     * Two narrow paths leak past it:
     *   1. A single `tool_result` in the **unconsumed tail** (newer than
     *      the last assistant message) that happens to be huge — e.g. a
     *      delegate-task envelope or a large file read. This is exempt
     *      from {@link shrinkLargeToolResults} by design because the
     *      LLM hasn't read it yet, but on a tight model window the
     *      exemption can push the prompt over the model's context limit.
     *   2. A recent window whose **last turn** alone is enormous (long
     *      tool chain in a single turn). Primary compression's turn-
     *      boundary snap keeps the whole turn intact, even when that
     *      means the "compressed" prompt is barely smaller than the
     *      uncompressed one.
     *
     * Adaptive emergency line:
     *   `min(threshold × 1.5, modelContextWindow × 0.85 / 1.2)`
     *
     *   - `threshold × 1.5` — the user-tunable knob. Fires when the
     *     post-compression prompt is **clearly** above the configured
     *     trigger point.
     *   - `modelContextWindow × 0.85 / 1.2` — model-aware safety floor:
     *     0.85 leaves 15% of the real window for the response and
     *     provider-side overhead; the /1.2 converts the real-token
     *     ceiling back into the compressor's estimated-token unit. So a
     *     16k-window model fires emergency shrink at ~11k estimated
     *     tokens regardless of how high the user's threshold is.
     *
     *   When `modelContextWindow <= 0` (no metadata supplied — e.g.
     *   tests, unknown model) the model floor is omitted and only
     *   `threshold × 1.5` applies, preserving the original behaviour.
     *
     * Strategy: walk tool_results in **chronological (oldest-first)**
     * order, shrinking each oversized one in turn and stopping as soon
     * as the assembled prompt drops back under the emergency line. This
     * preserves the model's most recent tool_results — the ones it is
     * most likely to be reasoning over right now — and only sacrifices
     * the earliest ones, which the model has had the longest to digest
     * (and which are most likely already paraphrased into the model's
     * own subsequent tool-call arguments anyway).
     *
     * Why incremental beats the previous "force-shrink everything"
     * approach: once the outer compressor's `shrinkLargeToolResults`
     * (which now exempts the entire active reasoning chain — see its
     * JSDoc) leaves the active chain intact, the wholesale variant
     * here would force-truncate every active-chain tool_result the
     * moment the cumulative chain crossed the emergency line. For a
     * sub-agent that legitimately needs to read several large files in
     * one turn (`read_file → write_handoff → read_file → write_handoff
     * → ...`), that's exactly the "走两步就忘 → re-fetch the same
     * file → loop" pathology this entire shrink stage was meant to
     * prevent. Walking oldest-first and stopping at the budget line
     * gives the model the maximum number of recent intact tool_results
     * we can fit while still meeting the provider's window contract.
     *
     * The envelope spill path still preserves recall via the artifact
     * store on every shrink call, so a user who really needs the
     * dropped detail can recover it with `recall_artifact` on the
     * next turn. The structural assistant→tool_result pairing is
     * preserved (only the `content` field of each tool_result is
     * rewritten), so no re-sanitization is needed.
     *
     * Returns the possibly-rewritten messages array (the original is
     * never mutated). The `shrunk` flag in the return value signals to
     * the caller that emergency shrinking actually ran, so a Notice /
     * event can be surfaced once per session.
     *
     * No second LLM summarization is attempted here on purpose:
     *   - it would double the latency of an already-over-budget turn;
     *   - the structural shrink alone is usually enough to bring the
     *     prompt back inside the window;
     *   - if it isn't, the provider's own 400 with a clear "too long"
     *     message is more actionable than a silently-double-compressed
     *     turn whose summary may have dropped the key fact.
     */
    private static emergencyShrink<T extends HistoryMessage>(
        messages: T[],
        accessoryTokens: number,
        threshold: number,
        store: ArtifactStore | null,
        modelContextWindow: number,
    ): { messages: T[]; shrunk: boolean } {
        const total = estimateMessagesTokens(messages) + accessoryTokens;

        // Compute the adaptive emergency line. See JSDoc above for the
        // math; here we just min two upper bounds, omitting the model
        // floor when no metadata was supplied (the historical path).
        const thresholdCeiling = threshold * 1.5;
        // 0.85 / 1.2 ≈ 0.708 — derived constants kept inline to avoid
        // a tiny helper file; they're tuned in tandem and only used here.
        const modelCeiling = modelContextWindow > 0
            ? (modelContextWindow * 0.85) / 1.2
            : Number.POSITIVE_INFINITY;
        const emergencyLine = Math.min(thresholdCeiling, modelCeiling);
        const limitedByModel = modelCeiling < thresholdCeiling;

        if (total <= emergencyLine) return { messages, shrunk: false };

        // Incremental, oldest-first shrink. We keep a running token
        // total and shrink one tool_result at a time until we either
        // dip back under `emergencyLine` or run out of shrinkable
        // material. The running-delta update keeps this O(N) on the
        // common path even for very long histories.
        const working: T[] = messages.slice();
        let runningTotal = total;
        let anyShrunk = false;

        for (let i = 0; i < working.length; i++) {
            if (runningTotal <= emergencyLine) break;
            const msg = working[i]!;
            if (msg.role !== "tool_result") continue;
            const before = msg.content;
            if (typeof before !== "string" || before.length === 0) continue;
            const after = shrinkToolResultContent(before, msg.toolCallId, store);
            if (after === before) continue; // already small / non-shrinkable
            const fullLen = isValidBudgetHint(msg)
                ? msg.contentBudgetHintForLength!
                : before.length;
            working[i] = {
                ...msg,
                content: after,
                contentBudgetHint: after,
                contentBudgetHintForLength: fullLen,
            } as T;
            // Token delta: `estimateTokens` is cheap (linear in length
            // with a couple of branches) and counting only the changed
            // message keeps the worst case O(total content size)
            // instead of O(N · total content size) we'd get from a
            // full `estimateMessagesTokens` re-count per iteration.
            runningTotal = runningTotal - estimateTokens(before) + estimateTokens(after);
            anyShrunk = true;
        }

        // Nothing left to shrink? Either every tool_result was already
        // small or the over-budget portion lives in the assistant /
        // user messages themselves. Either way, returning `messages`
        // (the original, untouched) keeps the no-op contract.
        if (!anyShrunk) {
            const guidance = limitedByModel
                ? `model context window ~${modelContextWindow} is the limiting factor — ` +
                  `lower the compression threshold or switch to a larger-context model.`
                : `consider raising the threshold, switching to a larger-context model, ` +
                  `or trimming the active tool set.`;
            console.warn(
                `[ContextCompressor] emergency shrink found nothing left to shrink: ` +
                `${total} estimated tokens, emergency line ${Math.floor(emergencyLine)} ` +
                `(threshold ${threshold}${limitedByModel ? `, model ${modelContextWindow}` : ""}). ` +
                guidance,
            );
            return { messages, shrunk: false };
        }

        const newTotal = estimateMessagesTokens(working) + accessoryTokens;
        if (newTotal > emergencyLine) {
            console.warn(
                `[ContextCompressor] emergency shrink applied but prompt is still over budget: ` +
                `${total} → ${newTotal} estimated tokens (limit ${Math.floor(emergencyLine)}` +
                `${limitedByModel ? `, capped by model window ${modelContextWindow}` : ""}). ` +
                `Provider may return a 400 if the model window is exceeded.`,
            );
        } else {
            console.warn(
                `[ContextCompressor] emergency shrink applied (incremental, oldest-first): ` +
                `${total} → ${newTotal} estimated tokens (limit ${Math.floor(emergencyLine)}` +
                `${limitedByModel ? `, capped by model window ${modelContextWindow}` : ""}). ` +
                `Earliest oversized tool_results were truncated to fit the budget; ` +
                `more recent results were preserved verbatim. Original content remains ` +
                `recoverable via the artifact store when available.`,
            );
        }
        return { messages: working, shrunk: true };
    }

    /**
     * Shrink the `content` of oversized `tool_result` messages while preserving
     * the protocol structure (role, toolCallId, assistant→tool pairing).
     *
     * Rationale — earlier versions of this module used to **collapse** the
     * entire assistant(toolCalls) + tool_result chain into a single
     * narrative `assistant` message. That saved tokens but also fed the
     * model out-of-distribution input: the recap lines ("Earlier I called
     * the `foo` tool …") looked enough like a callable syntax that some
     * models started emitting fake "tool calls" as plain text instead of
     * going through the real function-calling channel. The fix there was a
     * long "note to myself" disclaimer, which is a clear smell.
     *
     * This method keeps the structure intact — every assistant(toolCalls) is
     * still followed by its matching tool_result messages with the same ids
     * — and only rewrites the payload of individual `tool_result` messages
     * whose content would otherwise bloat the context (e.g. large
     * `retrieve_chat_history` / file read / search results). Replacement
     * content is a short bracketed `[Tool result truncated: ...]` string
     * which is unambiguously meta.
     *
     * **"Last unconsumed tool_result chain" exemption** — A `tool_result`'s
     * lifecycle has two stages:
     *   1. just produced, not yet digested by any subsequent assistant turn;
     *   2. already followed by an assistant message (text reply OR a new
     *      tool_call) — meaning the LLM has had at least one chance to read
     *      it and react to it.
     * Stage-1 results MUST stay intact: shrinking them before the LLM ever
     * sees them defeats the entire purpose of the tool call (most painfully
     * visible when a sub-agent like `delegate_task` returns a multi-thousand-
     * token digest that is the *whole point* of the call). Stage-2 results
     * are fair game — by the time the next compression pass runs, the
     * relevant signal is already in the assistant's text output.
     *
     * Concretely: locate the index of the **last** `assistant` message in
     * the array. Any `tool_result` strictly after that index belongs to the
     * still-unconsumed tail and is passed through verbatim. All other
     * tool_results follow the regular size-based shrinking rules.
     *
     * This method does NOT modify the input array; it returns a new array
     * (new message objects are only created for the messages that actually
     * get rewritten — others are passed through by reference).
     *
     * **B-1 — envelope spill**: when an `artifactStore` is supplied, an
     * eligible (consumed, oversized) tool_result whose content is a
     * recognisable delegate envelope is rewritten in place — its inline
     * `result` / `extras[k]` are moved into the store and replaced with
     * `ArtifactRef`s. The envelope structure (`__kind` / `__v` / `text`
     * / `omitted` / pre-existing `artifacts`) is preserved, and the
     * store auto-generates unique keys for each spilled field. Without
     * a store, the legacy generic truncation path runs.
     *
     * **`forceShrinkAll`** disables the unconsumed-tail exemption. Used
     * exclusively by {@link emergencyShrink} as a last-resort budget
     * recovery when the assembled prompt still exceeds 1.5× threshold
     * after primary compression. The caller accepts the per-turn fidelity
     * loss on freshly-returned tool results because the alternative is
     * a provider 400 (over-window request). Envelope-aware spilling is
     * still attempted first so the content remains recallable via
     * `recall_artifact`.
     */
    private static shrinkLargeToolResults<T extends HistoryMessage>(
        messages: T[],
        store?: ArtifactStore | null,
        forceShrinkAll: boolean = false,
    ): T[] {
        if (messages.length === 0) return messages;

        // Locate the boundary between consumed and still-active
        // tool_results. Anything after this index is part of the
        // "just-produced, not yet digested" tail.
        //
        // The rule is: only a **content-bearing** assistant turn (one
        // whose `content` is a non-empty string) closes the active
        // reasoning chain. A pure tool-call assistant (empty content,
        // toolCalls only) does NOT — it just forwards data into the
        // next tool via toolCall arguments and chains the next step,
        // which means the preceding tool_result is still in the
        // model's working set and may be referenced again on later
        // iterations.
        //
        // Why this matters — vault_inspector "走两步就忘" loop:
        //   read_file (big body) → write_handoff(value=<body>) →
        //   read_file (same path again) → write_handoff again → ...
        // Pre-fix the heuristic took **any** assistant as the
        // boundary, so once iter 2 emitted its `write_handoff`
        // toolCall, iter 3's compress() shrank read_file's result to a
        // `[Tool result truncated: …]` placeholder. The model could
        // no longer see its own file content and retried the read
        // from scratch, looping the entire chain.
        //
        // Why it's safe to extend the exemption window backwards:
        //   * The total context still has a hard ceiling at the
        //     emergency-shrink line (1.5× threshold), where
        //     `forceShrinkAll=true` overrides this exemption and
        //     truncates everything regardless of position.
        //   * Sub-agents always run with a single user turn so they
        //     can't go through primary compression at all — the
        //     emergency line is the ONLY budget brake regardless of
        //     this rule.
        //   * Once the model produces any prose (even a one-line
        //     "done"), the entire pre-prose chain becomes shrinkable
        //     again — i.e. closing the chain costs nothing extra
        //     compared to the old behaviour.
        //
        // -1 means no content-bearing assistant exists in the slice;
        // the condition `i > lastAssistantIdx` then evaluates to
        // true for every tool_result, so the entire slice is treated
        // as the active chain and nothing gets shrunk. This is the
        // safe default — without a closing prose turn we cannot
        // prove the model has finished reasoning over any of the
        // tool_results yet.
        //
        // When `forceShrinkAll` is true the exemption is bypassed
        // entirely; computing `lastAssistantIdx` is harmless in that
        // case and keeps the per-iteration condition uniform.
        let lastAssistantIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]!;
            if (m.role !== 'assistant') continue;
            const hasContent = typeof m.content === 'string' && m.content.length > 0;
            if (hasContent) {
                lastAssistantIdx = i;
                break;
            }
        }

        const result: T[] = [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]!;
            if (msg.role === 'tool_result' && typeof msg.content === 'string' && msg.content.length > 0) {
                // Exempt the unconsumed tail: tool_results after the last
                // assistant haven't been read by the model yet. Bypassed
                // when the caller is the emergency shrink path.
                if (!forceShrinkAll && i > lastAssistantIdx) {
                    result.push(msg);
                    continue;
                }
                if (!forceShrinkAll && isValidBudgetHint(msg)) {
                    result.push({
                        ...msg,
                        content: msg.contentBudgetHint!,
                        contentBudgetHint: msg.contentBudgetHint,
                        contentBudgetHintForLength: msg.contentBudgetHintForLength,
                    } as T);
                    continue;
                }
                const shrunk = shrinkToolResultContent(msg.content, msg.toolCallId, store ?? null);
                if (shrunk !== msg.content) {
                    result.push({
                        ...msg,
                        content: shrunk,
                        contentBudgetHint: shrunk,
                        contentBudgetHintForLength: msg.content.length,
                    } as T);
                    continue;
                }
            }
            result.push(msg);
        }
        return result;
    }

    /**
     * Find turn boundaries in a message array.
     * A turn starts at a "user" message and includes all subsequent
     * assistant/tool_call/tool_result messages until the next "user" message.
     * Returns an array of indices where each turn starts.
     */
    private static findTurnBoundaries(messages: HistoryMessage[]): number[] {
        const boundaries: number[] = [0]; // First message is always a boundary
        for (let i = 1; i < messages.length; i++) {
            if (messages[i]!.role === 'user') {
                boundaries.push(i);
            }
        }
        return boundaries;
    }

    /**
     * Return the slice of `messages` starting at the first `user` message.
     *
     * Used by the "have-summaries-but-no-compression-needed" branch so the
     * messages sent to the LLM after the summary blocks always begin at a
     * turn boundary. Falls back to the original array when no `user`
     * message is present (rare, but e.g. if the anchor shifted past the end).
     */
    private static sliceFromNextTurnBoundary<T extends HistoryMessage>(messages: T[]): T[] {
        for (let i = 0; i < messages.length; i++) {
            if (messages[i]!.role === "user") {
                if (i > 0) {
                    console.debug("[ContextCompressor] sliceFromNextTurnBoundary: dropped", i,
                        "leading non-user messages to align with turn boundary");
                }
                return messages.slice(i);
            }
        }
        return messages;
    }
}
