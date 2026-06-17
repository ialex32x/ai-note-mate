/**
 * Tencent Cloud ASR API client.
 *
 * Implements:
 *   - CreateRecTask  — submit an audio file for recognition.
 *   - DescribeTaskStatus — poll the recognition result.
 *
 * Reference: https://cloud.tencent.com/document/api/1093/37823
 */

import { requestUrlWithRetry } from "../../../utils/retry-helper";
import { buildTc3Headers } from "../../../utils/tc3-signature";
import type { SpeechToTextResult } from "../types";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface TencentASRParams {
    /** Tencent Cloud SecretId. */
    secretId: string;
    /** Tencent Cloud SecretKey. */
    secretKey: string;
    /** Engine model type (e.g. "16k_zh"). */
    engineModelType: string;
    /** ASR service region (e.g. "ap-guangzhou"). */
    region?: string;
    /** Result text format (0-5, default: 3 = subtitle/segmented by punctuation). */
    resTextFormat?: number;
    /** Speaker diarization mode (0: off, 1: on, 3: role). */
    speakerDiarization?: number;
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
}

export interface CreateRecTaskRequest extends TencentASRParams {
    /**
     * Audio source type:
     *   0 = URL download,
     *   1 = base64 data in POST body.
     */
    sourceType: 0 | 1;
    /** Audio URL (required when sourceType=0). */
    url?: string;
    /** Base64-encoded audio data (required when sourceType=1, ≤5 MB). */
    data?: string;
    /** Original data length before base64 encoding (required when sourceType=1). */
    dataLen?: number;
    /** Number of audio channels (1 or 2). */
    channelNum?: number;
}

export interface DescribeTaskStatusRequest {
    secretId: string;
    secretKey: string;
    region?: string;
    taskId: number;
    signal?: AbortSignal;
}

/** Raw task status from the API. */
export interface TaskStatusResult {
    taskId: number;
    status: TaskStatusCode;
    statusStr: string;
    /** Recognized text (present when status is "success"). */
    result?: string;
    /** Error message (present when status is "failed"). */
    errorMsg?: string;
    /** Audio duration in seconds. */
    audioDuration?: number;
}

/**
 * Task status codes:
 *   0 = waiting
 *   1 = doing
 *   2 = success
 *   3 = failed
 */
export type TaskStatusCode = 0 | 1 | 2 | 3;

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const ASR_HOST = "asr.tencentcloudapi.com";
const API_VERSION = "2019-06-14";

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Submit an audio recognition task.
 *
 * @returns The integer TaskId for polling.
 */
export async function createRecTask(params: CreateRecTaskRequest): Promise<number> {
    const {
        secretId, secretKey, engineModelType, region = "",
        resTextFormat = 3, sourceType, url, data, dataLen,
        channelNum = 1, speakerDiarization = 0, signal,
    } = params;

    const body: Record<string, unknown> = {
        EngineModelType: engineModelType,
        ChannelNum: channelNum,
        ResTextFormat: resTextFormat,
        SourceType: sourceType,
    };

    if (sourceType === 0) {
        if (!url) throw new Error("URL is required when SourceType is 0.");
        body.Url = url;
    } else {
        if (!data) throw new Error("Data is required when SourceType is 1.");
        body.Data = data;
        if (dataLen !== undefined) body.DataLen = dataLen;
    }

    if (speakerDiarization) {
        body.SpeakerDiarization = speakerDiarization;
    }

    const payload = JSON.stringify(body);

    const tc3Headers = await buildTc3Headers({
        secretId,
        secretKey,
        service: "asr",
        action: "CreateRecTask",
        version: API_VERSION,
        region,
        payload,
    });

    const response = await requestUrlWithRetry(
        {
            url: `https://${ASR_HOST}`,
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                ...tc3Headers,
            },
            body: payload,
            throw: false,
        },
        signal,
        { onRetry: retryLog("createRecTask") },
    );

    if (response.status < 200 || response.status >= 300) {
        const errBody = typeof response.text === "string" ? response.text.slice(0, 500) : "";
        throw new Error(
            `CreateRecTask failed (HTTP ${response.status}): ${errBody}`,
        );
    }

    const json = response.json as { Response?: { Data?: { TaskId?: number }; Error?: { Message?: string; Code?: string } } };
    if (json.Response?.Error) {
        const err = json.Response.Error;
        throw new Error(`CreateRecTask error [${err.Code}]: ${err.Message}`);
    }

    const taskId = json.Response?.Data?.TaskId;
    if (taskId === undefined || taskId === null) {
        throw new Error(`CreateRecTask response missing TaskId: ${JSON.stringify(json)}`);
    }

    return taskId;
}

/**
 * Poll the status of a recognition task.
 *
 * Returns the current task status with text results when available.
 */
export async function describeTaskStatus(
    params: DescribeTaskStatusRequest,
): Promise<TaskStatusResult> {
    const { secretId, secretKey, region = "", taskId, signal } = params;

    const body: Record<string, unknown> = {
        TaskId: taskId,
    };
    const payload = JSON.stringify(body);

    const tc3Headers = await buildTc3Headers({
        secretId,
        secretKey,
        service: "asr",
        action: "DescribeTaskStatus",
        version: API_VERSION,
        region,
        payload,
    });

    const response = await requestUrlWithRetry(
        {
            url: `https://${ASR_HOST}`,
            method: "POST",
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                ...tc3Headers,
            },
            body: payload,
            throw: false,
        },
        signal,
        { onRetry: retryLog("describeTaskStatus") },
    );

    if (response.status < 200 || response.status >= 300) {
        const errBody = typeof response.text === "string" ? response.text.slice(0, 500) : "";
        throw new Error(
            `DescribeTaskStatus failed (HTTP ${response.status}): ${errBody}`,
        );
    }

    const json = response.json as {
        Response?: {
            Data?: {
                TaskId?: number;
                Status?: number;
                StatusStr?: string;
                Result?: string;
                ErrorMsg?: string;
                AudioDuration?: number;
            };
            Error?: { Message?: string; Code?: string };
        };
    };

    if (json.Response?.Error) {
        const err = json.Response.Error;
        throw new Error(`DescribeTaskStatus error [${err.Code}]: ${err.Message}`);
    }

    const data = json.Response?.Data;
    if (!data) {
        throw new Error(`DescribeTaskStatus response missing Data: ${JSON.stringify(json)}`);
    }

    return {
        taskId: data.TaskId ?? taskId,
        status: (data.Status ?? 0) as TaskStatusCode,
        statusStr: data.StatusStr ?? "unknown",
        result: data.Result,
        errorMsg: data.ErrorMsg,
        audioDuration: data.AudioDuration,
    };
}

/**
 * Convert task status to simple SpeechToTextResult.
 */
export function toSttResult(status: TaskStatusResult): SpeechToTextResult {
    if (status.status === 2) {
        return { success: true, text: status.result ?? "" };
    }
    if (status.status === 3) {
        return {
            success: false,
            error: status.errorMsg || `Task failed with status: ${status.statusStr}`,
        };
    }
    // Still running
    return {
        success: false,
        error: `Task is still ${status.statusStr} (status=${status.status})`,
    };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function retryLog(ctx: string) {
    return (err: unknown, n: number) =>
        console.warn(`[TencentASR] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);
}
