import { DefaultGeminiImageModel } from "./types";
import type {
	EmbeddingConfig,
	ImageGenConfig,
	NoteAssistantPluginSettings,
	ProviderProfile,
} from "./types";
import { ALL_TOOL_CAPABILITIES } from "../services/llm-provider";

/**
 * Built-in fallback for the soft per-turn call budget on `web_fetch_url`.
 * Sized to cover normal multi-source research (search + read 3–5 results)
 * without nagging, while still kicking in well before the hard limit.
 *
 * Exported so the toolcall layer can apply the same fallback when the
 * user's setting is unset / non-positive, keeping one source of truth.
 */
export const DEFAULT_WEB_FETCH_SOFT_LIMIT = 5;
/**
 * Built-in fallback for the hard per-turn call budget on `web_fetch_url`.
 * Roughly the upper edge of "deep comparison of multiple sources" before
 * the model behaviour shifts from research to thrashing. Chosen jointly
 * with the soft limit (see {@link DEFAULT_WEB_FETCH_SOFT_LIMIT}).
 */
export const DEFAULT_WEB_FETCH_HARD_LIMIT = 12;

/**
 * Default cosine similarity threshold for embedding-based on-demand tool
 * filtering. Tuned for `text-embedding-3-small` whose meaningful matches
 * typically land in the 0.3–0.6 range; users with other embedding models
 * may need to retune via the setting. Exported so the same fallback is
 * used wherever the setting is consumed (settings UI, runtime, tests).
 */
export const DEFAULT_TOOL_FILTER_SIMILARITY_THRESHOLD = 0.3;
/**
 * Default cap on the number of on-demand tools that pass the embedding
 * filter. Combined with the always-on tool set (~6 entries), this keeps
 * the per-turn schema list under ~15 tools, which is comfortable even on
 * smaller-context models.
 */
export const DEFAULT_TOOL_FILTER_TOP_K = 9;

export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultProfile(): ProviderProfile {
	return {
		id: generateId(),
		name: 'DeepSeek',
		provider: 'openai',
		baseUrl: 'https://api.deepseek.com',
		// V4-flash is the current cost-effective default with a 1M
		// context window (replaces the older `deepseek-chat` /
		// `deepseek-reasoner` aliases, both of which are scheduled to
		// retire on 2026-07-24 — see DeepSeek API changelog 2026-04-24).
		// Existing user profiles are unaffected; this only seeds
		// fresh installs and newly-added profiles.
		model: 'deepseek-v4-flash',
		apiKey: '',
		modalities: ['image'],
		maxTokens: 0,
		thinkingLevel: 'auto',
		contextCompressionThreshold: 0,
		slidingWindowSize: 0,
		maxSummariesThreshold: 0,
	};
}

export function createDefaultImageGenConfig(): ImageGenConfig {
	return {
		id: generateId(),
		name: 'Gemini Image Gen',
		apiScheme: 'gemini',
		apiKey: '',
		model: DefaultGeminiImageModel,
	};
}

export function createDefaultEmbeddingConfig(): EmbeddingConfig {
	return {
		id: generateId(),
		name: 'Embedding',
		type: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		apiKey: '',
		model: 'text-embedding-3-small',
	};
}

export const DEFAULT_SETTINGS: NoteAssistantPluginSettings = {
	profiles: [createDefaultProfile()],
	activeProfileId: '',  // will be set to the first profile's id in loadSettings
	summarizerProfileId: '',
	systemPrompt: '',
	imageDownloadDir: 'Attachments',
	builtinWebSearchEnabled: true,
	builtinWebFetchEnabled: true,
	builtinRSSFetchEnabled: true,
	builtinJavaScriptEnabled: false,
	webFetchSoftLimit: DEFAULT_WEB_FETCH_SOFT_LIMIT,
	webFetchHardLimit: DEFAULT_WEB_FETCH_HARD_LIMIT,
	allowedCapabilities: [...ALL_TOOL_CAPABILITIES],
	imageGenConfigs: [],
	activeImageGenId: '',
	enterToSend: true,
	toolConfirmMode: 'auto',
	mcpServers: [],
	skillSearchPaths: [],
	embeddingEnabled: false,
	embeddingConfigs: [],
	activeEmbeddingId: '',
	toolFilterSimilarityThreshold: DEFAULT_TOOL_FILTER_SIMILARITY_THRESHOLD,
	toolFilterTopK: DEFAULT_TOOL_FILTER_TOP_K,
	memoryEnabled: true,
	memories: [],
	followUpSuggestionsEnabled: true,
	followUpSuggestionsStructured: false,
	followUpSuggestionsAutoSend: false,
	insightExtractionEnabled: true,
	insightExtractionMinReplyChars: 400,
	// Mirrors ARTIFACT_STORE_DEFAULTS (1 MB / 128 KB / 30 min). Kept as
	// literals here rather than `import { ARTIFACT_STORE_DEFAULTS }` to
	// avoid pulling the artifact-store module into the cold settings
	// startup path (defaults are read on every plugin load).
	artifactStoreTotalBytesKb: 1024,
	artifactStoreSingleArtifactKb: 128,
	artifactStoreTtlMinutes: 30,
};
