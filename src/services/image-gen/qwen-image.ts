import type NoteAssistantPlugin from "../../main";
import type { ImageGenConfig } from "../../settings";
import type { ImageGenResult, ReferenceImage } from "./types";
import { downloadAsBase64, requestUrlWithAbort } from "../../utils/abortable-request";

/**
 * Parameters for Qwen image generation.
 *
 * Note: callers pass a semantic `aspectRatio` (e.g. "1:1", "16:9"). The
 * generator translates that into the concrete pixel size expected by the
 * configured model, which is necessary because DashScope splits Qwen image
 * models into two incompatible families:
 *   - Fixed-size family (qwen-image / qwen-image-plus / qwen-image-max):
 *     only 5 specific pixel sizes are accepted.
 *   - Free-form family (qwen-image-2.x / qwen-image-edit): arbitrary W*H
 *     within a pixel budget.
 * Exposing a raw `size` to the LLM would invariably surface that split as
 * confusing API errors.
 */
export interface QwenImageGenParams {
    prompt: string;
    /** Aspect ratio string, e.g. "1:1", "16:9". Omit to use model default. */
    aspectRatio?: string;
    negativePrompt: string;
    refImages: ReferenceImage[];
    signal?: AbortSignal;
}

/**
 * Map of aspect ratio → pixel size for the fixed-size family.
 * Only 5 pixel sizes are actually accepted by the API; ratios that don't
 * have an exact match are folded to the closest available bucket.
 */
const FIXED_FAMILY_SIZE: Record<string, string> = {
    '1:1':  '1328*1328',
    '4:3':  '1472*1104',
    '3:2':  '1472*1104', // closest available landscape near-square
    '16:9': '1664*928',
    '21:9': '1664*928',  // closest available landscape
    '3:4':  '1104*1472',
    '2:3':  '1104*1472', // closest available portrait near-square
    '9:16': '928*1664',
};

/**
 * Map of aspect ratio → pixel size for the free-form family.
 *
 * Constraints we satisfy across all free-form variants:
 *   - qwen-image-2.x: total pixels ≤ 2048*2048 (~4.19 MP)
 *   - qwen-image-edit / qwen-image-edit-max / qwen-image-edit-plus:
 *     each axis must be in [512, 2048]
 * Every entry below keeps both width and height ≤ 2048 to be safe across
 * the whole family. Dimensions that aren't multiples of 16 (e.g. 1080) are
 * silently rounded by the API to the nearest /16; the rounding is harmless
 * and the docs themselves recommend such values (e.g. 1920*1080 for 16:9).
 */
const FREE_FAMILY_SIZE: Record<string, string> = {
    '1:1':  '1408*1408',
    '4:3':  '1664*1248',
    '3:2':  '1728*1152',
    '16:9': '1920*1080',
    '21:9': '2048*880',   // capped at 2048 to satisfy edit-max/plus per-axis limit
    '3:4':  '1248*1664',
    '2:3':  '1152*1728',
    '9:16': '1080*1920',
};

type QwenSizeFamily = 'fixed' | 'free' | 'unknown';

/**
 * Detect which size-handling family a Qwen image model belongs to.
 *   - fixed: only 5 specific pixel sizes accepted
 *           (qwen-image / qwen-image-plus / qwen-image-max)
 *   - free:  free-form W*H within a pixel budget
 *           (qwen-image-2.x, qwen-image-edit*)
 *   - unknown: anything we don't recognize — caller should omit `size` and
 *           let the API pick its own default. Safer than guessing wrong.
 */
function detectQwenSizeFamily(model: string): QwenSizeFamily {
    const m = model.toLowerCase();
    if (m === 'qwen-image' || m === 'qwen-image-plus' || m === 'qwen-image-max') {
        return 'fixed';
    }
    if (m.includes('qwen-image-2') || m.includes('qwen-image-edit')) {
        return 'free';
    }
    return 'unknown';
}

/**
 * Resolve a semantic aspect ratio into a DashScope pixel-size string
 * appropriate for the given model. Returns undefined when either the
 * aspect ratio is not specified, the model family is unknown, or the
 * ratio has no entry in the family's table — in all cases the caller
 * should omit `size` and let the API fall back to its own default.
 */
function resolveQwenSize(model: string, aspectRatio: string | undefined): string | undefined {
    if (!aspectRatio) return undefined;
    const family = detectQwenSizeFamily(model);
    if (family === 'unknown') return undefined;
    const table = family === 'free' ? FREE_FAMILY_SIZE : FIXED_FAMILY_SIZE;
    return table[aspectRatio];
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
    const { prompt, aspectRatio, negativePrompt, refImages, signal } = params;

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

    const parameters: Record<string, unknown> = {
        negative_prompt: negativePrompt,
        prompt_extend: true,
        watermark: false,
    };
    // Only attach `size` when we successfully mapped aspectRatio → pixels for
    // this model family. Otherwise let DashScope fall back to its per-model
    // default (1664*928 for fixed-size, 2048*2048 for free-form 2.x).
    const resolvedSize = resolveQwenSize(model, aspectRatio);
    if (resolvedSize) {
        parameters.size = resolvedSize;
    }

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
        parameters,
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
