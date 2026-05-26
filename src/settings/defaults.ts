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
 * Built-in fallback for the soft per-turn call budget on `rss_fetch_feed`.
 * RSS calls return many feed items at once, so a lower soft threshold than
 * page fetch keeps the agent from turning feed checks into broad crawling.
 */
export const DEFAULT_RSS_FETCH_SOFT_LIMIT = 3;
/**
 * Built-in fallback for the hard per-turn call budget on `rss_fetch_feed`.
 * Allows deliberate comparison across several feeds while still blocking
 * runaway feed enumeration loops within a single user turn.
 */
export const DEFAULT_RSS_FETCH_HARD_LIMIT = 8;

/**
 * Default cap on the number of on-demand tools that pass the retriever
 * ranking. Combined with the always-on tool set (~8 entries), this keeps
 * the per-turn schema list at ~16 tools — within the comfortable range
 * for current frontier models (OpenAI / Anthropic docs cite ~20 as the
 * "tool soup" threshold past which selection accuracy drops sharply)
 * and aligned with {@link DEFAULT_SKILL_FILTER_TOP_K} so the two
 * retrievers behave consistently.
 *
 * Each on-demand tool's schema costs roughly 200–800 tokens of system
 * prompt, so the cap also acts as a soft token-budget guard. 42+
 * on-demand tools register in this project today; top-8 over that pool
 * gives high recall (a turn rarely needs more than 1–3 specific on-
 * demand tools).
 */
export const DEFAULT_TOOL_FILTER_TOP_K = 8;

/**
 * Default cap on sub-agents surfaced per turn. A typical project ships
 * 3–4 sub-agents (vault_inspector, vault_editor, web, code) and most
 * user queries map cleanly to ONE of them, so a top-K of 2 keeps the
 * DELEGATION block tight while still allowing a "search the web, then
 * write the result back into the vault" turn to keep both routes
 * available simultaneously. Sticky-on-history union'ing means a
 * once-used sub-agent never silently disappears from later turns of
 * the same conversation even if the per-turn ranker no longer picks
 * it up.
 *
 * Range cap of 8 in the settings type matches the realistic upper
 * bound — a project with > 8 sub-agents has bigger problems than this
 * knob.
 */
export const DEFAULT_SUB_AGENT_FILTER_TOP_K = 2;

/**
 * Default cap on skills surfaced per turn. Picked to roughly match the
 * tool-filter cap so the two retrievers behave consistently:
 *
 *   - For light users (≤ 8 skills) this is effectively no-op — every
 *     enabled skill lands in the catalogue.
 *   - For heavier users (15–30 skills) it engages the "lost in the
 *     middle" benefit: the retriever's top-8 reliably covers the
 *     query-relevant skills, while the longer tail (which would
 *     otherwise dilute attention and add 60–100 tokens per entry)
 *     stays out of the system prompt.
 *
 * Tunable in settings up to 30 for power users with very large skill
 * libraries.
 */
export const DEFAULT_SKILL_FILTER_TOP_K = 8;

/**
 * Default cosine-similarity floor for the "strong skill match" hint
 * mode. Sized for OpenAI `text-embedding-3-small` whose meaningful
 * matches typically land in the 0.3–0.6 range; models with a higher
 * baseline (BGE, Qwen) usually want to nudge this up. The trigger
 * tester in settings is the source of truth for "what value works for
 * your model".
 */
export const DEFAULT_SKILL_HINT_THRESHOLD = 0.55;
/**
 * Default cosine-similarity floor for the auto-inject mode. Conservative
 * by design so we don't inline irrelevant skill bodies on generic
 * queries. Should normally stay > {@link DEFAULT_SKILL_HINT_THRESHOLD}.
 */
export const DEFAULT_SKILL_AUTO_INJECT_THRESHOLD = 0.75;

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
	insightsProfileId: '',
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
	showAdvanced: false,
	toolConfirmMode: 'auto',
	mcpServers: [],
	skillSearchPaths: [],
	embeddingEnabled: false,
	embeddingConfigs: [],
	activeEmbeddingId: '',
	toolFilterTopK: DEFAULT_TOOL_FILTER_TOP_K,
	skillFilterTopK: DEFAULT_SKILL_FILTER_TOP_K,
	subAgentFilterTopK: DEFAULT_SUB_AGENT_FILTER_TOP_K,
	skillHintThreshold: DEFAULT_SKILL_HINT_THRESHOLD,
	skillAutoInjectThreshold: DEFAULT_SKILL_AUTO_INJECT_THRESHOLD,
	customMenuNotePath: 'MENU.md',
	memoryEnabled: true,
	memoryNotePath: 'MEMORY.md',
	memoryAutoExtract: false,
	memoryCriticalMaxChars: 2000,
	memoryRelevantTopK: 3,
	memoryExtractMaxUpserts: 2,
	memoryExtractMaxDeletes: 1,
	memoryExtractMinReplyChars: 400,
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
	knownTipIds: [],
};
