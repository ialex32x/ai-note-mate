import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import type { ImageGenResult, ReferenceImage } from "./types";
import { downloadAsBase64 } from "../../utils/abortable-request";
import { requestUrlWithRetry } from "../../utils/retry-helper";
import { resolveSecret } from "../../utils/secret-helper";
import { retryLogger } from "../../utils/logger";

/**
 * Parameters for Seedream image generation via Ark (方舟).
 */
export interface SeedreamImageGenParams {
    prompt: string;
    /**
     * Aspect ratio string, e.g. "1:1", "16:9". The generator translates
     * this into a concrete pixel size accepted by Seedream. Omit to let
     * the model pick its default (1024x1024).
     */
    aspectRatio?: string;
    /**
     * Negative prompt — what to avoid in the generated image.
     * Seedream 4.0 supports this natively.
     */
    negativePrompt?: string;
    refImages: ReferenceImage[];
    signal?: AbortSignal;
}

/**
 * Map of aspect ratio → pixel size for Seedream.
 *
 * Seedream accepts a subset of common resolutions. Ratios without an
 * exact match are folded to the closest available bucket. All values
 * are within Seedream's documented size constraints.
 */
const SEEDREAM_SIZE_MAP: Record<string, string> = {
    '1:1':  '1024x1024',
    '4:3':  '1152x864',
    '3:2':  '1152x768',
    '16:9': '1664x928',
    '21:9': '1664x704',
    '3:4':  '864x1152',
    '2:3':  '768x1152',
    '9:16': '928x1664',
};

/**
 * Resolve a semantic aspect ratio into a pixel-size string for Seedream.
 * Returns undefined when the aspect ratio is not specified or has no
 * entry in the map — the caller should omit `size` and let the API
 * fall back to its own default.
 */
function resolveSeedreamSize(aspectRatio: string | undefined): string | undefined {
    if (!aspectRatio) return undefined;
    return SEEDREAM_SIZE_MAP[aspectRatio];
}

/**
 * Base URL for the Ark platform image generation endpoint.
 */
const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

interface SeedreamErrorBody {
    error?: {
        code?: string;
        message?: string;
    };
}

interface SeedreamSuccessBody {
    data?: Array<{
        b64_json?: string;
        url?: string;
    }>;
}

/**
 * Generate an image using Seedream via Ark (方舟) platform.
 *
 * Uses pure fetch (Obsidian's `requestUrl`) — no SDK dependency.
 * Supports text-to-image; reference images (image-to-image) are
 * forwarded when the model supports them.
 */
export async function generateImageWithSeedream(
    plugin: NoteAssistantPlugin,
    config: Pick<ImageGenConfig, 'apiKey' | 'model'>,
    params: SeedreamImageGenParams,
): Promise<ImageGenResult> {
    const { prompt, aspectRatio, negativePrompt, refImages, signal } = params;

    const apiKey = resolveSecret(plugin.app, config.apiKey);
    if (!apiKey) {
        return {
            success: false,
            error: "Seedream (Ark) API key is not configured.",
        };
    }
    const model = config.model || "doubao-seedream-4-0-250828";

    const url = `${DEFAULT_ARK_BASE_URL}/images/generations`;

    // Build request body (OpenAI-compatible format, which Ark supports)
    const requestBody: Record<string, unknown> = {
        model,
        prompt,
        n: 1,
        response_format: "b64_json",
    };

    // Attach reference images (image-to-image) via the `image` field.
    // Seedream accepts a single URL/base64 string or an array (up to 14).
    if (refImages.length > 0) {
        const imageUris = refImages.map(
            img => `data:${img.mimeType};base64,${img.base64}`,
        );
        requestBody.image = imageUris.length === 1 ? imageUris[0] : imageUris;
    }

    const resolvedSize = resolveSeedreamSize(aspectRatio);
    if (resolvedSize) {
        requestBody.size = resolvedSize;
    }

    // Seedream supports negative prompts via extra body fields.
    // Ark's OpenAI-compatible endpoint may accept this in `extra_body`
    // or as a top-level field — we try the common pattern.
    if (negativePrompt) {
        requestBody.negative_prompt = negativePrompt;
    }

    try {
        const response = await requestUrlWithRetry(
            {
                url,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify(requestBody),
                throw: false,
            },
            signal,
            { onRetry: retryLogger("[SeedreamImageGen]", "generate") },
        );

        // Handle HTTP error responses
        if (response.status >= 400) {
            const errorBody = response.json as SeedreamErrorBody | undefined;
            const detail = errorBody?.error?.message
                ? `[${errorBody.error.code ?? 'error'}] ${errorBody.error.message}`
                : response.text || `Request failed with status ${response.status}`;
            console.error("[SeedreamImageGen] response error:", url, model, response.status, errorBody);
            return { success: false, error: detail };
        }

        const result = response.json as SeedreamSuccessBody | undefined;

        const data = result?.data;
        if (!data || !Array.isArray(data) || data.length === 0) {
            return {
                success: false,
                error: "No image data returned from the API.",
            };
        }

        const imageItem = data[0]!;

        // Handle b64_json response (preferred — no extra download needed)
        if (imageItem.b64_json) {
            return {
                success: true,
                imageData: imageItem.b64_json,
                mimeType: "image/png",
            };
        }

        // Handle URL response — download the image and inline as base64
        if (imageItem.url) {
            const imageUrl: string = imageItem.url;
            const { base64, mimeType } = await downloadAsBase64(imageUrl, {
                signal,
                fallbackMimeType: "image/png",
            });
            return {
                success: true,
                imageData: base64,
                mimeType,
            };
        }

        return {
            success: false,
            error: "The model did not return any image data or URL.",
        };
    } catch (err) {
        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        const msg = err instanceof Error ? err.message : String(err);
        console.error("[SeedreamImageGen] error:", url, model, err);
        return { success: false, error: msg };
    }
}
