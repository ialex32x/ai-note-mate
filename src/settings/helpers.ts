import type { App } from "obsidian";
import { createDefaultProfile } from "./defaults";
import { ARTIFACT_STORE_DEFAULTS, type ArtifactStoreOptions } from "../services/artifact-store";
import { createLLMProvider } from "../services/providers";
import type { LLMProvider } from "../services/llm-provider";
import { resolveSecret } from "../utils/secret-helper";
import type {
	EmbeddingConfig,
	ImageGenConfig,
	NoteAssistantPluginSettings,
	SpeechToTextConfig,
	TextGenConfig,
} from "./types";

/**
 * True when the active profile has non-empty `baseUrl`, `model`, and a
 * resolvable API key (including values stored in Obsidian secret storage).
 */
export function isActiveTextGenConfigured(
	app: App,
	settings: NoteAssistantPluginSettings,
): boolean {
	if (settings.profiles.length === 0) return false;
	const profile = getActiveProfile(settings);
	if ((profile.baseUrl?.trim() ?? '').length === 0) return false;
	if ((profile.model?.trim() ?? '').length === 0) return false;
	return resolveSecret(app, profile.apiKey).trim().length > 0;
}

/** True when at least one MCP server entry exists in settings. */
export function hasMcpServersConfigured(settings: NoteAssistantPluginSettings): boolean {
	return (settings.mcpServers?.length ?? 0) > 0;
}

/** Helper: get the currently active profile from settings (with fallback) */
export function getActiveProfile(settings: NoteAssistantPluginSettings): TextGenConfig {
	const profile = settings.profiles.find(p => p.id === settings.activeProfileId);
	if (profile) return profile;
	// Fallback to the first profile
	if (settings.profiles.length > 0) return settings.profiles[0]!;
	// Edge case: no profiles at all — create a temporary default
	return createDefaultProfile();
}

export function getSummarizerProfile(settings: NoteAssistantPluginSettings): TextGenConfig {
	const profile = settings.profiles.find(p => p.id === settings.summarizerProfileId);
	if (profile) return profile;
	// Fallback to the first profile
	if (settings.profiles.length > 0) return settings.profiles[0]!;
	// Edge case: no profiles at all — create a temporary default
	return createDefaultProfile();
}

/** Profile dedicated to insight extraction, when configured. */
export function getInsightsProfile(settings: NoteAssistantPluginSettings): TextGenConfig {
	const profile = settings.profiles.find(p => p.id === settings.insightsProfileId);
	if (profile) return profile;
	if (settings.profiles.length > 0) return settings.profiles[0]!;
	return createDefaultProfile();
}

/** Helper: get the currently active image generation config from settings (may be null) */
export function getActiveImageGenConfig(settings: NoteAssistantPluginSettings): ImageGenConfig | null {
	if (settings.imageGenConfigs.length === 0) return null;
	const config = settings.imageGenConfigs.find(c => c.id === settings.activeImageGenId);
	if (config) return config;
	// Fallback to the first config
	return settings.imageGenConfigs[0]!;
}

/**
 * True when the active image generation config has a model, a resolvable
 * API key, and (for OpenAI-compatible schemes) a non-empty base URL.
 */
export function isActiveImageGenConfigured(
	app: App,
	settings: NoteAssistantPluginSettings,
): boolean {
	const config = getActiveImageGenConfig(settings);
	if (!config) return false;
	if ((config.model?.trim() ?? '').length === 0) return false;
	if (resolveSecret(app, config.apiKey).trim().length === 0) return false;
	if (config.apiScheme === 'openai' && (config.baseUrl?.trim() ?? '').length === 0) {
		return false;
	}
	return true;
}

/** Helper: get the currently active embedding config from settings (may be null) */
export function getActiveEmbeddingConfig(settings: NoteAssistantPluginSettings): EmbeddingConfig | null {
	if (!settings.activeEmbeddingId) return null;
	if (settings.embeddingConfigs.length === 0) return null;
	const config = settings.embeddingConfigs.find(c => c.id === settings.activeEmbeddingId);
	if (config) return config;
	// Fallback to the first config
	return settings.embeddingConfigs[0]!;
}

/** Helper: get the currently active speech-to-text config from settings (may be null) */
export function getActiveSpeechToTextConfig(settings: NoteAssistantPluginSettings): SpeechToTextConfig | null {
	if (settings.speechToTextConfigs.length === 0) return null;
	const config = settings.speechToTextConfigs.find(c => c.id === settings.activeSpeechToTextId);
	if (config) return config;
	return settings.speechToTextConfigs[0]!;
}

/**
 * Derive the DashScope base URL (origin only) from the region and optional
 * Workspace ID.
 *
 *   - cn-beijing     → https://dashscope.aliyuncs.com
 *   - us-east-1      → https://dashscope-us.aliyuncs.com
 *   - ap-southeast-1 → https://{workspaceId}.ap-southeast-1.maas.aliyuncs.com
 *   - eu-central-1   → https://{workspaceId}.eu-central-1.maas.aliyuncs.com
 */
export function getSttBaseUrl(region: string, workspaceId: string): string {
	switch (region) {
		case 'cn-beijing':
			return 'https://dashscope.aliyuncs.com';
		case 'us-east-1':
			return 'https://dashscope-us.aliyuncs.com';
		case 'ap-southeast-1':
			return `https://${workspaceId}.ap-southeast-1.maas.aliyuncs.com`;
		case 'eu-central-1':
			return `https://${workspaceId}.eu-central-1.maas.aliyuncs.com`;
		default:
			return 'https://dashscope.aliyuncs.com';
	}
}

/**
 * True when the active speech-to-text config has models, a resolvable
 * API key, and workspaceId for regions that require it.
 */
