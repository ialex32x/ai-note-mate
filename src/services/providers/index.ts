import type { LLMProvider, LLMProviderConfig } from "../llm-provider";
import { OpenAIProvider } from "./openai-provider";
import { GeminiProvider } from "./gemini-provider";
import { AnthropicProvider } from "./anthropic-provider";

/**
 * Supported LLM (Large Language Model) provider types for chat and summarization.
 *
 * Each value maps to a concrete {@link LLMProvider} implementation that is
 * instantiated by {@link createLLMProvider}:
 *
 * - `"openai"` — OpenAI-compatible API (GPT series, etc.)
 * - `"gemini"` — Google Gemini API
 * - `"anthropic"` — Anthropic (Claude) API
 *
 * When adding a new provider, append its identifier here **and** add the
 * corresponding `case` branch in {@link createLLMProvider}.
 */
export type LLMProviderType = "openai" | "gemini" | "anthropic";

/**
 * Supported provider types for text-embedding.
 *
 * Defined independently from {@link LLMProviderType} so that the set of
 * embedding providers can diverge from chat/summarization providers in the
 * future without breaking existing configurations.
 *
 * Note: `"anthropic"` is included here so summarizer/insights profiles
 * (which reuse `MinimalModelConfig`) can be Anthropic-backed, even though
 * Anthropic does not offer an embeddings API. The embedding dispatcher
 * throws a descriptive error for `"anthropic"`.
 */
export type EmbeddingProviderType = "openai" | "gemini" | "anthropic";

/**
 * Factory function that creates a concrete {@link LLMProvider} instance
 * based on the given provider type and configuration.
 *
 * @param type   - The provider type identifier (e.g. `"openai"`, `"gemini"`).
 * @param config - Provider-specific configuration (API key, base URL, etc.).
 * @returns A ready-to-use {@link LLMProvider} instance.
 * @throws {Error} If the provider type is not recognized.
 */
export function createLLMProvider(
    type: LLMProviderType,
    config: LLMProviderConfig,
): LLMProvider {
    switch (type) {
        case "openai":
            return new OpenAIProvider(config);
        case "gemini":
            return new GeminiProvider(config);
        case "anthropic":
            return new AnthropicProvider(config);
        default:
            throw new Error(`Unknown LLM provider type: ${String(type)}`);
    }
}
