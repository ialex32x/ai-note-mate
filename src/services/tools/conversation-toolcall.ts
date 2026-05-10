import type { ChatStream } from "../chat-stream";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";

/**
 * Create conversation history retrieval tools collection
 * @returns Array of registered tools
 */
export function createConversationTools(): RegisteredTool[] {
    return [createRetrieveChatHistoryTool()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: retrieve_chat_history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool to retrieve chat history by turn offset.
 *
 * This tool is a context-observability primitive: it lets the model fetch the
 * original user/assistant turns when the visible conversation has been
 * compressed into a summary, or when the model is otherwise uncertain about
 * what was said earlier. It must always be visible to the model (not gated by
 * embedding-based on-demand selection), because the decision to call it is a
 * meta-cognitive signal ("I don't remember enough") that cannot be inferred
 * from the user's current sentence via semantic similarity.
 *
 * Recommended usage: retrieve small batches (1-3 turns) at a time to avoid
 * re-flooding the context with redundant material.
 */
function createRetrieveChatHistoryTool(): RegisteredTool {
    return {
        // Always exposed to the model. See the doc comment above for rationale.
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "retrieve_chat_history",
                description:
                    "Retrieve the original user/assistant messages for a given turn range. " +
                    "Call this tool whenever the visible context contains a `[Conversation Summary]` " +
                    "block, an archived-turns notice, or you are unsure about what the user or you " +
                    "previously said and that uncertainty might affect your next answer. " +
                    "Prefer fetching 1-3 turns at a time, starting near the area you need to clarify. " +
                    "Each 'turn' is one complete exchange (user message + assistant response).",
                parameters: {
                    type: "object",
                    properties: {
                        turn_offset: {
                            type: "integer",
                            description:
                                "The turn position to start retrieval from. " +
                                "Positive values (1, 2, 3...): absolute position from the first turn (1). " +
                                "  turn_offset=1 means start from the very first turn. " +
                                "  turn_offset=3 means start from turn 3. " +
                                "Negative values (-1, -2, -3...): relative offset from the current turn. " +
                                "  turn_offset=-1 means the immediately previous turn. " +
                                "  turn_offset=-2 means two turns back, etc. " +
                                "Examples: " +
                                "  If current turn is 5 and turn_offset=1, starts from turn 1. " +
                                "  If current turn is 5 and turn_offset=-1, returns turn 4. " +
                                "  If current turn is 5 and turn_offset=-2, returns turns 3-4.",
                        },
                        num_turns: {
                            type: "integer",
                            description:
                                "Number of turns to retrieve. " +
                                "Each turn contains one user message and its corresponding assistant response. " +
                                "Recommended: 1-3 turns. If 0 or negative, defaults to 1 turn.",
                        },
                    },
                    required: ["turn_offset"],
                },
            },
        },
        exec: async (chatStream: ChatStream, args: Record<string, unknown>): Promise<ToolCallResult> => {
            const turnOffset = args["turn_offset"] as number;
            let numTurns = args["num_turns"] as number | undefined;

            // Validate turn_offset (must be a non-zero integer)
            if (typeof turnOffset !== "number" || isNaN(turnOffset) || turnOffset === 0) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: turn_offset must be a non-zero integer. Use positive values (1, 2, 3...) for absolute position from first turn, or negative values (-1, -2, -3...) for relative offset from current turn.",
                };
            }

            // Validate and default num_turns
            if (numTurns === undefined || typeof numTurns !== "number" || numTurns <= 0) {
                numTurns = 1;
            }

            const messages = chatStream.messages;
            const currentTurn = chatStream.currentTurn;

            // No messages or no turn info
            if (messages.length === 0) {
                return {
                    success: true,
                    type: "object",
                    content: {
                        totalTurns: 0,
                        currentTurn: currentTurn,
                        retrievedTurns: [],
                        note: "No conversation history available.",
                    },
                };
            }

            // Collect all unique turn numbers from messages (messages are already sorted)
            const turnNumbers: number[] = [];
            let lastTurn: number | undefined;
            for (const msg of messages) {
                if (msg.turn !== undefined && msg.turn !== lastTurn) {
                    turnNumbers.push(msg.turn);
                    lastTurn = msg.turn;
                }
            }

            // Calculate target turn
            // Positive: absolute position from first turn (turn_offset=1 means turn 1)
            // Negative: relative offset from current turn (turn_offset=-1 means previous turn)
            const targetTurn = turnOffset > 0 ? turnOffset : currentTurn + turnOffset;

            // Find the turn that matches (or is closest without exceeding)
            let startIndex = -1;
            for (let i = turnNumbers.length - 1; i >= 0; i--) {
                if (turnNumbers[i]! <= targetTurn) {
                    startIndex = i;
                    break;
                }
            }

            if (startIndex < 0) {
                // No turns before/at target
                const offsetDesc = turnOffset > 0
                    ? `requested turn ${turnOffset}`
                    : `offset ${turnOffset}`;
                return {
                    success: true,
                    type: "object",
                    content: {
                        totalTurns: turnNumbers.length,
                        currentTurn: currentTurn,
                        retrievedTurns: [],
                        note: `No turns found at ${offsetDesc}. The conversation has ${turnNumbers.length} turn(s).`,
                    },
                };
            }

            // Get the turns to retrieve (going backward from startIndex)
            const endIndex = Math.max(-1, startIndex - numTurns + 1);
            const turnsToRetrieve: number[] = [];
            for (let i = startIndex; i >= endIndex; i--) {
                turnsToRetrieve.push(turnNumbers[i]!);
            }

            // Collect messages belonging to those turns (only user and assistant roles)
            const retrievedMessages: Array<{
                turn: number;
                role: string;
                content: string;
                timestamp: number;
            }> = [];

            for (const msg of messages) {
                if (msg.turn !== undefined && turnsToRetrieve.includes(msg.turn)) {
                    // Only include user and assistant messages (exclude tools)
                    if (msg.role === "user" || msg.role === "assistant") {
                        retrievedMessages.push({
                            turn: msg.turn,
                            role: msg.role,
                            content: msg.content,
                            timestamp: msg.timestamp,
                        });
                    }
                }
            }

            // Format the output for readability (messages are already in order)
            const formattedTurns: Array<{
                turn: number;
                messages: Array<{
                    role: string;
                    content: string;
                    timestamp: number;
                }>;
            }> = [];

            for (const turnNum of turnsToRetrieve) {
                const turnMessages = retrievedMessages.filter(m => m.turn === turnNum);
                if (turnMessages.length > 0) {
                    formattedTurns.push({
                        turn: turnNum,
                        messages: turnMessages.map(m => ({
                            role: m.role,
                            content: m.content,
                            timestamp: m.timestamp,
                        })),
                    });
                }
            }

            return {
                success: true,
                type: "object",
                content: {
                    totalTurns: turnNumbers.length,
                    currentTurn: currentTurn,
                    retrievedTurns: formattedTurns,
                    requestedOffset: turnOffset,
                    requestedCount: numTurns,
                },
            };
        },
    };
}