export function isActiveSpeechToTextConfigured(
	app: App,
	settings: NoteAssistantPluginSettings,
): boolean {
	const config = getActiveSpeechToTextConfig(settings);
	if (!config) return false;

	switch (config.apiScheme) {
		case 'TencentCloud': {
			if ((config.secretId || '').trim().length === 0) return false;
			if (resolveSecret(app, config.secretKey).trim().length === 0) return false;
			if ((config.engineModelType || '').trim().length === 0) return false;
			// COS is optional, but if bucket is configured it must be paired
			// with a region and have valid name-appid format.
			const bucket = (config.cosBucket || '').trim();
			const cosRegion = (config.cosRegion || '').trim();
			if (bucket && (!cosRegion || !isValidCosBucketName(bucket))) return false;
			return true;
		}
		case 'DashScope':
		default: {
			if ((config.shortModel || '').trim().length === 0) return false;
			if ((config.longModel || '').trim().length === 0) return false;
			// workspaceId is required for Singapore and Frankfurt
			if ((config.region === 'ap-southeast-1' || config.region === 'eu-central-1')
				&& (config.workspaceId || '').trim().length === 0) {
				return false;
			}
			return resolveSecret(app, config.apiKey).trim().length > 0;
		}
	}
}

/**
 * Helper: derive {@link ArtifactStoreOptions} from plugin settings.
 *
 * Validation policy (mirrors §1.3 of `docs/delegate-envelope-artifact-plan.md`):
 *   - `totalBytesKb` / `singleArtifactKb` < 1 fall back to the built-in
 *     default. Zero or negative byte budgets would either disable the
 *     store entirely or break the LRU loop's termination invariant; both
 *     are misconfigurations rather than features, so silently snap to a
 *     sane value.
 *   - `ttlMinutes` < 0 falls back to default. `0` is **kept** verbatim
 *     because the store treats `ttlMs === 0` as "TTL disabled" — that's
 *     a legitimate user choice (long-running research sessions where
 *     LRU + total-byte cap are the only desired evictors).
 *
 * The conversion to bytes / ms is done here, not in the store, so the
 * store stays in its native units and tests can pass byte counts
 * directly without going through the settings layer.
 */
export function deriveArtifactStoreOptions(settings: NoteAssistantPluginSettings): ArtifactStoreOptions {
	const totalKb = settings.artifactStoreTotalBytesKb;
	const totalBytesCap = totalKb >= 1
		? Math.floor(totalKb * 1024)
		: ARTIFACT_STORE_DEFAULTS.totalBytesCap;

	const singleKb = settings.artifactStoreSingleArtifactKb;
	const singleArtifactCap = singleKb >= 1
		? Math.floor(singleKb * 1024)
		: ARTIFACT_STORE_DEFAULTS.singleArtifactCap;

	const ttlMinutes = settings.artifactStoreTtlMinutes;
	const ttlMs = ttlMinutes >= 0
		? Math.floor(ttlMinutes * 60_000)
		: ARTIFACT_STORE_DEFAULTS.ttlMs;

	return { totalBytesCap, singleArtifactCap, ttlMs };
}

/**
 * Validate a COS bucket name.
 *
 * COS bucket names use the format `{BucketName}-{APPID}` where:
 *   - BucketName: 1-50 characters, lowercase letters, digits, and hyphens.
 *   - APPID: numeric string (e.g. "1250000000").
 */
export function isValidCosBucketName(bucket: string): boolean {
	return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]-[0-9]+$/.test(bucket);
}

/**
 * True when COS is fully configured for large-file transcription.
 * Requires a valid bucket name and non-empty region.
 */
export function isCosConfigured(config: SpeechToTextConfig): boolean {
	const bucket = (config.cosBucket || '').trim();
	const region = (config.cosRegion || '').trim();
	return bucket.length > 0 && region.length > 0 && isValidCosBucketName(bucket);
}

/**
 * Resolve an `LLMProvider` for a sub-agent that overrides its profile.
 *
 * Looks up the profile by id from settings, resolves its API key through
 * Obsidian's secret storage, and creates a fresh provider instance.
 *
 * @param app          Obsidian App (for secret resolution)
 * @param settings     Plugin settings (for profile lookup)
 * @param profileId    Profile id to resolve. Empty string means "inherited".
 * @returns A new `LLMProvider`, or `undefined` when the profile is
 *          inherited (empty id), the profile is not found, or the API key
 *          cannot be resolved. Callers should fall back to the main agent's
 *          provider when `undefined` is returned.
 */
export function resolveSubAgentProvider(
	app: App,
	settings: NoteAssistantPluginSettings,
	profileId: string,
): LLMProvider | undefined {
	if (!profileId) return undefined;

	const profile = settings.profiles.find(p => p.id === profileId);
	if (!profile) return undefined;

	const apiKey = resolveSecret(app, profile.apiKey);
	if (!apiKey) return undefined;

	return createLLMProvider(profile.provider, {
		apiKey,
		baseURL: profile.baseUrl,
		model: profile.model,
		modalities: profile.modalities,
	});
}

/**
 * Resolve a profile ID to a display model name for sub-agent message
 * tagging. Returns {@link TextGenConfig.model} — the same model
 * identifier the provider was created with.
 *
 * Returns `undefined` when the profile ID is empty or the profile is
 * not found — callers should fall back to the main agent's model name.
 */
export function resolveSubAgentModelName(
	settings: NoteAssistantPluginSettings,
	profileId: string,
): string | undefined {
	if (!profileId) return undefined;

	const profile = settings.profiles.find(p => p.id === profileId);
	if (!profile) return undefined;

	return profile.model || undefined;
}
