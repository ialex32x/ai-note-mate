import { arrayBufferToBase64 } from "obsidian";
import OpenAI, { toFile } from "openai";
import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import type { ImageGenResult, ReferenceImage } from "./types";

/**
 * Parameters for OpenAI-compatible image generation.
 */
export interface OpenAIImageGenParams {
    prompt: string;
    size: string;
    quality?: string;
    style?: string;
    refImages: ReferenceImage[];
    signal?: AbortSignal;
}

/**
 * Generate an image using OpenAI-compatible API.
 * Works with OpenAI (DALL-E / gpt-image-1), and other compatible providers.
 * If reference images are provided, the `images.edit` endpoint is used
 * (image-to-image); otherwise `images.generate` (text-to-image).
 */
export async function generateImageWithOpenAI(
    plugin: NoteAssistantPlugin,
    config: Pick<ImageGenConfig, 'apiKey' | 'model' | 'baseUrl'>,
    params: OpenAIImageGenParams,
): Promise<ImageGenResult> {
    const { prompt, size, quality, style, refImages, signal } = params;

    if (!config.apiKey) {
        return {
            success: false,
            error: "OpenAI API key is not configured.",
        };
    }

    const storedKey = await plugin.app.secretStorage.getSecret(config.apiKey);
    const apiKey = storedKey ?? config.apiKey;
    const model = config.model || "dall-e-3";
    const baseURL = config.baseUrl || "https://api.openai.com/v1";

    const client = new OpenAI({
        apiKey,
        baseURL,
        dangerouslyAllowBrowser: true,
    });

    try {
        let response: OpenAI.Images.ImagesResponse;

        if (refImages.length > 0) {
            // Image-to-image: use the edit endpoint. Works with gpt-image-1
            // (multi-image supported); dall-e-2 supports single image only;
            // dall-e-3 does not support edit. Per decision 1 (hard switch),
            // we do not branch by model - errors are surfaced from the API.
            const uploadables = await Promise.all(
                refImages.map((img) =>
                    toFile(img.arrayBuffer, img.fileName, { type: img.mimeType }),
                ),
            );
            const editParams: OpenAI.Images.ImageEditParams = {
                model,
                prompt,
                // Pass single file directly when possible; SDK accepts both forms.
                image: uploadables.length === 1 ? uploadables[0]! : uploadables,
                n: 1,
                size: size as "256x256" | "512x512" | "1024x1024" | "1536x1024" | "1024x1536" | "auto",
            };
            // images.edit return type is a union with Stream<> when stream:true.
            // We never opt into streaming, so coerce to the non-stream branch.
            response = (await client.images.edit(editParams, { signal })) as OpenAI.Images.ImagesResponse;
        } else {
            // Pure text-to-image path.
            const requestParams: OpenAI.Images.ImageGenerateParams = {
                model,
                prompt,
                n: 1,
                size: size as "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792",
            };
            if (quality) {
                requestParams.quality = quality as "standard" | "hd";
            }
            if (style) {
                requestParams.style = style as "vivid" | "natural";
            }
            response = await client.images.generate(requestParams, { signal });
        }

        // Check abort after the API call
        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        const data = response.data?.[0];
        if (!data) {
            return {
                success: false,
                error: "No image data returned from the API.",
            };
        }

        // Handle b64_json response
        if (data.b64_json) {
            // OpenAI DALL-E returns PNG format by default
            return {
                success: true,
                imageData: data.b64_json,
                mimeType: "image/png",
            };
        }

        // If URL is returned instead of b64_json, we need to fetch it
        if (data.url) {
            const imageResponse = await fetch(data.url, { signal });
            if (!imageResponse.ok) {
                return {
                    success: false,
                    error: `Failed to fetch image from URL: ${imageResponse.status}`,
                };
            }

            const arrayBuffer = await imageResponse.arrayBuffer();
            const base64 = arrayBufferToBase64(arrayBuffer);

            const contentType = imageResponse.headers.get("content-type") || "image/png";

            return {
                success: true,
                imageData: base64,
                mimeType: contentType,
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

        // Handle OpenAI API errors
        if (err instanceof OpenAI.APIError) {
            const msg = err.message || `API Error: ${err.status}`;
            console.error("[OpenAIImageGen] API Error:", err);
            return { success: false, error: msg };
        }

        const msg = err instanceof Error ? err.message : String(err);
        console.error("[OpenAIImageGen] Error:", err);
        return { success: false, error: msg };
    }
}
