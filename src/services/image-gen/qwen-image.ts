import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import type { ImageGenResult, ReferenceImage } from "./types";
import { downloadAsBase64, requestUrlWithAbort } from "../../utils/abortable-request";

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
 * Shape of relevant fields in the DashScope multimodal-generation response.
 * Only the fields we read are typed; everything else is allowed but ignored.
 */
interface QwenErrorBody {
    code?: string;
    message?: string;
}

interface QwenImagePart {
    image?: string;
    text?: string;
}

interface QwenChoice {
    message?: {
        content?: QwenImagePart[];
    };
}

interface QwenSuccessBody {
    code?: string;
    message?: string;
    output?: {
        choices?: QwenChoice[];
    };
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

    const storedKey = plugin.app.secretStorage.getSecret(config.apiKey);
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
        // NOTE: requestUrl has no native cancellation; requestUrlWithAbort only
        // discards the result if the signal fires mid-flight (throws AbortError).
        const response = await requestUrlWithAbort(
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
        );

        // Handle HTTP error responses with detailed error extraction
        if (response.status >= 400) {
            const errorBody = response.json as QwenErrorBody | undefined;
            const detail = errorBody?.message
                ? `${errorBody.code ? `[${errorBody.code}] ` : ""}${errorBody.message}`
                : response.text || `Request failed with status ${response.status}`;
            console.error("[QwenImageGen] response error: ", url, model, response.status, errorBody);
            return { success: false, error: detail };
        }

        const result = response.json as QwenSuccessBody | undefined;

        // Check for application-level error in response body
        if (result?.code && result.message) {
            return {
                success: false,
                error: `[${result.code}] ${result.message}`,
            };
        }

        // Parse successful response
        const choices = result?.output?.choices;
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

        // Download the generated image and inline it as base64.
        const imageUrl: string = imageData.image;
        const { base64, mimeType } = await downloadAsBase64(imageUrl, {
            signal,
            fallbackMimeType: "image/png",
        });

        return {
            success: true,
            imageData: base64,
            mimeType,
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
