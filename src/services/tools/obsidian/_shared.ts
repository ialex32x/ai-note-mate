import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { ToolCallResult } from "../../chat-stream";
import type { ModalityCapability } from "../../llm-provider";

// ─────────────────────────────────────────────
// Media helper utilities (images + videos + audio + pdf)
// ─────────────────────────────────────────────

export const MEDIA_EXTENSIONS = new Set([
    // Images
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif",
    // Videos
    "mp4", "webm", "mov", "avi", "mkv",
    // Audio
    "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a", "opus",
    // Documents (delivered through the multimodal channel; subject to per-provider modality config)
    "pdf",
]);

export function isMediaFile(file: TFile): boolean {
    return MEDIA_EXTENSIONS.has(file.extension.toLowerCase());
}

// ─────────────────────────────────────────────
// Non-media binary formats
//
// These are known binary file formats that are NOT currently delivered to the
// model via the multimodal channel (see MEDIA_EXTENSIONS). Reading them through
// the text path would feed garbage bytes to the LLM, which then tends to
// hallucinate plausible-looking content. `read_file` explicitly refuses
// these so the failure is loud instead of silent.
//
// Keep this list conservative: only add extensions whose content is ALWAYS
// binary. Anything that may legitimately be text (logs, configs, scripts,
// CSV/TSV, source code, …) must NOT be listed here — Obsidian users routinely
// keep such files alongside their notes.
// ─────────────────────────────────────────────

export const NON_MEDIA_BINARY_EXTENSIONS = new Set([
    // Documents
    "doc", "docx", "dot", "dotx",
    "xls", "xlsx", "xlsm", "xlsb",
    "ppt", "pptx", "pps", "ppsx",
    "odt", "ods", "odp",
    "rtf",
    "pages", "numbers", "key",
    "epub", "mobi", "azw", "azw3",
    // Archives
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz", "tbz2", "txz",
    "jar", "war", "iso", "dmg", "pkg",
    // Executables / native libs
    "exe", "dll", "so", "dylib", "msi", "app", "deb", "rpm", "apk", "ipa",
    "class", "pyc", "pyo", "wasm",
    // Fonts
    "ttf", "otf", "woff", "woff2", "eot",
    // Design / vector / 3D
    "psd", "ai", "sketch", "fig", "xd", "indd",
    "blend", "fbx", "obj", "3ds", "stl", "glb", "gltf",
    // Databases / data stores
    "db", "sqlite", "sqlite3", "mdb", "accdb",
    // Misc binary
    "bin", "dat",
]);

export function isNonMediaBinaryFile(file: TFile): boolean {
    return NON_MEDIA_BINARY_EXTENSIONS.has(file.extension.toLowerCase());
}

export function getMimeType(extension: string): string {
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
    };
    return mimeMap[extension.toLowerCase()] ?? "application/octet-stream";
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

// ─────────────────────────────────────────────
// Large file auto-downgrade thresholds
// ─────────────────────────────────────────────

/** Line-count threshold above which a full-file read is auto-downgraded to an outline + preview. */
export const LARGE_FILE_LINE_THRESHOLD = 200;
/** Number of preview lines to include in the outline response for large files. */
export const PREVIEW_LINE_COUNT = 50;

// ─────────────────────────────────────────────
// Media inlining size limits
// ─────────────────────────────────────────────

/**
 * Maximum size of a PDF file that will be inlined into a multimodal request.
 *
 * OpenAI's Chat Completions API hard-limits PDF inputs at 32 MB / 100 pages
 * (base64 inline). We pre-check at 20 MB on the raw file to leave ~33 % buffer
 * for base64 expansion and to give Gemini's `inlineData` path the same
 * breathing room. Files above this threshold are refused with a clear hint
 * pointing the user at compression / page-range extraction.
 */
export const MAX_PDF_INLINE_BYTES = 20 * 1024 * 1024;

// ─────────────────────────────────────────────
// Path validators
// ─────────────────────────────────────────────

/**
 * Resolve a vault-relative path to a `TFile`.
 * Returns either the file, or a failure `ToolCallResult` describing why it could not be resolved.
 */
export function requireFile(app: App, path: string): TFile | ToolCallResult {
    const entry = app.vault.getAbstractFileByPath(path);
    if (!entry) {
        return { success: false, type: "text", content: `File not found: ${path}` };
    }
    if (!(entry instanceof TFile)) {
        return { success: false, type: "text", content: `Path is a folder, not a file: ${path}` };
    }
    return entry;
}

/**
 * Resolve a vault-relative path to a `TFolder`.
 * Returns either the folder, or a failure `ToolCallResult` describing why it could not be resolved.
 */
