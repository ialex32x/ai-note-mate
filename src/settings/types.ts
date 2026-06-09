import type { LLMProviderType, EmbeddingProviderType } from "../services/providers";
import type { MCPServerConfig } from "../services/mcp/mcp-types";
import type { ModalityCapability, ThinkingLevel, ToolCapability } from "../services/llm-provider";

export const DefaultGeminiImageModel = "gemini-3-pro-image-preview";

export const DefaultDashScopeShortModel = "qwen3-asr-flash";
export const DefaultDashScopeLongModel = "qwen3-asr-flash-filetrans";

// ─────────────────────────────────────────────────────────────────────────────
// Provider Profile
// ─────────────────────────────────────────────────────────────────────────────

export interface TextGenConfig {
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

	/**
	 * Thinking / reasoning effort level forwarded to the provider.
	 * Optional for backward compatibility with profiles saved before this
	 * field existed — missing values are treated as {@link ThinkingLevel} `"auto"`
	 * by the providers (i.e. the parameter is omitted from the API call,
	 * preserving each provider's native default).
	 *
	 * Translation to native API surface lives in each provider's
	 * `createStream`. See the {@link ThinkingLevel} docstring for the
	 * mapping per provider.
	 */
	thinkingLevel?: ThinkingLevel;

	// ── Context compression (per-profile tuning) ───────────────────────────
	/**
	 * Token threshold that triggers context compression for this profile.
	 * 0 = auto (computed as ~45% of the model's context window).
	 * Lower it when many tools are enabled (their JSON schemas count
	 * toward this budget) or when the model has a smaller context window.
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

export type ImageGenApiScheme = 'gemini' | 'qwen' | 'openai' | 'seedream';

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
// Speech-to-Text
// ─────────────────────────────────────────────────────────────────────────────

export type SpeechToTextApiScheme = 'DashScope';

/** DashScope region identifiers for speech-to-text. */
export type DashScopeRegion = 'cn-beijing' | 'us-east-1' | 'ap-southeast-1' | 'eu-central-1';

export interface SpeechToTextConfig {
	/** Unique ID (auto-generated) */
	id: string;
	/** Display name for this config */
	name: string;
	/** API scheme to distinguish which API to use */
	apiScheme: SpeechToTextApiScheme;

	// ── DashScope-specific fields ───────────────────────────────────────────
	/** DashScope region to use */
	region: DashScopeRegion;
	/**
	 * Workspace ID. Required for Singapore and Frankfurt regions;
	 * optional for cn-beijing and us-east-1.
	 */
	workspaceId: string;
	/** API key for DashScope */
	apiKey: string;
	/** Model for short audio transcription (inline API) */
	shortModel: string;
	/** Model for long audio transcription (async file API) */
	longModel: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Settings
// ─────────────────────────────────────────────────────────────────────────────

export interface NoteAssistantPluginSettings {
	/** ID of the currently active profile */
	activeProfileId: string;
	/** ID of the current profile used as context summarizer (usually the one with lower token cost) */
	summarizerProfileId: string;
	/**
	 * Profile used for conversation insight extraction. Empty string means
	 * "same as summarizer" ({@link summarizerProfileId}).
	 */
	insightsProfileId: string;
	/** ID of the currently active image generation config */
	activeImageGenId: string;
	/** ID of the currently active embedding config */
	activeEmbeddingId: string;

	/** Saved provider profiles */
	profiles: TextGenConfig[];

