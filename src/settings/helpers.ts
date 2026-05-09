import { createDefaultProfile } from "./defaults";
import type {
	EmbeddingConfig,
	ImageGenConfig,
	NoteAssistantPluginSettings,
	ProviderProfile,
} from "./types";

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
