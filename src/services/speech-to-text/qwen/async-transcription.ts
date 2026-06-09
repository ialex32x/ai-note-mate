/**
 * Async (offline / file-mode) DashScope speech-to-text transcription.
 *
 * The standard `transcribeWithQwenASR` in `qwen-asr.ts` sends audio
 * inline via the compatible-mode chat-completions endpoint and is
 * limited to small files (~7.5 MB base64 overhead). This module
 * implements the alternative async path for large recordings:
 *
 *  1. Upload the audio file to DashScope OSS via `oss-upload.ts`.
 *  2. Submit an async transcription task (`/api/v1/services/audio/asr/transcription`).
 *  3. Poll `/api/v1/tasks/{task_id}` until the task completes or times out.
 *  4. Download the result JSON from the returned `transcription_url`.
 *
 * The caller is responsible for wiring artifact storage so long-running
 * tasks can survive plugin reload / session loss. See `index.ts` for the
 * orchestrator that combines upload + submission + polling + artifact update.
 */

import { requestUrlWithRetry } from "../../../utils/retry-helper";
import type { SpeechToTextResult } from "../types";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Task status returned by the DashScope `/api/v1/tasks/{task_id}` endpoint. */
export type AsyncTaskStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";

export interface AsyncTaskInfo {
    taskId: string;
    status: AsyncTaskStatus;
    /** Present when status is SUCCEEDED. */
    transcriptionUrl?: string;
    /** Present when status is FAILED. */
    errorCode?: string;
    errorMessage?: string;
    /** Present on RUNNING tasks. */
    submitTime?: string;
    /** Present on SUCCEEDED tasks. */
    usageSeconds?: number;
}

interface AsyncSubmitResponse {
    request_id: string;
    output: {
        task_id: string;
        task_status: string;
    };
}

interface AsyncPollResponse {
    request_id: string;
    output: {
        task_id: string;
        task_status: string;
        submit_time?: string;
        scheduled_time?: string;
        end_time?: string;
        code?: string;
        message?: string;
        result?: {
            transcription_url?: string;
        };
        task_metrics?: {
            TOTAL: number;
            SUCCEEDED: number;
            FAILED: number;
        };
    };
    usage?: {
        seconds: number;
    };
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Submit an async transcription task to DashScope.
 *
 * @returns The `task_id` that can be used to poll for results.
 */
export async function submitAsyncTranscription(
    apiKey: string,
    model: string,
    ossUrl: string,
    dashscopeRootUrl: string,
    language?: string,
    signal?: AbortSignal,
): Promise<string> {
    const url = `${dashscopeRootUrl}/api/v1/services/audio/asr/transcription`;

    const payload: Record<string, unknown> = {
        //TODO temporory hardcoding the model until we figure out how to config it properly
        model: "qwen3-asr-flash-filetrans",
        input: { file_url: ossUrl },
        // placeholders, not used in current version
        parameters: {
            "channel_id": [0],
            "enable_itn": false
        },
    };

    if (language) {
        (payload.parameters as Record<string, unknown>).language_hints = [language];
    }

    console.debug("transcription url:", url);
    const response = await requestUrlWithRetry(
        {
            url,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "X-DashScope-Async": "enable",
                "X-DashScope-OssResourceResolve": "enable",
            },
            body: JSON.stringify(payload),
            throw: false,
        },
        signal,
        { onRetry: retryLog("submitAsyncTranscription") },
    );

    if (response.status < 200 || response.status >= 300) {
        const errBody = typeof response.text === "string" ? response.text.slice(0, 500) : "";
        throw new Error(
            `Async transcription submission failed (HTTP ${response.status}): ${errBody}`,
        );
    }

    const json = response.json as AsyncSubmitResponse;
    const taskId = json.output?.task_id;
    if (!taskId) {
        throw new Error(
            `Async transcription response missing task_id: ${JSON.stringify(json)}`,
        );
    }

    return taskId;
}

/**
 * Poll the task status endpoint once.
 */
export async function pollTaskStatus(
    apiKey: string,
    taskId: string,
    dashscopeRootUrl: string,
    signal?: AbortSignal,
): Promise<AsyncTaskInfo> {
    const url = `${dashscopeRootUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`;

    const response = await requestUrlWithRetry(
        {
            url,
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "X-DashScope-Async": "enable",
            },
            throw: false,
        },
        signal,
        { onRetry: retryLog("pollTaskStatus") },
    );

    if (response.status < 200 || response.status >= 300) {
        const errBody = typeof response.text === "string" ? response.text.slice(0, 500) : "";
        throw new Error(
            `Task status poll failed (HTTP ${response.status}): ${errBody}`,
        );
    }

    const json = response.json as AsyncPollResponse;
    const output = json.output;

    return {
        taskId: output.task_id || taskId,
        status: mapStatus(output.task_status),
        transcriptionUrl: output.result?.transcription_url,
        errorCode: output.code,
        errorMessage: output.message,
        submitTime: output.submit_time,
        usageSeconds: json.usage?.seconds,
    };
}

/**
 * Download the actual transcription JSON from a pre-signed
 * `transcription_url` and extract the text content.
 *
 * The transcription URL is a public OSS pre-signed URL; no
 * Authorization header is needed.
 */
export async function fetchTranscriptionResult(
    transcriptionUrl: string,
    signal?: AbortSignal,
): Promise<SpeechToTextResult> {
    const response = await requestUrlWithRetry(
        {
            url: transcriptionUrl,
            method: "GET",
            throw: false,
        },
        signal,
        { onRetry: retryLog("fetchTranscriptionResult") },
    );

    if (response.status < 200 || response.status >= 300) {
        const errBody = typeof response.text === "string" ? response.text.slice(0, 500) : "";
        throw new Error(
            `Failed to fetch transcription result (HTTP ${response.status}): ${errBody}`,
        );
    }

    const json = response.json as unknown;
    const text = extractTranscriptionText(json);

    if (!text) {
        return {
            success: false,
            error: "Transcription result did not contain recognizable text content.",
        };
    }

    return { success: true, text };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function mapStatus(raw: string | undefined): AsyncTaskStatus {
    switch (raw) {
        case "PENDING": return "PENDING";
        case "RUNNING": return "RUNNING";
        case "SUCCEEDED": return "SUCCEEDED";
        case "FAILED": return "FAILED";
        case "CANCELED": return "CANCELED";
        default: return "UNKNOWN";
    }
}

/**
 * Extract transcription text from the DashScope ASR result JSON.
 *
 * The result format varies by model. Common shapes:
 *   - Paraformer (`funasr-mlt-v1`): `{ transcripts: [{ text: "..." }] }`
 *   - Generic: `{ text: "..." }` or `{ result: "..." }`
 */
function extractTranscriptionText(json: unknown): string {
    if (typeof json !== "object" || json === null) return "";

    const obj = json as Record<string, unknown>;

    // Paraformer format
    const transcripts = obj.transcripts;
    if (Array.isArray(transcripts)) {
        const parts: string[] = [];
        for (const t of transcripts) {
            if (typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).text === "string") {
                parts.push((t as Record<string, unknown>).text as string);
            }
        }
        return parts.join("\n");
    }

    // Simple text field
    if (typeof obj.text === "string") return obj.text;

    // result field
    if (typeof obj.result === "string") return obj.result;

    // Fallback: stringify the whole thing
    return JSON.stringify(json);
}

function retryLog(ctx: string) {
    return (err: unknown, n: number) =>
        console.warn(`[AsyncSTT] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);
}
