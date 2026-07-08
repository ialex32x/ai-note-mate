/**
 * QuickAsk side-turn logic extracted from chat-stream.ts.
 *
 * QuickAsk turns are tool-free, non-streaming LLM completions
 * anchored to a specific assistant message — the user is asking
 * a follow-up question about one particular AI reply.
 *
 * Kept as standalone functions; ChatStream owns the instance state
 * and delegates to these via thin public-method wrappers.
 */

import { QUICK_ASK_SYSTEM_PROMPT } from "./chat-stream-constants";
import { createChatCompletion } from "./context-compression";
import { generateId } from "../utils/id-utils";
import type { MinimalModelConfig } from "./llm-provider";
import type { ChatMessage, QuickAskTurn } from "./chat-stream-types";

// ── Shared state interface ────────────────────────────────────────────

/** Subset of ChatStream state needed by QuickAsk operations. */
export interface QuickAskState {
    _messages: ChatMessage[];
    _quickAskTurns: QuickAskTurn[];
}

// ── promptQuickAsk ─────────────────────────────────────────────────────

/**
 * Execute a QuickAsk side-turn: a simple, non-streaming, tool-free
 * LLM completion anchored to a specific assistant message.
 *
 * Constructs a minimal context from the parent message's turn, then
 * calls {@link createChatCompletion} (the same single-turn path used
 * by the summarizer, title generator, and insight extractor).
 *
 * @returns The assistant's reply as a ChatMessage.
 */
export async function quickAskPrompt(
    state: QuickAskState,
    parentMessageId: string,
    userInput: string,
    modelConfig: MinimalModelConfig,
): Promise<ChatMessage> {
    // Find the parent assistant message
    const parentMsg = state._messages.find(m => m.id === parentMessageId);
    if (!parentMsg || parentMsg.role !== 'assistant') {
        throw new Error('QuickAsk: parent message not found or not an assistant message');
    }

    // Build the user-side ChatMessage
    const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: userInput,
        streaming: false,
        timestamp: Date.now(),
        quickAsk: { parentMessageId },
    };

    // Create a loading placeholder SideTurn
    const sideTurn: QuickAskTurn = {
        parentMessageId,
        userMessage: userMsg,
        assistantMessage: {
            id: generateId(),
            role: 'assistant',
            content: '',
            streaming: false,
            timestamp: Date.now(),
            quickAsk: { parentMessageId },
            modelName: modelConfig.model,
        },
        loading: true,
    };
    state._quickAskTurns.push(sideTurn);

    // Build minimal context: the parent message's turn only
    const parentTurn = parentMsg.turn ?? 0;
    const turnMessages = state._messages.filter(
        m => m.turn === parentTurn && (m.role === 'user' || m.role === 'assistant'),
    );

    const contextMessages = [
        { role: 'system' as const, content: QUICK_ASK_SYSTEM_PROMPT },
        ...turnMessages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: userInput },
    ];

    try {
        const content = await createChatCompletion(modelConfig, contextMessages);
        const trimmed = content.trim();

        // Update the side-turn with the real reply
        sideTurn.assistantMessage = {
            ...sideTurn.assistantMessage,
            content: trimmed,
            timestamp: Date.now(),
        };
        sideTurn.loading = false;

        return sideTurn.assistantMessage;
    } catch {
        // Remove the orphaned loading placeholder on failure
        state._quickAskTurns = state._quickAskTurns.filter(t => t !== sideTurn);
        throw new Error('QuickAsk: LLM call failed');
    }
}

// ── getQuickAskTurns ──────────────────────────────────────────────────

/** Get all QuickAsk side-turns (shallow-cloned for safety). */
export function getQuickAskTurns(state: QuickAskState): QuickAskTurn[] {
    return state._quickAskTurns.map(t => ({ ...t }));
}

// ── restoreQuickAskTurns ──────────────────────────────────────────────

/** Restore QuickAsk side-turns from persisted session data. */
export function restoreQuickAskTurns(state: QuickAskState, turns: QuickAskTurn[]): void {
    state._quickAskTurns = turns.map(t => ({ ...t }));
}

// ── removeQuickAskTurn ────────────────────────────────────────────────

/** Remove a QuickAsk turn by parent message ID. */
export function removeQuickAskTurn(state: QuickAskState, parentMessageId: string): void {
    state._quickAskTurns = state._quickAskTurns.filter(
        t => t.parentMessageId !== parentMessageId,
    );
}
