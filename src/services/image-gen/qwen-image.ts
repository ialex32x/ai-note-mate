import { requestUrl, arrayBufferToBase64 } from "obsidian";
import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import type { ImageGenResult, ReferenceImage } from "./types";

/**
 * Parameters for Qwen image generation.
 */
export interface QwenImageGenParams {
    prompt: string;
    size: string;
    negativePrompt: string;
    refImages: ReferenceImage[];
    signal?: AbortSignal;
}

/**
 * Generate an image using Qwen API via DashScope.
 * If reference images are provided, they are attached to the multimodal
 * content array as data-URI image parts (image-to-image). Whether this
 * is accepted depends on the configured model: `qwen-image-edit` and
 * similar multimodal-capable models typically accept it; pure text-to-image
 * models (e.g. `qwen-image`) will surface an API error.
 */
export async function generateImageWithQwen(
    plugin: NoteAssistantPlugin,
    config: Pick<ImageGenConfig, 'apiKey' | 'model'>,
    params: QwenImageGenParams,
): Promise<ImageGenResult> {
    const { prompt, size, negativePrompt, refImages, signal } = params;

    if (!config.apiKey) {
        return {
            success: false,
            error: "Qwen API key is not configured.",
        };
    }

    const storedKey = await plugin.app.secretStorage.getSecret(config.apiKey);
    const apiKey = storedKey ?? config.apiKey;
    const model = config.model || "qwen-image";

    const url = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

    // Build multimodal content array: reference images first (DashScope
    // convention places image inputs before the text prompt), then the prompt.
    const content: Array<Record<string, unknown>> = [];
    for (const img of refImages) {
        content.push({ image: `data:${img.mimeType};base64,${img.base64}` });
    }
    content.push({ text: prompt });

    const requestBody = {
        model,
        input: {
            messages: [
                {
                    role: "user",
                    content,
                },
            ],
        },
        parameters: {
            negative_prompt: negativePrompt,
            prompt_extend: true,
            watermark: false,
            size,
        },
    };

    try {
        const response = await requestUrl({
            url,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
            throw: false,
        });

        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        // Handle HTTP error responses with detailed error extraction
        if (response.status >= 400) {
            const errorBody = response.json;
            const detail = errorBody?.message
                ? `${errorBody.code ? `[${errorBody.code}] ` : ""}${errorBody.message}`
                : response.text || `Request failed with status ${response.status}`;
            console.error("[QwenImageGen] response error: ", url, model, response.status, errorBody);
            return { success: false, error: detail };
        }

        const result = response.json;

        // Check for application-level error in response body
        if (result.code && result.message) {
            return {
                success: false,
                error: `[${result.code}] ${result.message}`,
            };
        }

        // Parse successful response
        const choices = result.output?.choices;
        if (!choices || !Array.isArray(choices) || choices.length === 0) {
            return {
                success: false,
                error: "No image data returned from the API.",
            };
        }

        const msgContent = choices[0]?.message?.content;
        if (!msgContent || !Array.isArray(msgContent) || msgContent.length === 0) {
            return {
                success: false,
                error: "No image content in API response.",
            };
        }

        const imageData = msgContent[0];
        if (!imageData?.image) {
            return {
                success: false,
                error: "No image URL in API response.",
            };
        }

        // Fetch the image from URL
        const imageUrl = imageData.image;
        const imageResponse = await requestUrl({
            url: imageUrl,
            method: "GET",
        });

        const arrayBuffer = imageResponse.arrayBuffer;
        const base64 = arrayBufferToBase64(arrayBuffer);
        const contentType = imageResponse.headers?.["content-type"] || "image/png";

        return {
            success: true,
            imageData: base64,
            mimeType: contentType,
        };
    } catch (err) {
        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        const msg = err instanceof Error ? err.message : String(err);
        console.error("[QwenImageGen] error:", url, model, err);
        return { success: false, error: msg };
    }
}
