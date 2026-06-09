/**
 * Orchestrator for large-file async speech-to-text via DashScope.
 *
 * Combines OSS upload, task submission, polling, and artifact storage
 * into a single call that the `transcribe_audio` tool exec can invoke.
 *
 * Flow:
 *  1. Upload audio to DashScope OSS — get oss:// URL.
 *  2. Submit async transcription task — get task_id.
 *  3. Write a "running" artifact so the LLM can surface a placeholder.
 *  4. Poll for up to 2 minutes:
 *     - SUCCEEDED → download result → update artifact → return.
 *     - FAILED    → update artifact with error → return.
 *     - Still RUNNING after timeout → leave artifact as-is → return with
 *       instructions to check back later via `recall_artifact`.
 */

import { ArtifactStore } from "../../artifact-store";
import { getUploadPolicy, uploadFileToOss } from "./oss-upload";
import {
    submitAsyncTranscription,
    pollTaskStatus,
    fetchTranscriptionResult,
    type AsyncTaskStatus,
} from "./async-transcription";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface LargeFileASRParams {
    /** Resolved plaintext API key. */
    apiKey: string;
    /** DashScope root URL (origin only, e.g. "https://dashscope.aliyuncs.com"). */
    dashscopeRootUrl: string;
    /** ASR model name (must support async file transcription). */
    model: string;
    /** Audio file name (used for OSS upload key). */
    fileName: string;
    /** Raw binary audio data. */
    fileData: ArrayBuffer;
    /** Optional language hint. */
    language?: string;
    /** AbortSignal from the tool exec. */
    signal?: AbortSignal;
    /** Per-session artifact store for saving intermediate / final results. */
    artifactStore: ArtifactStore;
    /** Vault-relative path of the audio file (for error messages). */
    vaultPath: string;
}

export interface LargeFileASRResult {
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

const MAX_POLL_DURATION_MS = 120_000; // 2 minutes
const POLL_INTERVAL_MS = 8_000;       // 8 seconds between polls
const TERMINAL_STATUSES: Set<AsyncTaskStatus> = new Set(["SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"]);

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Transcribe a large audio file using DashScope's async file
 * transcription API, with artifact-backed progress tracking.
 */
export async function transcribeLargeFileWithAsyncASR(
    params: LargeFileASRParams,
): Promise<LargeFileASRResult> {
    const {
        apiKey, dashscopeRootUrl, model, fileName, fileData,
        language, signal, artifactStore, vaultPath,
    } = params;

    // ── Step 1: Upload to OSS ──
    let ossUrl: string;
    try {
        const policy = await getUploadPolicy(apiKey, model, dashscopeRootUrl, signal);
        ossUrl = await uploadFileToOss(policy, fileName, fileData, signal);
    } catch (err) {
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[AsyncSTT] OSS upload failed:", msg);
        return {
            success: false,
            error: `Failed to upload audio for transcription: ${msg}`,
        };
    }

    // ── Step 2: Submit async task ──
    let taskId: string;
    try {
        taskId = await submitAsyncTranscription(apiKey, model, ossUrl, dashscopeRootUrl, language, signal);
    } catch (err) {
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[AsyncSTT] Task submission failed:", msg);
        return {
            success: false,
            error: `Failed to submit transcription task: ${msg}`,
        };
    }

    // ── Step 3: Write initial "running" artifact ──
    // This artifact starts as RUNNING and is replaced in-place when the
    // task reaches a terminal state. Whether the task succeeds, fails, or
    // times out, the same artifact ID always points to the latest known
    // state — so callers can use `recall_artifact` with one stable ID.
    const runningArtifact = artifactStore.put(
        {
            type: "speech-to-text",
            status: "RUNNING",
            taskId,
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

            const info = await pollTaskStatus(apiKey, taskId, dashscopeRootUrl, signal);

            if (TERMINAL_STATUSES.has(info.status)) {
                if (info.status === "SUCCEEDED" && info.transcriptionUrl) {
                    // Download result
                    const result = await fetchTranscriptionResult(info.transcriptionUrl, signal);

                    // Replace the RUNNING artifact with the final result in-place,
                    // so the same artifact ID now holds the transcribed text.
                    if (artifactId && result.success && result.text) {
                        artifactStore.replace(
                            artifactId,
                            {
                                type: "speech-to-text",
                                status: "SUCCEEDED",
                                taskId,
                                vaultPath,
                                text: result.text,
                            },
                            estimateArtifactSize("SUCCEEDED", result.text),
                        );
                    } else if (artifactId && !result.success) {
                        artifactStore.replace(
                            artifactId,
                            {
                                type: "speech-to-text",
                                status: "FAILED",
                                taskId,
                                vaultPath,
                                error: result.error ?? "Result download failed",
                            },
                            estimateArtifactSize("FAILED"),
                        );
                    }

                    if (!result.success) {
                        return {
                            success: false,
                            error: `Transcription completed but result download failed: ${result.error ?? "unknown error"}`,
                        };
                    }

                    // Always return an artifact note so the LLM reads the result
                    // from the artifact instead of receiving it inline.
                    if (artifactId) {
                        return {
                            success: true,
                            text: `Transcription completed for ${vaultPath}. ` +
                                  `Read the result from artifact id '${artifactId}'.`,
                        };
                    }

                    return {
                        success: true,
                        text: result.text ?? "",
                    };
                }

                // FAILED, CANCELED, or UNKNOWN — replace the RUNNING
                // artifact with the terminal error state in-place.
                const errorDetail = info.errorCode
                    ? `[${info.errorCode}] ${info.errorMessage ?? ""}`
                    : `Task ended with status: ${info.status}`;

                if (artifactId) {
                    artifactStore.replace(
                        artifactId,
                        {
                            type: "speech-to-text",
                            status: info.status,
                            taskId,
                            vaultPath,
                            error: errorDetail,
                        },
                        estimateArtifactSize(info.status),
                    );
                }

                return {
                    success: false,
                    error: `Transcription task failed: ${errorDetail}`,
                };
            }

            // Still RUNNING/PENDING — wait before next poll
            await delay(Math.min(POLL_INTERVAL_MS, MAX_POLL_DURATION_MS - (Date.now() - startTime)));
        }
    } catch (err) {
        if (signal?.aborted) throw err;

        const msg = err instanceof Error ? err.message : String(err);
        console.error("[AsyncSTT] Polling error:", msg);
        return {
            success: false,
            error: `Transcription polling failed: ${msg}`,
        };
    }

    // ── Timeout: task is still running, artifact stays as RUNNING ──
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

/**
 * Estimate the JSON-serialised byte size of an artifact entry.
 * Not exact (we don't re-serialise), but good enough for
 * {@link ArtifactStore.put} budget checks.
 */
function estimateArtifactSize(status: string, text?: string): number {
    let base = 200; // ~200 bytes for the envelope JSON keys + taskId + vaultPath
    if (status === "RUNNING") base += 150;  // ~ message field
    if (status === "ERROR") base += 500;    // ~ error details
    if (text) base += text.length;
    return base;
}
