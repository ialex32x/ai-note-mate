/**
 * Tencent Cloud API 3.0 TC3-HMAC-SHA256 signature implementation.
 *
 * Used by the ASR (speech-to-text) service to sign CreateRecTask and
 * DescribeTaskStatus requests. Works in browser environments via the
 * Web Crypto API (crypto.subtle).
 *
 * Reference: https://cloud.tencent.com/document/api/1093/37823
 */

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface Tc3Headers {
    /** Full Authorization header value. */
    Authorization: string;
    /** X-TC-Action header (e.g. "CreateRecTask"). */
    "X-TC-Action": string;
    /** X-TC-Version header (e.g. "2019-06-14"). */
    "X-TC-Version": string;
    /** X-TC-Timestamp header (UNIX timestamp in seconds). */
    "X-TC-Timestamp": string;
    /** X-TC-Region header (optional, omitted when empty). */
    "X-TC-Region"?: string;
}

export interface Tc3SignParams {
    /** Tencent Cloud SecretId. */
    secretId: string;
    /** Tencent Cloud SecretKey. */
    secretKey: string;
    /** Service name (e.g. "asr"). */
    service: string;
    /** API action (e.g. "CreateRecTask"). */
    action: string;
    /** API version (e.g. "2019-06-14"). */
    version: string;
    /** Region (optional, empty string for no region). */
    region: string;
    /** JSON-serialized request body. */
    payload: string;
    /** UNIX timestamp in seconds (defaults to current time). */
    timestamp?: number;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const ALGORITHM = "TC3-HMAC-SHA256";
const SIGNED_HEADERS = "content-type;host";
const CONTENT_TYPE = "application/json; charset=utf-8";

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Build TC3-HMAC-SHA256 signed headers for a Tencent Cloud API request.
 *
 * @returns Headers object ready to be used in a fetch/requestUrl call.
 */
export async function buildTc3Headers(params: Tc3SignParams): Promise<Record<string, string>> {
    const {
        secretId,
        secretKey,
        service,
        action,
        version,
        region,
        payload,
        timestamp: tsParam,
    } = params;

    const timestamp = tsParam ?? Math.floor(Date.now() / 1000);
    const timestampStr = String(timestamp);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

    // The host for the ASR service.
    const host = `${service}.tencentcloudapi.com`;

    // ── Step 1: Build Canonical Request ──
    const canonicalUri = "/";
    const canonicalQueryString = "";
    const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${host}\n`;
    const hashedPayload = await sha256Hex(payload);

    const canonicalRequest = [
        "POST",
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        SIGNED_HEADERS,
        hashedPayload,
    ].join("\n");

    // ── Step 2: Build StringToSign ──
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = await sha256Hex(canonicalRequest);

    const stringToSign = [
        ALGORITHM,
        timestampStr,
        credentialScope,
        hashedCanonicalRequest,
    ].join("\n");

    // ── Step 3: Calculate Signature ──
    const secretDate = await hmacSha256(`TC3${secretKey}`, date);
    const secretService = await hmacSha256(secretDate, service);
    const secretSigning = await hmacSha256(secretService, "tc3_request");
    const signature = await hmacSha256Hex(secretSigning, stringToSign);

    // ── Step 4: Build Authorization header ──
    // Format: "TC3-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=..."
    // No comma between algorithm and Credential (Tencent API v3 spec).
    const authorization = `${ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`;

    const headers: Record<string, string> = {
        Authorization: authorization,
        "X-TC-Action": action,
        "X-TC-Version": version,
        "X-TC-Timestamp": timestampStr,
    };
    // Region is optional for ASR; omit when empty to avoid InvalidParameterValue.
    if (region) {
        headers["X-TC-Region"] = region;
    }
    return headers;
}

// ─────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────

async function sha256Hex(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return hexFromBuffer(hash);
}

async function hmacSha256(key: ArrayBuffer | string, message: string): Promise<ArrayBuffer> {
    const encoder = new TextEncoder();
    const keyData = typeof key === "string" ? encoder.encode(key) : new Uint8Array(key);
    const messageData = encoder.encode(message);

    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );

    return crypto.subtle.sign("HMAC", cryptoKey, messageData);
}

async function hmacSha256Hex(key: ArrayBuffer, message: string): Promise<string> {
    const sig = await hmacSha256(key, message);
    return hexFromBuffer(sig);
}

function hexFromBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const hexParts: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
        hexParts.push(bytes[i]!.toString(16).padStart(2, "0"));
    }
    return hexParts.join("");
}
