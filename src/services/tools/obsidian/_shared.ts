import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { ToolCallResult } from "../../chat-stream";

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
// MIME-type helpers — implemented in utils/mime-helper.ts; re-exported
// here for backward-compat within the obsidian/ tool family.
// ─────────────────────────────────────────────

export { getMimeType, mimeTypeToExt, mediaKindFromMime } from "../../../utils/mime-helper";

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

// ─────────────────────────────────────────────
// Large file auto-downgrade thresholds
// ─────────────────────────────────────────────

/** Line-count threshold above which a full-file read is auto-downgraded to preview only. */
export const LARGE_FILE_LINE_THRESHOLD = 500;
/** Number of preview lines to include when a large file is auto-downgraded. */
export const PREVIEW_LINE_COUNT = 25;

const LARGE_FILE_READ_ACTION_GUIDANCE =
    "Use read_section, grep_file, or read_file with start_line/end_line.";

/** Whether `read_file` without a line range will return the full body (vs preview-only downgrade). */
export function isWholeFileReadAvailable(totalLines: number): boolean {
    return totalLines <= LARGE_FILE_LINE_THRESHOLD;
}

/**
 * When the target path is a structured Obsidian format that has dedicated
 * create tools, return a redirect failure so the model does not hand-write
 * JSON/YAML through generic `create_file`.
 */
export function structuredFileCreateRedirect(path: string): ToolCallResult | null {
    const lower = path.toLowerCase();
    if (lower.endsWith(".canvas")) {
        return {
            success: false,
            type: "text",
            content:
                `Path '${path}' is an Obsidian Canvas file. Use \`create_canvas\` instead of \`create_file\` — ` +
                `it validates JSON Canvas 1.0 before writing. For incremental edits on an existing canvas, ` +
                `use \`add_canvas_nodes\`, \`add_canvas_edges\`, or \`layout_canvas_grid\`.`,
        };
    }
    if (lower.endsWith(".base")) {
        return {
            success: false,
            type: "text",
            content:
                `Path '${path}' is an Obsidian Bases file. Use \`create_base\` instead of \`create_file\` — ` +
                `it validates the YAML structure before writing. For view-level edits on an existing base, ` +
                `use \`add_base_view\`, \`update_base_filters\`, or \`update_base_view_order\`.`,
        };
    }
    return null;
}

/** Proactive hint for `get_metadata` when a whole-file `read_file` would be downgraded. */
export function buildLargeFileReadGuidance(): string {
    return (
        `Exceeds ${LARGE_FILE_LINE_THRESHOLD}-line threshold — read_file without start_line/end_line ` +
        `returns preview only. ${LARGE_FILE_READ_ACTION_GUIDANCE}`
    );
}

/** Extra fields to attach to metadata/read responses for files above {@link LARGE_FILE_LINE_THRESHOLD}. */
export function largeFileReadHints(totalLines: number): Record<string, unknown> {
    if (isWholeFileReadAvailable(totalLines)) {
        return {};
    }
    return {
        whole_file_read_available: false,
        read_guidance: buildLargeFileReadGuidance(),
    };
}

/** Notice attached when a whole-file read is downgraded for a large text file. */
export function buildLargeFilePreviewNotice(totalLines: number, previewEnd: number): string {
    return (
        `This file is large (${totalLines} lines). Full body omitted — showing first ${previewEnd} lines as preview. ` +
        `For heading outline use get_metadata; ${LARGE_FILE_READ_ACTION_GUIDANCE}`
    );
}

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

const VAULT_PATHS_ARG_EXAMPLE = '{"paths": ["Notes/A.md"]}';

/**
 * Normalize a batched `paths` tool argument.
 *
 * Accepts the canonical shape (`paths: string[]`) and common LLM mistakes:
 * - `paths` as a single string → wrapped as a one-element array
 * - singular `path` when `paths` is absent → same wrap (legacy alias)
 *
 * Returns a failure `ToolCallResult` with a corrective example when the value
 * cannot be coerced.
 */
