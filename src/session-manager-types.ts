/**
 * Session manager data schemas and types.
 *
 * Extracted from session-manager.ts to keep the class lean.
 */

import type { ChatMessage } from './services/chat-stream';
import type { TokenUsage } from './services/llm-provider';
import type { InsightCardState } from './services/insights';
import type { SuggestionCardState } from './services/suggestions';

export type ReadonlyChatMessages = ReadonlyArray<ChatMessage>;

/** Session metadata (stored in list.json) */
export interface SessionMetadata {
    id: string;
    /** Session title, empty string means "use firstUserMessage as display title" */
    title: string;
    /** First user message content (truncated for display), stored for quick access without loading full messages */
    firstUserMessage: string;
    tokenUsage: TokenUsage;
    createdAt: number;
    updatedAt: number;
    /**
     * Schema version of the session messages file (sessions/{id}/messages.jsonl).
     * Mirrors {@link SessionMessagesFile.version}. Stored in list.json so
     * the startup purge check does NOT need to read every session file
     * just to detect deprecated v1–v4 formats. Absent for metadata
     * written by older plugin versions — in that case a one-time file
     * read is still performed to discover the version.
     */
    messageVersion?: number;
    /** Draft input content (unsent text in input box), restored when loading session */
    draftInput?: string;
    /**
     * Last terminal state of the insight preview card. Persisted by
     * {@link SessionRuntime} after each successful (or failed) insight
     * extraction so that switching away and back to the session — or
     * reloading the plugin entirely — restores the card without
     * re-running the LLM call. Bound to a specific assistant
     * `messageId` so stale states are detectable on replay.
     *
     * `loading` is deliberately not persisted (it's transient).
     */
    lastInsights?: InsightCardState;

    /**
     * Last terminal state of the follow-up suggestion bar, produced
     * by the LLM fallback extraction. Persisted by {@link SessionRuntime}
     * so the bar survives view detach and plugin reload. Mirrors
     * {@link lastInsights} in shape and lifecycle.
     */
    lastSuggestions?: SuggestionCardState;
}

/** Messages file content (stored in sessions/${id}/messages.jsonl, JSONL format) */
export interface SessionMessagesFile {
    /** File schema version. v5 is the minimum supported after extracting
     *  per-session fields to their own files. */
    version: 5;
    id: string;
    messages: ChatMessage[];
}

/** List file content (stored in sessions/list.json) */
export interface SessionListFile {
    version: 1;
    nextId: number;
    sessions: SessionMetadata[];
}

/** Global cumulative token statistics (stored in sessions/statistics.json) */
export interface GlobalTokenStatisticsFile {
    version: 1;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens: number;
}

/** Snapshot of a session (full data for backward compatibility with public API) */
export interface SessionSnapshot {
    id: string;
    title: string;
    firstUserMessage: string;
    messages: ChatMessage[];
    tokenUsage: TokenUsage;
    createdAt: number;
    updatedAt: number;
}
