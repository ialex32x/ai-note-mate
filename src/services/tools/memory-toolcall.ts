import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import { MemoryStoreError } from "../memory";

/**
 * Tool layer for the memory feature.
 *
 * Behaviour notes for the new (vault-note-backed) implementation:
 * - `memory_recall` has been REMOVED. Memories that match the current
 *   user query (and all critical entries) are now injected into the
 *   system prompt automatically via {@link buildMemorySystemPromptPrefix}.
 *   There is no value in an explicit recall round-trip.
 * - `memory_store` upserts a `## heading` section in the configured
 *   memory note. The `critical` flag controls whether the heading is
 *   written with the ` [!]` marker (every-turn injection) or plain
 *   (embedding-shortlisted).
 * - `memory_delete` removes one section by its logical heading
 *   (without the marker). Deleting a non-existent entry is a no-op
 *   with a success message — same UX as the legacy implementation.
 *
 * All write operations are routed through {@link MemoryStore} so the
 * settings UI, the auto extractor, and these tools share one
 * serialisation / cache layer.
 */
export function createMemoryTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        createMemoryStoreTool(plugin),
        createMemoryDeleteTool(plugin),
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: memory_store
// ─────────────────────────────────────────────────────────────────────────────

function createMemoryStoreTool(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "memory_store",
                description:
                    "Save a long-term memory entry into the user's memory note. " +
                    "Use this ONLY when the user explicitly asks you to remember something, " +
                    "or when you have identified durable context (preferences, identities, " +
                    "naming conventions, hard rules) that will help future turns. " +
                    "If a memory with the same heading already exists, it is replaced. " +
                    "Set `critical: true` only for entries the assistant MUST recall on every " +
                    "turn (personal identity, fixed reply rules, hard refusals); everything " +
                    "else stays non-critical and is recalled by relevance to the current query.",
                parameters: {
                    type: "object",
                    properties: {
                        heading: {
                            type: "string",
                            description:
                                "Short, descriptive title of the memory entry (≤ 60 chars), " +
                                "in the user's language. Used as the `## heading` in the memory " +
                                "note and as the de-duplication key — re-using a heading replaces " +
                                "the existing entry. Do NOT add the ` [!]` marker yourself; set " +
                                "the `critical` field instead.",
                        },
                        body: {
                            type: "string",
                            description:
                                "Memory content. One or two sentences (or a short bullet list) " +
                                "expressing the durable fact as a directive the assistant can " +
                                "read literally — not as a description of the conversation. " +
                                "Same language as the user.",
                        },
                        critical: {
                            type: "boolean",
                            description:
                                "Whether this entry is injected into the system prompt on EVERY " +
                                "turn (true) or only when it appears relevant to the user's " +
                                "current query (false). Default false; reserve true for entries " +
                                "that must influence every reply.",
                        },
                    },
                    required: ["heading", "body"],
                },
            },
        },
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const heading = typeof args["heading"] === 'string' ? args["heading"].trim() : '';
            const body = typeof args["body"] === 'string' ? args["body"].trim() : '';
            const critical = args["critical"] === true;

            if (!heading) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Memory heading cannot be empty.",
                };
            }
            if (!body) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Memory body cannot be empty.",
                };
            }

            try {
                const entry = await plugin.memoryStore.upsert(heading, critical, body);
                return {
                    success: true,
                    type: "text",
                    content: `Memory stored: "${entry.logicalHeading}"${entry.critical ? ' (critical)' : ''}.`,
                };
            } catch (err) {
                if (err instanceof MemoryStoreError) {
                    return {
                        success: false,
                        type: "text",
                        content: `Error: ${err.message}`,
                    };
                }
                return {
                    success: false,
                    type: "text",
                    content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: memory_delete
// ─────────────────────────────────────────────────────────────────────────────

function createMemoryDeleteTool(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "memory_delete",
                description:
                    "Delete a memory entry by its heading. " +
                    "Use this ONLY when the user explicitly rescinds, replaces, or corrects " +
                    "a previously stored memory in the current turn. Never delete based on " +
                    "inference, silence, or apparent contradiction. " +
                    "Deleting a non-existent entry is a safe no-op.",
                parameters: {
                    type: "object",
                    properties: {
                        heading: {
                            type: "string",
                            description:
                                "Logical heading of the memory to delete, exactly as it was " +
                                "stored (without the ` [!]` critical marker — the store strips " +
                                "it on read). Matching is case-insensitive.",
                        },
                    },
                    required: ["heading"],
                },
            },
        },
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const heading = typeof args["heading"] === 'string' ? args["heading"].trim() : '';
            if (!heading) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Memory heading cannot be empty.",
                };
            }
            try {
                const removed = await plugin.memoryStore.delete(heading);
                return {
                    success: true,
                    type: "text",
                    content: removed
                        ? `Memory deleted: "${heading}".`
                        : `No memory found with heading "${heading}". Nothing to delete.`,
                };
            } catch (err) {
                if (err instanceof MemoryStoreError) {
                    return {
                        success: false,
                        type: "text",
                        content: `Error: ${err.message}`,
                    };
                }
                return {
                    success: false,
                    type: "text",
                    content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        },
    };
}
