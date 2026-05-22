import { GoogleGenAI } from "@google/genai";
import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import { resolveSecret } from "../../utils/secret-helper";
import type { ImageGenResult, ReferenceImage } from "./types";

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
 */
export async function generateImageWithGemini(
    plugin: NoteAssistantPlugin,
    config: Pick<ImageGenConfig, 'apiKey' | 'model'>,
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

    const client = new GoogleGenAI({ apiKey });

    // Build contents: text prompt + optional reference images (already loaded & validated).
    const contents = buildContents(prompt, refImages);

    // Only attach imageConfig when the caller actually specified a dimension
    // hint; otherwise let the model fall back to its own defaults. Sending an
    // empty/undefined imageConfig is harmless but noisy.
    const imageConfig: { aspectRatio?: string; imageSize?: string } = {};
    if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
    if (imageSize) imageConfig.imageSize = imageSize;

    try {
        const response = await client.models.generateContent({
            model,
            contents,
            config: {
                responseModalities: ["IMAGE"],
                ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
            },
        });

        // Check abort after the long API call
        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        // Extract image parts from the response
        const parts = response.candidates?.[0]?.content?.parts;
        if (!parts || parts.length === 0) {
            return {
                success: false,
                error: "No content returned from the image generation model.",
            };
        }

        // Find the first image part and any text parts
        for (const part of parts as Array<Record<string, unknown>>) {
            if (part.inlineData && typeof part.inlineData === "object") {
                const inlineData = part.inlineData as { mimeType: string; data: string };
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
        for (const part of parts as Array<Record<string, unknown>>) {
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
): string | Array<{ role: "user"; parts: Array<Record<string, unknown>> }> {
    if (!refImages || refImages.length === 0) {
        return prompt;
    }

    const parts: Array<Record<string, unknown>> = [{ text: prompt }];
    for (const img of refImages) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
    }
    return [{ role: "user", parts }];
}
