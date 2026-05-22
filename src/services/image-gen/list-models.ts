import type { App } from "obsidian";
import { createLLMProvider } from "../providers";
import { resolveSecret } from "../../utils/secret-helper";
import type { ImageGenConfig } from "../../settings/types";

/**
 * Well-known DashScope Qwen image generation models.
 *
 * DashScope does not expose a focused "image models" listing endpoint —
 * its OpenAI-compatible `/models` returns the user's entire enabled model
 * catalogue mixed with text / embedding / audio models, which would be
 * confusing in the picker. The set below covers the families this plugin
 * already understands in {@link ../image-gen/qwen-image.ts `detectQwenSizeFamily`}:
 *   - Fixed-size family: `qwen-image`, `qwen-image-plus`, `qwen-image-max`
 *   - Free-form edit family: `qwen-image-edit`, `qwen-image-edit-plus`,
 *     `qwen-image-edit-max`
 *
 * Users can still type a custom model identifier in the input — the list
 * is a discovery aid, not a hard whitelist.
 */
const KNOWN_QWEN_IMAGE_MODELS: ReadonlyArray<string> = [
    "qwen-image",
    "qwen-image-plus",
    "qwen-image-max",
    "qwen-image-edit",
    "qwen-image-edit-plus",
    "qwen-image-edit-max",
];

/**
 * Fetch the list of models available for an image generation config.
 *
 * Per-scheme strategy:
 *  - `openai` / `gemini`: delegate to the existing chat LLM provider's
 *    `listModels()` (created on the fly from the image-gen config). The
 *    upstream `/models` endpoint returns the account's full catalogue;
 *    the picker UI filters/searches client-side.
 *  - `qwen`: return the hardcoded well-known list (see comment on
 *    {@link KNOWN_QWEN_IMAGE_MODELS}).
 *
 * Throws when the chosen provider's `listModels()` rejects — the caller
 * (settings UI) surfaces a generic "fetch failed" notice and logs the
 * raw error for diagnostics.
 */
export async function listImageGenModels(
    app: App,
    config: Pick<ImageGenConfig, "apiScheme" | "apiKey" | "baseUrl" | "model">,
): Promise<string[]> {
    const apiKey = resolveSecret(app, config.apiKey);

    switch (config.apiScheme) {
        case "openai": {
            // `model` is only used by OpenAIProvider for the stream path,
            // not for `models.list()`. Falling back to "dall-e-3" keeps
            // the provider construction valid when the user hasn't
            // picked a model yet.
            return createLLMProvider("openai", {
                apiKey,
                baseURL: config.baseUrl,
                model: config.model || "dall-e-3",
            }).listModels();
        }
        case "gemini": {
            return createLLMProvider("gemini", {
                apiKey,
                model: config.model || "gemini-2.5-flash",
            }).listModels();
        }
        case "qwen": {
            return [...KNOWN_QWEN_IMAGE_MODELS];
        }
    }
}
