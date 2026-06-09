/**
 * OSS file upload for DashScope async speech-to-text.
 *
 * Implements the two-step upload flow described in the DashScope
 * file-transcription documentation:
 *   1. `getUploadPolicy()` — fetch a signed upload policy from DashScope.
 *   2. `uploadFileToOss()`  — POST the file as multipart/form-data to the
 *      OSS host prescribed by the policy.
 *
 * Per the DashScope docs the uploaded file is available for 48 hours.
 * The returned URL is in `oss://` form and MUST be accompanied by the
 * `X-DashScope-OssResourceResolve: enable` header when passed to any
 * downstream DashScope API.
 */

import { fetchWithRetry, requestUrlWithRetry } from "../../../utils/retry-helper";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

/** Upload policy fields returned by DashScope `getPolicy`. */
export interface UploadPolicy {
    upload_dir: string;
    upload_host: string;
    oss_access_key_id: string;
    signature: string;
    policy: string;
    x_oss_object_acl: string;
    x_oss_forbid_overwrite: string;
}

interface GetPolicyResponse {
    data: UploadPolicy;
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Fetch an OSS upload policy from DashScope.
 *
 * The policy is scoped to `model` — the same model that will later
 * consume the uploaded file (e.g. `funasr-mlt-v1`).
 *
 * **Rate-limit warning**: DashScope rate-limits this endpoint.
 * Callers should be prepared for transient 429 responses.
 */
export async function getUploadPolicy(
    apiKey: string,
    model: string,
    dashscopeRootUrl: string,
    signal?: AbortSignal,
): Promise<UploadPolicy> {
    const url = `${dashscopeRootUrl}/api/v1/uploads`;
    const query = new URLSearchParams({ action: "getPolicy", model });

    const response = await requestUrlWithRetry(
        {
            url: `${url}?${query.toString()}`,
            method: "GET",
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            throw: false,
        },
        signal,
        { onRetry: retryLog("getUploadPolicy") },
    );

    if (response.status < 200 || response.status >= 300) {
        const body = typeof response.text === "string" ? response.text.slice(0, 500) : "";
        throw new Error(
            `Failed to get upload policy (HTTP ${response.status}): ${body}`,
        );
    }

    const json = response.json as GetPolicyResponse;
    if (!json.data) {
        throw new Error("Upload policy response missing `data` field.");
    }
    return json.data;
}

/**
 * Upload a file to OSS using the given policy.
 *
 * @returns The `oss://` URL of the uploaded file.
 */
export async function uploadFileToOss(
    policy: UploadPolicy,
    fileName: string,
    fileData: ArrayBuffer,
    signal?: AbortSignal,
): Promise<string> {
    const key = `${policy.upload_dir}/${fileName}`;

    const formData = new FormData();
    formData.append("OSSAccessKeyId", policy.oss_access_key_id);
    formData.append("Signature", policy.signature);
    formData.append("policy", policy.policy);
    formData.append("x-oss-object-acl", policy.x_oss_object_acl);
    formData.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
    formData.append("key", key);
    formData.append("success_action_status", "200");
    formData.append("file", new Blob([fileData]), fileName);

    // IMPORTANT: do NOT set Content-Type manually — the browser MUST
    // set it to multipart/form-data with the correct boundary so OSS
    // can parse the multipart fields correctly.

    const response = await fetchWithRetry(
        policy.upload_host,
        {
            method: "POST",
            body: formData,
            signal,
        },
        { onRetry: retryLog("uploadFileToOss") },
    );

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `Failed to upload file to OSS (HTTP ${response.status}): ${body.slice(0, 500)}`,
        );
    }

    return `oss://${key}`;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function retryLog(ctx: string) {
    return (err: unknown, n: number) =>
        console.warn(`[AsyncSTT:oss] ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);
}
