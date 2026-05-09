import type NoteAssistantPlugin from "../main";
import { createLLMProvider } from "../services/providers";
import type { LLMProvider } from "../services/llm-provider";
import { getActiveProfile } from "../settings";

/**
 * Resolved provider bundle for the currently active profile.
 *
 * Centralized here so any feature that needs an `LLMProvider` (chat, edit
 * history, summarizer, etc.) reads the API key, base URL, model and
 * modalities from a single place — and any future change to provider
 * resolution logic only has to be made once.
 */
export interface ActiveProfileProvider {
    /** Live `LLMProvider` instance, ready to call `createStream` / `listModels`. */
    provider: LLMProvider;
    /** Display name of the resolved profile, suitable for UI. */
    profileName: string;
    /** Model identifier the provider was configured with, suitable for UI. */
    modelName: string;
}

/**
 * Build an `LLMProvider` for the user's currently active profile.
 *
 * - Falls back to the first profile (or a synthetic default) if the active
 *   profile id is stale, mirroring `getActiveProfile` semantics.
 * - Resolves the API key through `app.secretStorage` first, then falls back
 *   to the raw value stored on the profile (legacy plain-text storage).
 *
 * Throws nothing — callers should validate `provider`/`modelName` and surface
 * "no API key" errors at the feature level.
 */
export function createProviderForActiveProfile(plugin: NoteAssistantPlugin): ActiveProfileProvider {
    const settings = plugin.settings;
    const profile = getActiveProfile(settings);

    const apiKey = plugin.app.secretStorage.getSecret(profile.apiKey) ?? profile.apiKey;

    const provider = createLLMProvider(profile.provider, {
        apiKey,
        baseURL: profile.baseUrl,
        model: profile.model,
        modalities: profile.modalities,
    });

    return {
        provider,
        profileName: profile.name,
        modelName: profile.model,
    };
}