	// ── Global settings (not per-profile) ───────────────────────────────────
	systemPrompt: string;
	imageDownloadDir: string;
	/**
	 * Vault-relative directory where the "Save as note" action writes the
	 * exported session markdown. Empty string means the feature is
	 * unconfigured — invoking the action surfaces a Notice nudging the
	 * user to set this in Settings → General.
	 *
	 * The directory is created on demand (after a confirmation prompt the
	 * first time the configured path doesn't exist yet). Vault.create()
	 * does not auto-create parent folders, so we bridge that with an
	 * explicit createFolder() call before write.
	 */
	saveAsNoteDir: string;

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
	/** When true, settings marked as advanced are shown in the settings UI. */
	showAdvanced: boolean;
	/** Image generation configs array. If empty, image generation is disabled. */
	imageGenConfigs: ImageGenConfig[];
	/** ID of the currently active speech-to-text config */
	activeSpeechToTextId: string;
	/** Speech-to-text configs array. If empty, speech-to-text is disabled. */
	speechToTextConfigs: SpeechToTextConfig[];
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
	/** Embedding configs array. Empty when no configs have been added. */
	embeddingConfigs: EmbeddingConfig[];
	/**
	 * Maximum number of on-demand tools surfaced to the model after
	 * the retriever (BM25, fused with embedding cosine via RRF when
	 * embedding is configured) ranks them. Always-on tools are not
	 * counted toward this cap. Range [1, 30]. Lower values produce
	 * smaller, more focused tool schemas (helps on smaller-context
	 * models); higher values are safer for vault-wide tasks that
	 * need many distinct on-demand tools in one turn.
	 *
	 * There is intentionally no score threshold for the retriever —
	 * BM25 and RRF scores have no stable cross-model scale to
	 * threshold against. The escalation thresholds further below
	 * (skill hint / auto-inject) remain cosine-based and only fire
	 * when embedding is configured.
	 */
	toolFilterTopK: number;

	/**
	 * Maximum number of skills surfaced to the model in the per-turn
	 * skills catalogue after retriever ranking. Range [1, 30].
	 * Defaults higher than the tool-filter cap because skills are
	 * usually few and the per-skill rendering is light.
	 */
	skillFilterTopK: number;

	/**
	 * Maximum number of sub-agents surfaced to the main agent's
	 * system prompt (and to the `delegate_task` tool's `agent` enum)
	 * after the per-turn sub-agent retriever ranks the configured
	 * sub-agents against the current user query. Range [1, 8].
	 *
	 * The retriever is the same hybrid BM25 + embedding RRF that
	 * powers {@link toolFilterTopK} and {@link skillFilterTopK}, so
	 * "no embedding configured" gracefully degrades to BM25-only
	 * over each sub-agent's `name + description + routingKeywords`.
	 *
	 * Lower values (1–2) maximize token savings: a casual chat turn
	 * with no sub-agent match emits NO DELEGATION block at all. Higher
	 * values are safer for power users who want every sub-agent kept
	 * in the prompt budget at all times. The orchestrator also union's
	 * this shortlist with sub-agents that have been used earlier in
	 * the conversation history (sticky-on-history), so a recurring
	 * delegation never silently disappears from the prompt mid-session.
	 */
	subAgentFilterTopK: number;

	/**
	 * Cosine-similarity floor above which the top-1 matched skill gets
	 * a "strong skill match" hint line at the top of the catalogue. The
	 * model is nudged toward calling `load_skill` for it without the
	 * body actually being injected. Range [0, 1]; clamped at use-site.
	 *
	 * Tune to match your embedding model's score distribution — what
	 * counts as "strongly relevant" varies wildly between models (see
	 * the trigger tester in Settings → Skills).
	 *
	 * Soft constraint: should normally be ≤ {@link skillAutoInjectThreshold}
	 * so the escalation order (plain → hint → auto-inject) stays
	 * monotonic. The catalogue builder clamps `autoInject` upward to
	 * `hint` if the user gets them out of order, so the worst case is
	 * one mode is unreachable, never broken behaviour.
	 */
	skillHintThreshold: number;
	/**
	 * Cosine-similarity floor above which the top-1 matched skill is
	 * auto-injected (full body) into the system prompt — no `load_skill`
	 * round trip needed. Range [0, 1]; clamped at use-site.
	 *
	 * See {@link skillHintThreshold} for tuning guidance and the
	 * ordering constraint with the hint threshold.
	 */
	skillAutoInjectThreshold: number;

