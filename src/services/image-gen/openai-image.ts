import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import type { ImageGenResult, ReferenceImage } from "./types";
import { downloadAsBase64 } from "../../utils/abortable-request";
import { resolveSecret } from "../../utils/secret-helper";
import { corsFreeFetchWithRetry } from "../../utils/retry-helper";

const retryLogger = (ctx: string) =>
    (err: unknown, n: number) => console.warn(`[OpenAIImageGen] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);

/** Default base URL for the OpenAI API. */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Parameters for OpenAI-compatible image generation.
 */
export interface OpenAIImageGenParams {
    prompt: string;
    /**
     * Image size string (e.g. "1024x1024", "1792x1024", "auto").
     * Optional — when omitted, the API picks the model-specific default
     * (DALL-E 3 → 1024x1024, gpt-image-1 → auto, etc.).
     */
    size?: string;
    quality?: string;
    style?: string;
    refImages: ReferenceImage[];
    signal?: AbortSignal;
}

/**
 * Generate an image using OpenAI-compatible API.
 *
 * Works with OpenAI (DALL-E / gpt-image-1), and other compatible providers.
 * If reference images are provided, the `images/edits` endpoint is used
 * (image-to-image via multipart/form-data); otherwise `images/generations`
 * (text-to-image via JSON).
 */
export async function generateImageWithOpenAI(
    plugin: NoteAssistantPlugin,
    config: Pick<ImageGenConfig, "apiKey" | "model" | "baseUrl">,
    params: OpenAIImageGenParams,
): Promise<ImageGenResult> {
    const { prompt, size, quality, style, refImages, signal } = params;

    const apiKey = resolveSecret(plugin.app, config.apiKey);
    if (!apiKey) {
        return {
            success: false,
            error: "OpenAI API key is not configured.",
        };
    }
    const model = config.model || "dall-e-3";
    const baseURL = config.baseUrl || DEFAULT_BASE_URL;

    try {
        let imageData: string | undefined;
        let mimeType: string;
        let responseJson: Record<string, unknown>;

        if (refImages.length > 0) {
            // ── Image-to-image: /v1/images/edits (multipart/form-data) ──
            const firstImg = refImages[0]!;
            const formData = new FormData();
            formData.append(
                "image",
                new Blob([firstImg.arrayBuffer], { type: firstImg.mimeType }),
                firstImg.fileName,
            );
            formData.append("prompt", prompt);
            formData.append("model", model);
            formData.append("n", "1");
            formData.append("response_format", "b64_json");
            if (size) formData.append("size", size);

            const response = await corsFreeFetchWithRetry(`${baseURL}/images/edits`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                },
                body: formData,
                signal,
            }, { onRetry: retryLogger("edits") });

            if (signal?.aborted) {
                return { success: false, error: "Aborted" };
            }

            if (!response.ok) {
                const errorBody = await response.text().catch(() => "");
                return {
                    success: false,
                    error: `OpenAI image edit error ${response.status}: ${errorBody || response.statusText}`,
                };
            }

            responseJson = (await response.json()) as Record<string, unknown>;
        } else {
            // ── Text-to-image: /v1/images/generations (JSON) ──
            const body: Record<string, unknown> = {
                model,
                prompt,
                n: 1,
                response_format: "b64_json",
            };
            if (size) body.size = size;
            if (quality) body.quality = quality;
            if (style) body.style = style;

            const response = await corsFreeFetchWithRetry(`${baseURL}/images/generations`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
                signal,
            }, { onRetry: retryLogger("generations") });

            if (signal?.aborted) {
                return { success: false, error: "Aborted" };
            }

            if (!response.ok) {
                const errorBody = await response.text().catch(() => "");
                return {
                    success: false,
                    error: `OpenAI image generation error ${response.status}: ${errorBody || response.statusText}`,
                };
            }

            responseJson = (await response.json()) as Record<string, unknown>;
        }

        const dataArray = responseJson.data as
            | Array<{ b64_json?: string; url?: string }>
            | undefined;
        const data = dataArray?.[0];
        if (!data) {
            return {
                success: false,
                error: "No image data returned from the API.",
            };
        }

        // Handle b64_json response
        if (data.b64_json) {
            imageData = data.b64_json;
            mimeType = "image/png";
            return { success: true, imageData, mimeType };
        }

        // If URL is returned instead of b64_json, download it.
        if (data.url) {
            const result = await downloadAsBase64(data.url, {
                signal,
                fallbackMimeType: "image/png",
            });

            return {
                success: true,
                imageData: result.base64,
                mimeType: result.mimeType,
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
        console.error("[OpenAIImageGen] Error:", err);
        return { success: false, error: msg };
    }
}
