import type { LLMProviderType, EmbeddingProviderType } from "../services/providers";
import type { MCPServerConfig } from "../services/mcp/mcp-types";
import type { ModalityCapability, ToolCapability } from "../services/llm-provider";

export const DefaultGeminiImageModel = "gemini-3-pro-image-preview";

// ─────────────────────────────────────────────────────────────────────────────
// Provider Profile
// ─────────────────────────────────────────────────────────────────────────────

export interface ProviderProfile {
	/** Unique ID (auto-generated) */
	id: string;
	/** Display name for this profile */
	name: string;
	/** Provider type */
	provider: LLMProviderType;

	/** API key for the provider */
	apiKey: string;
	/** Model identifier */
	model: string;

	// ── OpenAI-compatible fields ────────────────────────────────────────────
	/** Base URL for OpenAI-compatible APIs (ignored for Gemini) */
	baseUrl: string;

	// ── Common ─────────────────────────────────────────────────────────────
	/**
	 * Multimodal input modalities the provider/model accepts.
	 * Empty array means text-only. Note that some modalities cannot be
	 * delivered by every provider (see provider docs); the profile flag
	 * is the upper bound, not a guarantee.
	 */
	modalities: ModalityCapability[];
	/** Max token limit for session display. 0 means unlimited. */
	maxTokens: number;

	// ── Context compression (per-profile tuning) ───────────────────────────
	/**
	 * Token threshold that triggers context compression for this profile.
	 * 0 = use built-in default (48000). Recommended: ~50% of the model's
	 * context window; lower it when many tools are enabled (their JSON
	 * schemas count toward this budget) or when the model has a smaller
	 * context window.
	 */
	contextCompressionThreshold: number;
	/**
	 * Minimum number of most recent messages to retain after compression.
	 * The actual count may be larger because the split point snaps backward
	 * to the nearest turn boundary so the final tool-using turn stays intact.
	 * 0 = use built-in default (10).
	 */
	slidingWindowSize: number;
	/**
	 * Maximum number of first-level summaries before they get merged into a
	 * higher-level summary. 0 = use built-in default (8).
	 */
	maxSummariesThreshold: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Generation
// ─────────────────────────────────────────────────────────────────────────────

export type ImageGenApiScheme = 'gemini' | 'qwen' | 'openai';

export interface ImageGenConfig {
	/** Unique ID (auto-generated) */
	id: string;
	/** Display name for this config */
	name: string;
	/** API scheme to distinguish which API to use */
	apiScheme: ImageGenApiScheme;

	// ── Common fields ──────────────────────────────────────────────────────
	/** API key for the selected provider */
	apiKey: string;
	/** Model to use for image generation */
	model: string;
	/** Base URL for OpenAI-compatible APIs (only used when apiScheme is 'openai') */
	baseUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Embedding Config
// ─────────────────────────────────────────────────────────────────────────────

export interface EmbeddingConfig {
	/** Unique ID (auto-generated) */
	id: string;
	/** Display name for this config */
	name: string;
	/** Provider type */
	type: EmbeddingProviderType;

	// ── OpenAI-compatible fields ────────────────────────────────────────────
	/** Base URL for OpenAI-compatible APIs (ignored for Gemini) */
	baseUrl: string;

	// ── Common fields ──────────────────────────────────────────────────────
	/** API key for the provider */
	apiKey: string;
	/** Model to use for text embedding */
	model: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Memory
// ─────────────────────────────────────────────────────────────────────────────

export interface NoteAssistantMemory {
	key: string;
	value: string;
	timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Settings
// ─────────────────────────────────────────────────────────────────────────────

export interface NoteAssistantPluginSettings {
	/** Saved provider profiles */
	profiles: ProviderProfile[];
	/** ID of the currently active profile */
	activeProfileId: string;
	/** ID of the current profile used as context summarizer (usually the one with lower token cost) */
	summarizerProfileId: string;

	// ── Global settings (not per-profile) ───────────────────────────────────
	systemPrompt: string;
	imageDownloadDir: string;

	builtinWebSearchEnabled: boolean;
	builtinWebFetchEnabled: boolean;
	builtinRSSFetchEnabled: boolean;
	builtinJavaScriptEnabled: boolean;