export function requireFolder(app: App, path: string): TFolder | ToolCallResult {
    const entry = app.vault.getAbstractFileByPath(path);
    if (!entry) {
        return { success: false, type: "text", content: `Folder not found: ${path}` };
    }
    if (!(entry instanceof TFolder)) {
        return { success: false, type: "text", content: `Path is a file, not a folder: ${path}` };
    }
    return entry;
}

/**
 * Narrow-type guard distinguishing successful resolution from failure result.
 */
export function isFailure(value: unknown): value is ToolCallResult {
    return typeof value === "object" && value !== null && (value as ToolCallResult).success === false;
}

/**
 * Validate a 1-based inclusive line range.
 *
 * - When `totalLines` is provided, range upper bounds are also checked.
 * - Returns `null` if the range is valid, otherwise a failure `ToolCallResult`.
 *
 * Options:
 * - `clampEndLine`: When true, an `endLine` equal to `totalLines + 1` is
 *   silently accepted and treated as `totalLines`. This is a pragmatic
 *   concession for read-only callers: LLMs frequently emit an
 *   exclusive-style upper bound (off-by-one), and slicing past the end is
 *   harmless for reads. **Never enable this for write/replace tools** —
 *   a one-line overshoot there would change which lines get replaced and
 *   silently corrupt user data. Only clamps by exactly 1 line; larger
 *   overshoots still fail, since those likely indicate a real
 *   misunderstanding of the file's size rather than an off-by-one slip.
 */
export function validateLineRange(
    startLine: number,
    endLine: number,
    totalLines?: number,
    options?: { clampEndLine?: boolean },
): ToolCallResult | null {
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < 1) {
        return {
            success: false,
            type: "text",
            content:
                `Invalid line range: start_line and end_line must be positive integers (1-based). ` +
                `Got start_line=${startLine}, end_line=${endLine}.`,
        };
    }
    if (startLine > endLine) {
        return {
            success: false,
            type: "text",
            content: `Invalid line range: start_line (${startLine}) must not exceed end_line (${endLine}).`,
        };
    }
    if (totalLines !== undefined) {
        if (startLine > totalLines) {
            return {
                success: false,
                type: "text",
                content: `Invalid line range: start_line (${startLine}) exceeds total number of lines in the file (${totalLines}).`,
            };
        }
        // Allow end_line === totalLines + 1 as a forgiving off-by-one (exclusive-style upper bound)
        // when the caller opts in. Anything further still fails loudly.
        const endLimit = options?.clampEndLine ? totalLines + 1 : totalLines;
        if (endLine > endLimit) {
            return {
                success: false,
                type: "text",
                content: `Invalid line range: end_line (${endLine}) exceeds total number of lines in the file (${totalLines}).`,
            };
        }
    }
    return null;
}

/**
 * Validate that a vault-relative path includes a file extension.
 *
 * Used by write tools (create / append / prepend / rename) to refuse paths
 * like `Notes/draft` that would otherwise produce an extension-less file
 * which Obsidian does not recognize as a note. We deliberately do NOT
 * auto-append `.md`: the model may have intended `.canvas`, `.json`, etc.,
 * and silent correction would hide the mismatch from the audit trail.
 *
 * Returns `null` when the path has an extension, otherwise a failure
 * `ToolCallResult` whose message includes a suggested corrected path so
 * the model can retry deterministically.
 */
export function requireFileExtension(path: string): ToolCallResult | null {
    // Look for an extension on the final path segment only.
    const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
    // A valid extension is a dot followed by at least one non-dot/slash char,
    // and it must not be the leading dot of a dotfile (e.g. `.gitignore`
    // technically counts as having no extension here, which is fine — those
    // don't belong in an Obsidian vault as notes anyway).
    const dotIdx = filename.lastIndexOf(".");
    const hasExtension = dotIdx > 0 && dotIdx < filename.length - 1;
    if (hasExtension) return null;
    return {
        success: false,
        type: "text",
        content:
            `Path '${path}' has no file extension. ` +
            `Extensions are required and will not be inferred. ` +
            `Retry with an explicit extension, e.g. '${path}.md' for a markdown note.`,
    };
}

/**
 * Ensure the parent folder for `path` exists; create it recursively if missing.
 * No-op when `path` resides at the vault root.
 */
export async function ensureParentFolder(app: App, path: string): Promise<void> {
    const parentPath = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
    if (!parentPath) return;
    const parentExists = app.vault.getAbstractFileByPath(parentPath);
    if (!parentExists) {
        await app.vault.createFolder(parentPath);
    }
}
