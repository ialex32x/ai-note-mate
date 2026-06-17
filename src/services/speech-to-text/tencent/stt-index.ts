/**
 * Orchestrator for Tencent Cloud ASR speech-to-text.
 *
 * Combines audio file reading, task submission, polling, and artifact
 * storage into a single call that the `transcribe_audio` tool exec can invoke.
 *
 * Flow:
 *  1. If file ≤ 5 MB: base64-encode → CreateRecTask with SourceType=1.
 *  2. If file > 5 MB: upload to COS → CreateRecTask with SourceType=0.
 *  3. Write a "running" artifact so the LLM can surface a placeholder.
 *  4. Poll DescribeTaskStatus for up to 2 minutes:
 *     - Status=2 (success) → update artifact with text → return.
 *     - Status=3 (failed)   → update artifact with error → return.
 *     - Still running after timeout → leave artifact as-is → return.
 */

import { ArtifactStore } from "../../artifact-store";
import { createRecTask, describeTaskStatus } from "./asr-client";
import type { TaskStatusResult } from "./asr-client";
import { uploadToCosAndGetUrl } from "./cos-upload";
import { isValidCosBucketName } from "../../../settings/helpers";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface TencentASRFullParams {
    /** Tencent Cloud SecretId. */
    secretId: string;
    /** Tencent Cloud SecretKey. */
    secretKey: string;
    /** Engine model type (e.g. "16k_zh"). */
    engineModelType: string;
    /** ASR service region (e.g. "ap-guangzhou"). */
    region?: string;
    /** Audio file name. */
    fileName: string;
    /** Raw binary audio data. */
    fileData: ArrayBuffer;
    /** COS bucket (required for files > 5 MB). */
    cosBucket?: string;
    /** COS region (required when cosBucket is provided). */
    cosRegion?: string;
    /** Optional language hint (not directly used by Tencent ASR, reserved for future). */
    language?: string;
    /** AbortSignal from the tool exec. */
    signal?: AbortSignal;
    /** Per-session artifact store for saving intermediate / final results. */
    artifactStore: ArtifactStore;
    /** Vault-relative path of the audio file (for error / artifact messages). */
    vaultPath: string;
}

