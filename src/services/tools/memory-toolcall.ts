import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";

/**
 * Create memory tools collection
 * @param plugin Plugin instance
 * @returns Array of registered tools
 */
export function createMemoryTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        createMemoryStoreTool(plugin),
        createMemoryRecallTool(plugin),
        createMemoryDeleteTool(plugin),
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: memory_store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool to store a memory entry with key-value pair
 * Automatically records the current timestamp
 */
function createMemoryStoreTool(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "memory_store",
                description:
                    "Store an important piece of information in long-term memory. " +
                    "Use this when you learn something important about the user that should be remembered " +
                    "across conversations (preferences, facts, context, etc.). " +
                    "The memory will persist and can be recalled later.",
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "A concise identifier or category for this memory " +
                                "(e.g., 'user_name', 'preferred_language', 'project_context'). " +
                                "If a memory with this key already exists, it will be updated.",
                        },
                        value: {
                            type: "string",
                            description:
                                "The information to store. Should be descriptive and self-contained " +
                                "so it can be understood when recalled later.",
                        },
                    },
                    required: ["key", "value"],
                },
            },
        },
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const key = args["key"] as string;
            const value = args["value"] as string;

            if (!key || !key.trim()) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Memory key cannot be empty.",
                };
            }

            if (!value || !value.trim()) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Memory value cannot be empty.",
                };
            }

            const timestamp = Date.now();
            const trimmedKey = key.trim();
            const trimmedValue = value.trim();

            // Check if key already exists (update) or is new (insert)
            const existingIndex = plugin.settings.memories.findIndex(
                (m) => m.key === trimmedKey
            );

            if (existingIndex >= 0) {
                // Update existing memory
                plugin.settings.memories[existingIndex] = {
                    key: trimmedKey,
                    value: trimmedValue,
                    timestamp,
                };
            } else {
                // Add new memory
                plugin.settings.memories.push({
                    key: trimmedKey,
                    value: trimmedValue,
                    timestamp,
                });
            }

            await plugin.saveSettings();

            const action = existingIndex >= 0 ? "updated" : "stored";
            return {
                success: true,
                type: "text",
                content: `Memory ${action} successfully: "${trimmedKey}"`,
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: memory_recall
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool to recall memories from storage
 * Can retrieve a specific memory by key or list all memories
 */
function createMemoryRecallTool(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "memory_recall",
                description:
                    "Recall stored memories. Use this to retrieve previously stored information. " +
                    "Can recall a specific memory by key, or list all memories if no key is provided.",
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "Optional. The specific memory key to recall. " +
                                "If not provided, all stored memories will be returned.",
                        },
                    },
                },
            },
        },
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const key = args["key"] as string | undefined;
            const memories = plugin.settings.memories;

            if (memories.length === 0) {
                return {
                    success: true,
                    type: "text",
                    content: "No memories stored yet.",
                };
            }

            if (key && key.trim()) {
                // Recall specific memory
                const trimmedKey = key.trim();
                const memory = memories.find((m) => m.key === trimmedKey);

                if (!memory) {
                    return {
                        success: true,
                        type: "text",
                        content: `No memory found with key "${trimmedKey}".`,
                    };
                }

                return {
                    success: true,
                    type: "object",
                    content: {
                        key: memory.key,
                        value: memory.value,
                        timestamp: memory.timestamp,
                        storedAt: new Date(memory.timestamp).toISOString(),
                    },
                };
            } else {
                // Return all memories
                return {
                    success: true,
                    type: "object",
                    content: {
                        count: memories.length,
                        memories: memories.map((m) => ({
                            key: m.key,
                            value: m.value,
                            timestamp: m.timestamp,
                            storedAt: new Date(m.timestamp).toISOString(),
                        })),
                    },
                };
            }
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: memory_delete
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool to delete a memory entry by key
 */
function createMemoryDeleteTool(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: false,

        schema: {
            type: "function",
            function: {
                name: "memory_delete",
                description:
                    "Delete a stored memory by its key. " +
                    "Use this when previously stored information is no longer relevant or accurate. " +
                    "This action cannot be undone.",
                parameters: {
                    type: "object",
                    properties: {
                        key: {
                            type: "string",
                            description:
                                "The key of the memory to delete. " +
                                "Must match an existing memory key exactly.",
                        },
                    },
                    required: ["key"],
                },
            },
        },
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const key = args["key"] as string;

            if (!key || !key.trim()) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Memory key cannot be empty.",
                };
            }

            const trimmedKey = key.trim();
            const existingIndex = plugin.settings.memories.findIndex(
                (m) => m.key === trimmedKey
            );

            if (existingIndex < 0) {
                return {
                    success: true,
                    type: "text",
                    content: `No memory found with key "${trimmedKey}". Nothing to delete.`,
                };
            }

            // Remove the memory
            plugin.settings.memories.splice(existingIndex, 1);
            await plugin.saveSettings();

            return {
                success: true,
                type: "text",
                content: `Memory deleted successfully: "${trimmedKey}"`,
            };
        },
    };
}