	/**
	 * Per-turn call budget for the built-in `web_fetch_url` tool.
	 * Each user turn resets the counter (sub-agents have their own
	 * counter — they do not share the main agent's budget).
	 *
	 * - `webFetchSoftLimit`: once exceeded, fetch results are tagged
	 *   with a reminder line nudging the model to stop fetching and
	 *   start synthesizing. Values <= 0 fall back to the built-in
	 *   default (`DEFAULT_WEB_FETCH_SOFT_LIMIT`, currently 5).
	 * - `webFetchHardLimit`: once exceeded, the tool is refused and
	 *   the model receives a synthetic error telling it to stop.
	 *   Values <= 0 fall back to the built-in default
	 *   (`DEFAULT_WEB_FETCH_HARD_LIMIT`, currently 12).
	 *
	 * Defaults intentionally leave plenty of room for normal multi-source
	 * research while still hard-blocking the pathological "model keeps
	 * fetching random URLs because the fetcher returned empty" loop.
	 */
	webFetchSoftLimit: number;
	webFetchHardLimit: number;

	/**
	 * Tool capabilities currently allowed for the assistant.
	 * Persisted across sessions and editable from both the session toolbar
	 * and the global settings section. Defaults to all capabilities.
	 */
	allowedCapabilities: ToolCapability[];

	
	/** Enter to send, Shift+Enter for newline. If false, reversed. */
	enterToSend: boolean;
	/** Image generation configs array. If empty, image generation is disabled. */
	imageGenConfigs: ImageGenConfig[];
	/** ID of the currently active image generation config */
	activeImageGenId: string;
	/**
	 * Whether tools with `requiresConfirmation` need explicit user approval.
	 * "auto" = always auto-approve (default), "always" = always ask for confirmation.
	 */
	toolConfirmMode: 'auto' | 'always';

	// ── MCP servers ─────────────────────────────────────────────────────────
	mcpServers: MCPServerConfig[];

	// ── Skills ──────────────────────────────────────────────────────────────
	/** List of directories to search for skill definitions */
	skillSearchPaths: string[];

	// ── Embedding ───────────────────────────────────────────────────────────
	/** Whether embedding service is enabled */
	embeddingEnabled: boolean;
	/** Embedding configs array. If empty, embedding is disabled. */
	embeddingConfigs: EmbeddingConfig[];
	/** ID of the currently active embedding config */
	activeEmbeddingId: string;

	// ── Memories ───────────────────────────────────────────────────────────
	memoryEnabled: boolean;
	memories: NoteAssistantMemory[];

	// ── Follow-up quick-pick suggestions ────────────────────────────────────
	/** Master switch: render quick-pick buttons for next actions proposed at the end of an assistant reply. */
	followUpSuggestionsEnabled: boolean;
	/** When true, instruct the model (via system prompt) to emit a structured <!--suggestions--> block. */
	followUpSuggestionsStructured: boolean;
	/** When true, clicking a suggestion button sends it immediately instead of just prefilling the input. */
	followUpSuggestionsAutoSend: boolean;

	// ── Conversation insight extraction (knowledge-nugget preview) ──────────
	/**
	 * Master switch: after each assistant reply, run a one-shot extractor
	 * (using the summarizer profile) to surface candidate knowledge nuggets
	 * as a read-only card at the tail of the conversation. Disabled by
	 * default to keep the plugin's footprint quiet.
	 */
	insightExtractionEnabled: boolean;
	/**
	 * Minimum length (in characters, after stripping the structured
	 * follow-up block) of the assistant reply before the extractor runs.
	 * Replies shorter than this are considered too thin to mine.
	 */
	insightExtractionMinReplyChars: number;

	// ── Delegate envelope artifact store ────────────────────────────────────
	/**
	 * Total live-byte budget of a session's artifact store, in KB.
	 * Backs `delegate_task` envelope spills and the `recall_artifact`
	 * tool. Once the running total exceeds this, the least-recently-
	 * accessed artifact is evicted (with a tombstone the model can
	 * still see via `recall_artifact`). Default: 1024 KB (1 MB).
	 *
	 * Validation: values < 1 are treated as misconfigured and the
	 * built-in default is used. Per-session, in-memory only — not
	 * persisted to disk.
	 */
	artifactStoreTotalBytesKb: number;
	/**
	 * Maximum size of a single artifact, in KB. Anything bigger is
	 * rejected at put time and the envelope records a
	 * `too_large_for_store` marker rather than a recoverable artifact.
	 * Default: 128 KB. Should normally be ≤ {@link artifactStoreTotalBytesKb}.
	 *
	 * Validation: values < 1 fall back to the built-in default.
	 */
	artifactStoreSingleArtifactKb: number;
	/**
	 * Time-to-live for an artifact since its last access, in minutes.
	 * `0` explicitly disables TTL (entries only leave via LRU eviction
	 * or session end). Default: 30 minutes.
	 *
	 * Validation: negative values fall back to the built-in default.
	 */
	artifactStoreTtlMinutes: number;
}