export interface TencentASRFullResult {
    /** Overall success. */
    success: boolean;
    /** Transcribed text (only when task completed within timeout). */
    text?: string;
    /** Error message if something went wrong. */
    error?: string;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/** Max file size for base64 inline submission (5 MB). */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

const MAX_POLL_DURATION_MS = 120_000; // 2 minutes
const POLL_INTERVAL_MS = 8_000;       // 8 seconds between polls

/** Terminal task status codes. */
const TERMINAL_STATUSES: Set<number> = new Set([2, 3]);

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Transcribe an audio file using Tencent Cloud ASR.
 *
 * Handles both small files (base64 inline) and large files (COS upload),
 * with artifact-backed progress tracking.
 */
export async function transcribeWithTencentASR(
    params: TencentASRFullParams,
): Promise<TencentASRFullResult> {
    const {
        secretId, secretKey, engineModelType, region = "",
        fileName, fileData, cosBucket, cosRegion,
        signal, artifactStore, vaultPath,
    } = params;

    // ── Step 1: Determine submission method ──
    const fileSize = fileData.byteLength;
    const useCos = fileSize > MAX_INLINE_BYTES;

    if (useCos && (!cosBucket || !cosRegion)) {
        return {
            success: false,
            error: `Audio file is too large for inline transcription (${(fileSize / 1024 / 1024).toFixed(1)} MB). ` +
                `COS bucket and region must be configured in settings for files > 5 MB.`,
        };
    }

    if (useCos && cosBucket && !isValidCosBucketName(cosBucket)) {
        return {
            success: false,
            error: `COS bucket "${cosBucket}" has invalid format. Expected format: "name-appid" (e.g. mybucket-1250000000). ` +
                `Please correct it in Settings → Speech-to-Text.`,
        };
    }

    let taskId: number;
    let errorDetail: string | undefined;

    // ── Step 2a: Large file — upload to COS first ──
    if (useCos) {
        try {
            const cosKey = `asr-uploads/${Date.now()}-${fileName}`;
            const presignedUrl = await uploadToCosAndGetUrl({
                secretId,
                secretKey,
                bucket: cosBucket!,
                region: cosRegion!,
                key: cosKey,
                fileData,
                signal,
            });

            try {
                taskId = await createRecTask({
                    secretId,
                    secretKey,
                    engineModelType,
                    region,
                    sourceType: 0,
                    url: presignedUrl,
                    signal,
                });
            } catch (err) {
                // COS upload succeeded but task submission failed — wrap error
                if (signal?.aborted) throw err;
                errorDetail = err instanceof Error ? err.message : String(err);
                return {
                    success: false,
                    error: `Failed to submit transcription task after COS upload: ${errorDetail}`,
                };
            }
        } catch (err) {
            if (signal?.aborted) throw err;
            errorDetail = err instanceof Error ? err.message : String(err);
            console.error("[TencentASR] COS upload failed:", errorDetail);
            return {
                success: false,
                error: `Failed to upload audio to COS: ${errorDetail}`,
            };
        }
    } else {
        // ── Step 2b: Small file — base64 inline ──
        const base64 = arrayBufferToBase64(fileData);

        try {
            taskId = await createRecTask({
                secretId,
                secretKey,
                engineModelType,
                region,
                sourceType: 1,
                data: base64,
                dataLen: fileSize,
                signal,
            });
        } catch (err) {
            if (signal?.aborted) throw err;
            errorDetail = err instanceof Error ? err.message : String(err);
            console.error("[TencentASR] Task submission failed:", errorDetail);
            return {
                success: false,
                error: `Failed to submit transcription task: ${errorDetail}`,
            };
        }
    }

    // ── Step 3: Write initial "running" artifact ──
    const runningArtifact = artifactStore.put(
        {
            type: "speech-to-text",
            status: "RUNNING",
            taskId: taskId.toString(),
            vaultPath,
            message: `Speech-to-text task (task_id: ${taskId}) is still running. Please check back later using recall_artifact.`,
        },
        estimateArtifactSize("RUNNING"),
    );

    const artifactId = runningArtifact.stored ? runningArtifact.key : null;

    // ── Step 4: Poll with timeout ──
    const startTime = Date.now();

    try {
        while (Date.now() - startTime < MAX_POLL_DURATION_MS) {
            if (signal?.aborted) {
                return { success: false, error: "Aborted" };
            }

            const status: TaskStatusResult = await describeTaskStatus({
                secretId,
                secretKey,
                region,
                taskId,
                signal,
            });

            if (TERMINAL_STATUSES.has(status.status)) {
                if (status.status === 2 && status.result) {
                    // Success — update artifact with text
                    if (artifactId) {
                        artifactStore.replace(
                            artifactId,
                            {
                                type: "speech-to-text",
                                status: "SUCCEEDED",
                                taskId: taskId.toString(),
                                vaultPath,
                                text: status.result,
                            },
                            estimateArtifactSize("SUCCEEDED", status.result),
                        );
                    }

                    if (artifactId) {
                        return {
                            success: true,
                            text: `Transcription completed for ${vaultPath}. ` +
                                `Read the result from artifact id '${artifactId}'.`,
                        };
                    }

                    return { success: true, text: status.result };
                }

                // Failed
                const errMsg = status.errorMsg || `Task ended with status: ${status.statusStr}`;
                if (artifactId) {
                    artifactStore.replace(
                        artifactId,
                        {
                            type: "speech-to-text",
                            status: "FAILED",
                            taskId: taskId.toString(),
                            vaultPath,
                            error: errMsg,
                        },
                        estimateArtifactSize("FAILED"),
                    );
                }

                return { success: false, error: `Transcription task failed: ${errMsg}` };
            }

            // Still running — wait before next poll
            await delay(Math.min(POLL_INTERVAL_MS, MAX_POLL_DURATION_MS - (Date.now() - startTime)));
        }
    } catch (err) {
        if (signal?.aborted) throw err;

        const msg = err instanceof Error ? err.message : String(err);
        console.error("[TencentASR] Polling error:", msg);
        return {
            success: false,
            error: `Transcription polling failed: ${msg}`,
        };
    }

    // ── Timeout: task is still running ──
    return {
        success: false,
        error: artifactId
            ? `Speech-to-text not completed for ${vaultPath}. Task (${taskId}) is still running. ` +
              `Read it from artifacts id '${artifactId}' later.`
            : `Speech-to-text not completed for ${vaultPath}. Task (${taskId}) is still running. ` +
              `The result is not stored in an artifact (store unavailable).`,
    };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function delay(ms: number): Promise<void> {
    return new Promise(resolve => window.setTimeout(resolve, Math.max(0, ms)));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
    }
    return btoa(binary);
}

function estimateArtifactSize(status: string, text?: string): number {
    let base = 200;
    if (status === "RUNNING") base += 150;
    if (status === "FAILED") base += 500;
    if (text) base += text.length;
    return base;
}
