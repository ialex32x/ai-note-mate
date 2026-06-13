import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import { resolveSecret } from "../../utils/secret-helper";
import type { ImageGenResult, ReferenceImage } from "./types";
import { GEMINI_BASE_URL, API_KEY_HEADER } from "../providers/gemini-provider";
import { fetchWithRetry } from "../../utils/retry-helper";

const retryLogger = (ctx: string) =>
    (err: unknown, n: number) => console.warn(`[GeminiImageGen] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);

/**
 * Parameters for Gemini image generation.
 */
export interface GeminiImageGenParams {
    prompt: string;
    /** Aspect ratio string, e.g. "1:1", "16:9". Optional — model picks default when omitted. */
    aspectRatio?: string;
    /** Discrete size bucket. Gemini supports "1K" (default), "2K", "4K". */
    imageSize?: string;
    refImages: ReferenceImage[];
    signal?: AbortSignal;
}

/**
 * Generate an image using Gemini API.
 *
 * Uses Gemini's built-in multimodal `generateContent` endpoint with
 * `responseModalities: ["IMAGE"]` to generate images from text prompts
 * (optionally with reference images for image-to-image).
 */
export async function generateImageWithGemini(
    plugin: NoteAssistantPlugin,
    config: Pick<ImageGenConfig, "apiKey" | "model">,
    params: GeminiImageGenParams,
): Promise<ImageGenResult> {
    const { prompt, aspectRatio, imageSize, refImages, signal } = params;

    // Resolve first, then validate: see openai-image.ts for the full rationale.
    const apiKey = resolveSecret(plugin.app, config.apiKey);
    if (!apiKey) {
        return {
            success: false,
            error: "Gemini API key is not configured.",
        };
    }
    const model = config.model || "gemini-3-pro-image-preview";

    // Build contents: text prompt + optional reference images (already loaded & validated).
    const rawContents = buildContents(prompt, refImages);
    // The REST API requires `contents` to be an array of Content objects,
    // but `buildContents` returns a plain string when there are no reference
    // images. Wrap the string into the standard Content array shape.
    const contents: Array<Record<string, unknown>> =
        typeof rawContents === "string"
            ? [{ parts: [{ text: rawContents }] }]
            : rawContents;

    // Only attach imageConfig when the caller actually specified a dimension
    // hint; otherwise let the model fall back to its own defaults.
    const imageConfig: { aspectRatio?: string; imageSize?: string } = {};
    if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
    if (imageSize) imageConfig.imageSize = imageSize;

    // Build request body for the REST API.
    // `responseModalities` and `imageConfig` live inside `generationConfig`.
    const generationConfig: Record<string, unknown> = {
        responseModalities: ["IMAGE"],
    };
    if (Object.keys(imageConfig).length > 0) {
        generationConfig.imageConfig = imageConfig;
    }

    const body: Record<string, unknown> = {
        contents,
        generationConfig,
    };

    try {
        const response = await fetchWithRetry(
            `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: "POST",
                headers: {
                    [API_KEY_HEADER]: apiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal,
            },
            { onRetry: retryLogger("generateContent") },
        );

        // Check abort after the long API call
        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        if (!response.ok) {
            const errorBody = await response.text().catch(() => "");
            return {
                success: false,
                error: `Gemini image generation error ${response.status}: ${errorBody || response.statusText}`,
            };
        }

        const data = (await response.json()) as {
            candidates?: Array<{
                content?: {
                    parts?: Array<Record<string, unknown>>;
                };
            }>;
        };

        // Extract image parts from the response
        const parts = data.candidates?.[0]?.content?.parts;
        if (!parts || parts.length === 0) {
            return {
                success: false,
                error: "No content returned from the image generation model.",
            };
        }

        // Find the first image part and any text parts
        for (const part of parts) {
            if (part.inlineData && typeof part.inlineData === "object") {
                const inlineData = part.inlineData as {
                    mimeType: string;
                    data: string;
                };
                if (inlineData.data) {
                    return {
                        success: true,
                        imageData: inlineData.data,
                        mimeType: inlineData.mimeType || "image/png",
                    };
                }
            }
        }

        // No image found, return any text content
        const textParts: string[] = [];
        for (const part of parts) {
            if (part.text && typeof part.text === "string") {
                textParts.push(part.text);
            }
        }

        const text = textParts.join("\n").trim();
        if (text) {
            return { success: true, text };
        }

        return {
            success: false,
            error: "The model did not generate any image.",
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[GeminiImageGen] Error:", err);
        return { success: false, error: msg };
    }
}

/**
 * Build the contents for the API, including the prompt and any reference images.
 * Reference images are assumed to be already loaded and validated by the caller.
 */
function buildContents(
    prompt: string,
    refImages: ReferenceImage[],
):
    | string
    | Array<{
          role: "user";
          parts: Array<Record<string, unknown>>;
      }> {
    if (!refImages || refImages.length === 0) {
        return prompt;
    }

    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const img of refImages) {
        parts.push({
            inlineData: { mimeType: img.mimeType, data: img.base64 },
        });
    }
    return [{ role: "user", parts }];
}