	// ── Custom menu (user-defined right-click prompts) ──────────────────────
	/**
	 * Vault-relative path of the markdown note that defines custom menu items.
	 * Each H1 heading selects a surface (Files → file-menu, Editor → editor-
	 * menu); each H2 heading is a menu label whose body is the prompt template
	 * (with blockquote lines stripped as user comments).
	 *
	 * The prompt template may use `{{filepath}}`, `{{selection}}`, and
	 * `{{blockquote}}` placeholder variables, replaced at click time with
	 * concrete values from the current file / editor context.
	 *
	 * Default: `'MENU.md'`. Empty string disables the feature.
	 */
	customMenuNotePath: string;

	// ── Memory (heading-anchored note store) ───────────────────────────────
	/**
	 * Master switch for the Memory feature. When false, the memory tools are
	 * not registered, no memory prompt prefix is injected, and the auto
	 * extractor never runs — regardless of {@link memoryAutoExtract}.
	 */
	memoryEnabled: boolean;
	/**
	 * Vault-relative path of the markdown note that stores memory entries.
	 * Each entry is a `##` section; titles ending in `[!]` (after trimming)
	 * are treated as critical (every-turn injection), the rest enter the
	 * embedding-shortlisted pool.
	 *
	 * Empty string disables the feature at runtime (same effect as
	 * {@link memoryEnabled} being false). The file is auto-created with a
	 * starter template the first time a write hits a missing path.
	 */
	memoryNotePath: string;
	/**
	 * When true, after every user → assistant turn an extra (cheap) LLM call
	 * extracts candidate memory upserts/deletes and applies them to the
	 * memory note. Default off — the explicit `memory_store` / `memory_delete`
	 * tool path remains the no-cost-by-default channel.
	 */
	memoryAutoExtract: boolean;
	/**
	 * Soft cap on the total character budget of critical memories injected
	 * every turn. Critical entries exceeding this budget are dropped from
	 * the prefix (with a console warning) instead of overrunning the prompt.
	 * Counts the rendered list text only — not embedding or relevant pool.
	 */
	memoryCriticalMaxChars: number;
	/**
	 * Maximum number of relevant (non-critical) memory entries selected per
	 * turn by the retriever (BM25, fused with embedding cosine when
	 * configured). Critical entries do not count toward this cap. Range
	 * [0, 30]; 0 disables the relevant pool entirely.
	 */
	memoryRelevantTopK: number;
	/**
	 * Per-turn upper bound on `upsert` operations the auto extractor may
	 * apply. Prevents a single noisy reply from saturating the memory note.
	 */
	memoryExtractMaxUpserts: number;
	/**
	 * Per-turn upper bound on `delete` operations the auto extractor may
	 * apply. Kept smaller than upserts — deletes are higher-stakes since
	 * they remove information the user once authored or accepted.
	 */
	memoryExtractMaxDeletes: number;
	/**
	 * Minimum length (in characters, after stripping the structured
	 * follow-up block) of the assistant reply before the auto extractor
	 * runs. Replies shorter than this are skipped.
	 */
	memoryExtractMinReplyChars: number;

	// ── Follow-up quick-pick suggestions ────────────────────────────────────
	/** Master switch: render quick-pick buttons for next actions proposed at the end of an assistant reply. */
	followUpSuggestionsEnabled: boolean;
	/** When true, instruct the model (via system prompt) to emit a structured <!--suggestions--> block. */
	followUpSuggestionsStructured: boolean;

	// ── Conversation insight extraction (knowledge-nugget preview) ──────────
	/**
	 * Master switch: after each assistant reply, run a one-shot extractor
	 * (using {@link insightsProfileId} or, when empty, the summarizer
	 * profile) to surface candidate knowledge nuggets as a read-only card
	 * at the tail of the conversation.
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

	// ── Onboarding tips ─────────────────────────────────────────────
	/**
	 * IDs of contextual usage tips the user has already dismissed or
	 * executed. Used by the tips popover in the input toolbar to filter
	 * out tips the user has already engaged with so they never reappear.
	 *
	 * Treat IDs as a stable API once a tip is released: removing a tip
	 * definition is safe (its ID just becomes a no-op residue in this
	 * list), but renaming would cause the previously-dismissed entry to
	 * reappear under the new id.
	 */
	knownTipIds: string[];
}
