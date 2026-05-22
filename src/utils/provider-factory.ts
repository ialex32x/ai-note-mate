import type NoteAssistantPlugin from "../main";
import { createLLMProvider } from "../services/providers";
import type { LLMProvider } from "../services/llm-provider";
import { getActiveProfile } from "../settings";
import { resolveSecret } from "./secret-helper";

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
 * - Resolves the API key through `app.secretStorage` (the only place
 *   `SecretComponent` ever writes plaintext). A missing secret comes
 *   back as the empty string — callers should treat that exactly like
 *   "no API key configured" rather than passing the empty string to the
 *   provider SDK (every supported provider returns a confusing 401 in
 *   that case).
 *
 * Throws nothing — callers should validate `provider`/`modelName` and surface
 * "no API key" errors at the feature level.
 */
export function createProviderForActiveProfile(plugin: NoteAssistantPlugin): ActiveProfileProvider {
    const settings = plugin.settings;
    const profile = getActiveProfile(settings);

    const apiKey = resolveSecret(plugin.app, profile.apiKey);

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
