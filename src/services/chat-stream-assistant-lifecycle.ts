/**
 * Assistant message lifecycle helpers extracted from chat-stream.ts.
 *
 * Covers: commit, finalize, abort-finalize, stuck-finalize helpers
 * that manage `_messages`, `_inFlightAssistantMessage`, and the
 * `onMessageUpdate` callback across stream/tool-call/abort epilogues.
 */

import { INTERRUPTED_ASSISTANT_API_NOTE } from "./chat-stream-constants";
import { recordIssue } from "./diagnostics/issue-tracer";
import type { ChatMessage } from "./chat-stream-types";

// ── Pure helpers ──────────────────────────────────────────────────────

/** Whether an assistant message carries text/thinking worth persisting. */
export function assistantHasPersistablePayload(msg: ChatMessage): boolean {
    return msg.content.length > 0 || (msg.thinkingContent?.length ?? 0) > 0;
}

/**
 * Map stored assistant text to the API payload. Interrupted replies keep
 * the user-visible `content` intact and append a short meta note for the
 * model only (see {@link ChatMessage.wasInterrupted}).
 */
export function assistantContentForApi(msg: ChatMessage): string {
    if (!msg.wasInterrupted) {
        return msg.content;
    }
    if (msg.content.length === 0) {
        return INTERRUPTED_ASSISTANT_API_NOTE;
    }
    return `${msg.content}\n\n${INTERRUPTED_ASSISTANT_API_NOTE}`;
}

// ── State-mutating helpers ────────────────────────────────────────────

/**
 * Push the in-flight assistant into `_messages` on first stream output.
 * Subsequent chunks mutate the same object in place.
 */
export function commitInFlightAssistantToHistory(
    messages: ChatMessage[],
    inFlight: ChatMessage | null,
    turn: number,
): void {
    if (!inFlight || !assistantHasPersistablePayload(inFlight)) {
        return;
    }
    inFlight.turn = turn;
    if (!messages.some(m => m.id === inFlight.id)) {
        messages.push(inFlight);
    }
}

/**
 * End the current `_processStream` assistant: mark non-streaming, optionally
 * flag interruption, and ensure `_messages` holds the latest partial text.
 */
export function finalizeInFlightAssistantMessage(
    messages: ChatMessage[],
    inFlight: ChatMessage | null,
    onMessageUpdate: ((msg: ChatMessage) => void) | undefined,
    opts?: {
        interrupted?: boolean;
        turn?: number;
        /** Drop from `_messages` after finalize (pure tool-call turns). */
        removeFromHistory?: boolean;
    },
): ChatMessage | null {
    const msg = inFlight;
    // NOTE: caller is responsible for setting _inFlightAssistantMessage = null
    if (!msg || !assistantHasPersistablePayload(msg)) {
        return null;
    }

    if (opts?.turn != null) {
        msg.turn = opts.turn;
    }
    msg.streaming = false;
    if (opts?.interrupted) {
        msg.wasInterrupted = true;
    }

    const inHistory = messages.some(m => m.id === msg.id);
    if (!inHistory) {
        messages.push(msg);
    }

    if (opts?.removeFromHistory) {
        // The thinking-only bubble may have been rendered while the
        // model streamed reasoning before emitting tool calls. Pure
        // tool-call turns drop the assistant from `_messages`, but
        // the DOM bubble must be explicitly retired — otherwise the
        // last throttled emit left it stuck at streaming=true
        // ("Thinking in progress") even after the turn moved on.
        if (msg.thinkingContent) {
            msg.thinkingComplete = true;
        }
        onMessageUpdate?.({ ...msg, retireBubble: true });

        const idx = messages.findIndex(m => m.id === msg.id);
        if (idx >= 0) {
            messages.splice(idx, 1);
        }
        return null;
    }

    onMessageUpdate?.({ ...msg });
    return msg;
}

/**
 * Finalize a tool_call message that is being torn down by an abort, so
 * its bubble doesn't stay stuck in `streaming: true` with no
 * `toolCallResult`.
 */
export function finalizeAbortedToolCallMessage(
    toolCallMessage: ChatMessage,
    elapsedMs: number,
    note: string,
    onMessageUpdate: ((msg: ChatMessage) => void) | undefined,
): void {
    toolCallMessage.streaming = false;
    const baseName = toolCallMessage.toolCallMeta?.toolName ?? toolCallMessage.content;
    toolCallMessage.content = `${baseName}  (${elapsedMs}ms, aborted)`;
    toolCallMessage.toolCallResult = {
        status: 'warning',
        result: note,
    };
    onMessageUpdate?.({ ...toolCallMessage });
}

/**
 * End-of-turn safety net: walk `_messages` and finalize any
 * `tool_call` message that's still flagged `streaming: true`.
 *
 * Idempotent: a no-op when the dispatch loop already finalized
 * everything (the common case).
 */
export function finalizeStuckToolCallMessages(
    messages: ChatMessage[],
    onMessageUpdate: ((msg: ChatMessage) => void) | undefined,
): void {
    for (const msg of messages) {
        if (msg.role !== 'tool_call') continue;
        if (!msg.streaming) continue;
        const stuckToolName = msg.toolCallMeta?.toolName ?? msg.content;
        console.warn(
            `[ChatStream] Tool_call message "${stuckToolName}" ` +
            `(id=${msg.id}) left turn with streaming=true and no toolCallResult — ` +
            `forcing finalization. This indicates an upstream bug in tool-call message lifecycle.`,
        );
        recordIssue({
            severity: 'warning',
            source: 'chat-stream',
            code: 'stuck-tool-call',
            message:
                `Tool_call "${stuckToolName}" left the turn with streaming=true and no result; ` +
                `forced finalization. Likely an upstream gap in the tool-call message lifecycle.`,
            context: {
                toolName: msg.toolCallMeta?.toolName ?? null,
                messageId: msg.id,
                confirmationState: msg.confirmationState ?? null,
            },
        });
        msg.streaming = false;
        if (!msg.toolCallResult) {
            const baseName = msg.toolCallMeta?.toolName ?? msg.content;
            msg.content = `${baseName}  (no result captured)`;
            msg.toolCallResult = {
                status: 'warning',
                result: '[Tool finished but no result was captured by the chat pipeline. ' +
                    'This is a UI-side artifact; the model itself may still have received the actual result. ' +
                    'Please report this to the plugin author with the console log above.]',
            };
        }
        onMessageUpdate?.({ ...msg });
    }
}
