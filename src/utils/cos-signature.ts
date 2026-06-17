/**
 * Tencent Cloud COS (Cloud Object Storage) signing utility.
 *
 * Implements COS 方式二 (pre-signed URL) — the signature is embedded in
 * URL query parameters, avoiding the complexity of Authorization headers.
 *
 * Reference: https://cloud.tencent.com/document/product/436/7778
 */

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface CosSignParams {
    /** Tencent Cloud SecretId. */
    secretId: string;
    /** Tencent Cloud SecretKey. */
    secretKey: string;
    /** HTTP method (e.g. "PUT", "GET"). */
    method: string;
    /** Object key (path within the bucket). */
    key: string;
    /** Additional headers to include in the signature. */
    headers?: Record<string, string>;
    /** Additional query params to include in the signature. */
    queryParams?: Record<string, string>;
    /** Signature validity duration in seconds (default: 3600 = 1 hour). */
    expireSeconds?: number;
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const SIGN_ALGORITHM = "sha1";

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Generate a pre-signed URL for COS object access (方式二).
 *
 * The signature is embedded as query parameters so the URL can be used
 * with a plain HTTP request — no Authorization header needed.
 */
export function buildCosPresignedUrl(
    bucket: string,
    region: string,
    params: CosSignParams,
): Promise<string> {
    return buildPresignedUrl(bucket, region, params);
}

// ─────────────────────────────────────────────
// Internal implementation
// ─────────────────────────────────────────────

interface SignatureParts {
    authString: string;
}

async function buildCosSignature(params: CosSignParams): Promise<SignatureParts> {
    const {
        secretId,
        secretKey,
        method,
        key,
        headers = {},
        queryParams = {},
        expireSeconds = 3600,
    } = params;

    const now = Math.floor(Date.now() / 1000);
    const expires = now + expireSeconds;
    const keyTime = `${now};${expires}`;
    const signTime = `${now};${expires}`;

    // Build sorted header list
    const headerKeys = Object.keys(headers)
        .map(k => k.toLowerCase())
        .sort();
    const headerList = headerKeys.join(";");

    // Build sorted param list
    const paramKeys = Object.keys(queryParams)
        .map(k => k.toLowerCase())
        .sort();
    const paramList = paramKeys.join(";");

    // Build HttpString
    // Per COS signing doc (§2), UriPathname uses the RAW path (decoded),
    // while the actual HTTP request line uses URL-encoded form. The
    // server computes the signature from the decoded path.
    const uriPathname = key.startsWith("/") ? key : `/${key}`;
    const headerValues = headerKeys
        .map(k => `${k}=${encodeURIComponent(headers[k] ?? "")}`)
        .join("&");
    const paramValues = paramKeys
        .map(k => `${k}=${encodeURIComponent(queryParams[k] ?? "")}`)
        .join("&");

    const httpString = [
        method.toLowerCase(),
        uriPathname,
        paramValues,
        headerValues,
        "",
    ].join("\n");

    // Build StringToSign
    const httpStringHash = await sha1Hex(httpString);
    const stringToSign = [
        SIGN_ALGORITHM,
        signTime,
        httpStringHash,
        "",
    ].join("\n");

    // COS signature (matching cos-nodejs-sdk-v5 util.getAuth):
    //   SignKey  = HMAC-SHA1(SecretKey, KeyTime).digest('hex')
    //   Sign     = HMAC-SHA1(SignKey, StringToSign).digest('hex')
    // CRITICAL: SignKey is a HEX STRING, not raw bytes. The hex string
    // is used as the HMAC key for the second round.
    const encoder = new TextEncoder();

    // Step 1: SignKey hex string = HMAC-SHA1(SecretKey, keyTime)
    const signKeyCrypto = await crypto.subtle.importKey(
        "raw", encoder.encode(secretKey),
        { name: "HMAC", hash: "SHA-1" },
        false, ["sign"],
    );
    const signKeyRaw = await crypto.subtle.sign("HMAC", signKeyCrypto, encoder.encode(keyTime));
    const signKeyHex = hexFromBuffer(signKeyRaw);

    // Step 2: Signature = HMAC-SHA1(hex(SignKey), stringToSign)
    const sigKey = await crypto.subtle.importKey(
        "raw", encoder.encode(signKeyHex),
        { name: "HMAC", hash: "SHA-1" },
        false, ["sign"],
    );
    const sigBuffer = await crypto.subtle.sign("HMAC", sigKey, encoder.encode(stringToSign));
    const signature = hexFromBuffer(sigBuffer);

    // Build auth query string for the pre-signed URL
    const authParts: string[] = [];
    authParts.push(`q-sign-algorithm=${SIGN_ALGORITHM}`);
    authParts.push(`q-ak=${secretId}`);
    authParts.push(`q-sign-time=${signTime}`);
    authParts.push(`q-key-time=${keyTime}`);
    authParts.push(`q-header-list=${headerList}`);
    authParts.push(`q-url-param-list=${paramList}`);
    authParts.push(`q-signature=${signature}`);

    return { authString: authParts.join("&") };
}

async function buildPresignedUrl(
    bucket: string,
    region: string,
    params: CosSignParams,
): Promise<string> {
    const host = `${bucket}.cos.${region}.myqcloud.com`;
    const rawKey = params.key.startsWith("/") ? params.key : `/${params.key}`;

    const { authString } = await buildCosSignature(params);

    // Append auth string directly (matching SDK: url + '?' + AuthData.Authorization).
    // url.searchParams.set() would encode ";" → "%3B" but COS expects raw ";".
    const encodedPath = cosUriEncode(rawKey);
    return `https://${host}${encodedPath}?${authString}`;
}

// ─────────────────────────────────────────────
// URI encoding (matches cos-js-sdk-v5 util.uriEncode)
// ─────────────────────────────────────────────

/**
 * COS-specific URI encoding.
 *
 * Mirrors the `util.uriEncode` function in cos-js-sdk-v5, which follows
 * AWS V4 signing conventions. Unlike `encodeURIComponent`, this keeps "/"
 * unencoded for path segments and explicitly encodes certain characters
 * that standard encoding may handle inconsistently across environments.
 */
function cosUriEncode(str: string): string {
    const encoded = encodeURIComponent(str);
    // Ensure consistent encoding per AWS V4 / COS convention
    return encoded
        .replace(/!/g, "%21")
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/\*/g, "%2A")
        // Don't encode "/" in path context
        .replace(/%2F/g, "/");
}

// ─────────────────────────────────────────────
// Crypto helpers
// ─────────────────────────────────────────────

async function sha1Hex(message: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const hash = await crypto.subtle.digest("SHA-1", data);
    return hexFromBuffer(hash);
}

function hexFromBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const hexParts: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
        hexParts.push(bytes[i]!.toString(16).padStart(2, "0"));
    }
    return hexParts.join("");
}