export function normalizeVaultPathsArg(args: Record<string, unknown>): string[] | ToolCallResult {
    let raw: unknown = args["paths"];

    if (raw === undefined || raw === null) {
        const singlePath = args["path"];
        if (typeof singlePath === "string" && singlePath.length > 0) {
            raw = [singlePath];
        }
    } else if (typeof raw === "string") {
        raw = raw.length > 0 ? [raw] : [];
    }

    if (!Array.isArray(raw) || raw.length === 0) {
        const hint =
            typeof args["paths"] === "string"
                ? "`paths` must be a JSON array, not a bare string."
                : args["path"] !== undefined
                  ? "Use `paths` (array), not `path`. Example: " + VAULT_PATHS_ARG_EXAMPLE
                  : "`paths` must be a non-empty array.";
        return {
            success: false,
            type: "text",
            content: `${hint} Example: ${VAULT_PATHS_ARG_EXAMPLE}. For one file, use ["Notes/A.md"].`,
        };
    }

    if (raw.some((p) => typeof p !== "string" || p.length === 0)) {
        return {
            success: false,
            type: "text",
            content:
                "Each entry in `paths` must be a non-empty string. " +
                `Example: ${VAULT_PATHS_ARG_EXAMPLE}.`,
        };
    }

    return raw as string[];
}

/**
 * Validate a line range. By default expects 1-based inclusive `[startLine, endLine]`.
 *
 * Options:
 * - `clampEndLine`: When true, an `endLine` equal to `totalLines + 1` is
 *   accepted — this supports legacy exclusive-style callers (e.g. internal
 *   section resolution) where the half-open bound `[start, end)` naturally
 *   hits `totalLines + 1` for "read to EOF". **Never enable this for
 *   write/replace tools** — a one-line overshoot there would change which
 *   lines get replaced and silently corrupt user data. Only clamps by
 *   exactly 1 line; larger overshoots still fail.
 *
 *   NOTE: `read_file` and `edit_lines` now use INCLUSIVE `end_line`
 *   semantics — `clampEndLine` is no longer needed for those tools.
 *   This option remains for internal use (e.g. heading section resolution).
 *
 * - When `totalLines` is provided, range upper bounds are also checked.
 * - Returns `null` if the range is valid, otherwise a failure `ToolCallResult`.
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

/** Maximum accepted length of a user-supplied regex pattern. */
const MAX_REGEX_PATTERN_LENGTH = 1000;

/** An unbounded quantifier: `*`, `+`, or `{n,}` (no upper limit). */
const UNBOUNDED_QUANTIFIER = String.raw`(?:[*+]|\{\d+,\})`;

/**
 * Detects the canonical catastrophic-backtracking shape: an unbounded quantifier
 * that closes a group, immediately followed by another unbounded quantifier on
 * that group — e.g. `(a+)+`, `(\w*)*`, `([a-z]+){2,}`.
 */
const NESTED_QUANTIFIER_RE = new RegExp(
    `${UNBOUNDED_QUANTIFIER}\\)${UNBOUNDED_QUANTIFIER}`,
);

/**
 * Lightweight ReDoS guard for user-supplied regex patterns.
 *
 * JavaScript regexes cannot be interrupted once matching starts, so instead of a
 * timeout (which would require a worker thread — too heavy for mobile) we reject
 * the patterns that realistically freeze the main thread *before* compiling them:
 *   1. patterns longer than {@link MAX_REGEX_PATTERN_LENGTH} characters, and
 *   2. nested unbounded quantifiers (the classic exponential-backtracking shape).
 *
 * This is a pragmatic heuristic, not a proof of safety. Returns a human-readable
 * error message when the pattern looks unsafe, or `null` when it passes.
 */
export function checkRegexSafety(pattern: string): string | null {
    if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
        return `Regex pattern is too long (${pattern.length} > ${MAX_REGEX_PATTERN_LENGTH} characters).`;
    }
    if (NESTED_QUANTIFIER_RE.test(pattern)) {
        return (
            "Regex pattern has nested unbounded quantifiers (e.g. `(a+)+`) that can cause " +
            "catastrophic backtracking and freeze the app. Simplify the pattern or use literal (non-regex) mode."
        );
    }
    return null;
}
