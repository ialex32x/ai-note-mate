/**
 * COS file upload for Tencent Cloud ASR.
 *
 * Large audio files (> 5 MB) must be uploaded to COS before submission.
 * Uses COS 方式二 (pre-signed URL) for both upload and download — the
 * signature is embedded in URL query parameters, avoiding the complexity
 * of Authorization headers.
 *
 * Flow:
 *   1. Generate pre-signed PUT URL → upload file with a plain PUT request.
 *   2. Generate pre-signed GET URL → ASR service downloads via this URL.
 */

import { fetchWithRetry } from "../../../utils/retry-helper";
import { buildCosPresignedUrl } from "../../../utils/cos-signature";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CosUploadParams {
    /** Tencent Cloud SecretId. */
    secretId: string;
    /** Tencent Cloud SecretKey. */
    secretKey: string;
    /** COS bucket name (format: "name-appid"). */
    bucket: string;
    /** COS region (e.g. "ap-guangzhou"). */
    region: string;
    /** Object key (path within the bucket). */
    key: string;
    /** Raw binary audio data. */
    fileData: ArrayBuffer;
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
    /** Pre-signed URL validity duration in seconds (default: 7200 = 2 hours). */
    presignExpireSeconds?: number;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Upload a file to COS using a pre-signed PUT URL (方式二) and return a
 * pre-signed GET URL for the ASR service.
 */
export async function uploadToCosAndGetUrl(params: CosUploadParams): Promise<string> {
    const {
        secretId, secretKey, bucket, region, key,
        fileData, signal, presignExpireSeconds = 7200,
    } = params;

    const rawKey = key.startsWith("/") ? key : `/${key}`;

    // ── Step 1: Generate pre-signed PUT URL ──
    const putUrl = await buildCosPresignedUrl(bucket, region, {
        secretId,
        secretKey,
        method: "PUT",
        key: rawKey,
        expireSeconds: presignExpireSeconds,
    });

    // ── Step 2: Upload with plain PUT (no Authorization header) ──
    const response = await fetchWithRetry(
        putUrl,
        {
            method: "PUT",
            body: new Blob([fileData]),
            signal,
        },
        { onRetry: retryLog("cosUpload") },
    );

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `COS upload failed (HTTP ${response.status}): ${body.slice(0, 500)}`,
        );
    }

    // ── Step 3: Generate pre-signed GET URL for ASR service ──
    const getUrl = await buildCosPresignedUrl(bucket, region, {
        secretId,
        secretKey,
        method: "GET",
        key: rawKey,
        expireSeconds: presignExpireSeconds,
    });

    return getUrl;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function retryLog(ctx: string) {
    return (err: unknown, n: number) =>
        console.warn(`[TencentASR:COS] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);
}
