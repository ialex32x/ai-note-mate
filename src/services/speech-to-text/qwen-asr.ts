import type NoteAssistantPlugin from "../../main";
import type { SpeechToTextConfig } from "../../settings";
import type { SpeechToTextResult } from "./types";
import { resolveSecret } from "../../utils/secret-helper";
import { fetchWithRetry } from "../../utils/retry-helper";

const retryLogger = (ctx: string) =>
    (err: unknown, n: number) => console.warn(`[QwenASR] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * Parameters for Qwen ASR speech-to-text transcription.
 */
export interface QwenASRParams {
    /** Audio data as a data URI (e.g. "data:audio/mp3;base64,...") */
    audioDataUri: string;
    /** Whether to stream the response (default: false) */
    stream?: boolean;
    /** Enable Inverse Text Normalization (default: false) */
    enableItn?: boolean;
    /** Language hint (e.g. "zh", "en"). Omit for auto-detection. */
    language?: string;
    signal?: AbortSignal;
}

interface QwenASRContentPart {
    type: "input_audio";
    input_audio: {
        data: string;
    };
}

interface QwenASRMessage {
    role: "user";
    content: QwenASRContentPart[];
}

interface QwenASRRequestBody {
    model: string;
    messages: QwenASRMessage[];
    stream: boolean;
    asr_options?: {
        enable_itn?: boolean;
        language?: string;
    };
}

interface QwenASRChoice {
    message?: {
        content?: string;
    };
    delta?: {
        content?: string;
    };
}

interface QwenASRSuccessResponse {
    choices?: QwenASRChoice[];
}

interface QwenASRErrorResponse {
    code?: string;
    message?: string;
}

/**
 * Transcribe audio using Qwen ASR via DashScope compatible-mode API.
 *
 * Uses the OpenAI-compatible chat completions endpoint with `input_audio`
 * content type to transcribe audio files.
 */
export async function transcribeWithQwenASR(
    plugin: NoteAssistantPlugin,
    config: Pick<SpeechToTextConfig, "apiKey" | "model" | "baseUrl">,
    params: QwenASRParams,
): Promise<SpeechToTextResult> {
    const { audioDataUri, stream = false, enableItn = false, language, signal } = params;

    const apiKey = resolveSecret(plugin.app, config.apiKey);
    if (!apiKey) {
        return {
            success: false,
            error: "Qwen ASR API key is not configured.",
        };
    }
    const model = config.model || "qwen3-asr-flash";
    const baseURL = config.baseUrl || DEFAULT_BASE_URL;

    const requestBody: QwenASRRequestBody = {
        model,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "input_audio",
                        input_audio: {
                            data: audioDataUri,
                        },
                    },
                ],
            },
        ],
        stream,
        asr_options: {
            enable_itn: enableItn,
        },
    };
    if (language) {
        requestBody.asr_options!.language = language;
    }

    try {
        const response = await fetchWithRetry(`${baseURL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(requestBody),
            signal,
        }, { onRetry: retryLogger("transcribe") });

        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        if (!response.ok) {
            let errorDetail = `Request failed with status ${response.status}`;
            try {
                const errorBody = await response.json() as QwenASRErrorResponse;
                if (errorBody.message) {
                    errorDetail = errorBody.code
                        ? `[${errorBody.code}] ${errorBody.message}`
                        : errorBody.message;
                }
            } catch {
                const text = await response.text().catch(() => "");
                if (text) errorDetail = text;
            }
            console.error("[QwenASR] response error:", baseURL, model, response.status, errorDetail);
            return { success: false, error: errorDetail };
        }

        // Handle streaming response
        if (stream) {
            const reader = response.body?.getReader();
            if (!reader) {
                return { success: false, error: "Streaming response body is not readable." };
            }

            const decoder = new TextDecoder();
            let fullContent = "";
            let buffer = "";

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (signal?.aborted) {
                        void reader.cancel();
                        return { success: false, error: "Aborted" };
                    }

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    // Keep the last potentially incomplete line in the buffer
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith("data:")) continue;
                        const dataStr = trimmed.slice(5).trim();
                        if (dataStr === "[DONE]") continue;
                        try {
                            const chunk = JSON.parse(dataStr) as QwenASRSuccessResponse;
                            const delta = chunk.choices?.[0]?.delta;
                            if (delta?.content) {
                                fullContent += delta.content;
                            }
                        } catch {
                            // Skip unparseable lines
                        }
                    }
                }
                // Process any remaining data in the buffer
                if (buffer.trim()) {
                    const trimmed = buffer.trim();
                    if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
                        try {
                            const chunk = JSON.parse(trimmed.slice(5).trim()) as QwenASRSuccessResponse;
                            const delta = chunk.choices?.[0]?.delta;
                            if (delta?.content) {
                                fullContent += delta.content;
                            }
                        } catch {
                            // Skip
                        }
                    }
                }
            } finally {
                // `reader.cancel()` (called in the abort branch above) already
                // releases the lock, so catch the double-release TypeError here.
                try { reader.releaseLock(); } catch { /* already released by cancel() */ }
            }

            if (!fullContent) {
                return { success: false, error: "No transcription content received." };
            }

            return { success: true, text: fullContent };
        }

        // Handle non-streaming response
        const result = await response.json() as QwenASRSuccessResponse;
        const content = result.choices?.[0]?.message?.content;
        if (!content) {
            return { success: false, error: "No transcription content in API response." };
        }

        return { success: true, text: content };
    } catch (err) {
        if (signal?.aborted) {
            return { success: false, error: "Aborted" };
        }

        const msg = err instanceof Error ? err.message : String(err);
        console.error("[QwenASR] error:", baseURL, model, err);
        return { success: false, error: msg };
    }
}
