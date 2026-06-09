import type { ModalityCapability } from "../services/llm-provider";

/**
 * Map a file extension (without leading dot) to its MIME type.
 *
 * @param extension - File extension, case-insensitive.
 * @param fallback - Value to return when the extension is unrecognized.
 *   Defaults to `"application/octet-stream"`. Pass `null` to receive
 *   `null` instead of a fallback value.
 */
export function getMimeType(extension: string): string;
export function getMimeType(extension: string, fallback: string): string;
export function getMimeType(extension: string, fallback: null): string | null;
export function getMimeType(extension: string, fallback: string | null = "application/octet-stream"): string | null {
    const mimeMap: Record<string, string> = {
        // Images
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        bmp: "image/bmp",
        ico: "image/x-icon",
        tiff: "image/tiff",
        tif: "image/tiff",
        // Videos
        mp4: "video/mp4",
        webm: "video/webm",
        mov: "video/quicktime",
        avi: "video/x-msvideo",
        mkv: "video/x-matroska",
        // Audio
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        flac: "audio/flac",
        aac: "audio/aac",
        wma: "audio/x-ms-wma",
        m4a: "audio/mp4",
        opus: "audio/opus",
        // Documents
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        // Text
        md: "text/markdown",
        markdown: "text/markdown",
        txt: "text/plain",
        csv: "text/csv",
        tsv: "text/tab-separated-values",
        html: "text/html",
        htm: "text/html",
        xml: "application/xml",
        json: "application/json",
        yaml: "application/x-yaml",
        yml: "application/x-yaml",
        toml: "application/toml",
        css: "text/css",
        js: "application/javascript",
        ts: "application/typescript",
        jsx: "text/jsx",
        tsx: "text/tsx",
        // Data / Config
        ini: "text/plain",
        cfg: "text/plain",
        conf: "text/plain",
        env: "text/plain",
        log: "text/plain",
        // Archives
        zip: "application/zip",
        tar: "application/x-tar",
        gz: "application/gzip",
        "7z": "application/x-7z-compressed",
        rar: "application/vnd.rar",
    };
    return mimeMap[extension.toLowerCase()] ?? fallback;
}

/**
 * Inverse of `getMimeType` for image types: convert a MIME type to a file extension.
 * Only covers image MIME types. Falls back to `"png"` for unknown inputs
 * (the typical save-format default for generated images).
 */
export function mimeTypeToExt(mimeType: string): string {
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
    };
    return map[mimeType] ?? "png";
}

/**
 * Infer the modality kind for a MIME type. Used when constructing a
 * `MediaAttachment` from a vault file or a tool result. Falls back to
 * `image` so callers always end up with a valid kind value.
 */
export function mediaKindFromMime(mime: string): ModalityCapability {
    const m = mime.toLowerCase();
    if (m.startsWith("audio/")) return "audio";
    if (m.startsWith("video/")) return "video";
    if (m === "application/pdf") return "pdf";
    return "image";
}
