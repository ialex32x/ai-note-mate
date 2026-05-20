import type { App } from "obsidian";
import { createDefaultProfile } from "./defaults";
import { ARTIFACT_STORE_DEFAULTS, type ArtifactStoreOptions } from "../services/artifact-store";
import { getAppSecret } from "../utils/secret-helper";
import type {
	EmbeddingConfig,
	ImageGenConfig,
	NoteAssistantPluginSettings,
	ProviderProfile,
} from "./types";

/**
 * True when the active profile has non-empty `baseUrl`, `model`, and a
 * resolvable API key (including values stored in Obsidian secret storage).
 */
export function isActiveProfileConfigured(
	app: App,
	settings: NoteAssistantPluginSettings,
): boolean {
	if (settings.profiles.length === 0) return false;
	const profile = getActiveProfile(settings);
	if ((profile.baseUrl?.trim() ?? '').length === 0) return false;
	if ((profile.model?.trim() ?? '').length === 0) return false;
	return getAppSecret(app, profile.apiKey).trim().length > 0;
}

/** True when at least one MCP server entry exists in settings. */
export function hasMcpServersConfigured(settings: NoteAssistantPluginSettings): boolean {
	return (settings.mcpServers?.length ?? 0) > 0;
}

/** Helper: get the currently active profile from settings (with fallback) */
export function getActiveProfile(settings: NoteAssistantPluginSettings): ProviderProfile {
	const profile = settings.profiles.find(p => p.id === settings.activeProfileId);
	if (profile) return profile;
	// Fallback to the first profile
	if (settings.profiles.length > 0) return settings.profiles[0]!;
	// Edge case: no profiles at all — create a temporary default
	return createDefaultProfile();
}

export function getSummarizerProfile(settings: NoteAssistantPluginSettings): ProviderProfile {
	const profile = settings.profiles.find(p => p.id === settings.summarizerProfileId);
	if (profile) return profile;
	// Fallback to the first profile
	if (settings.profiles.length > 0) return settings.profiles[0]!;
	// Edge case: no profiles at all — create a temporary default
	return createDefaultProfile();
}

/** Profile dedicated to insight extraction, when configured. */
export function getInsightsProfile(settings: NoteAssistantPluginSettings): ProviderProfile {
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

/** Helper: get the currently active embedding config from settings (may be null) */
export function getActiveEmbeddingConfig(settings: NoteAssistantPluginSettings): EmbeddingConfig | null {
	if (!settings.embeddingEnabled) return null;
	if (settings.embeddingConfigs.length === 0) return null;
	const config = settings.embeddingConfigs.find(c => c.id === settings.activeEmbeddingId);
	if (config) return config;
	// Fallback to the first config
	return settings.embeddingConfigs[0]!;
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
