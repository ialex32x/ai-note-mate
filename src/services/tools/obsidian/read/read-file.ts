import { arrayBufferToBase64 } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import {
    getMimeType,
    isFailure,
    isMediaFile,
    isNonMediaBinaryFile,
    buildLargeFilePreviewNotice,
    isWholeFileReadAvailable,
    LARGE_FILE_LINE_THRESHOLD,
    MAX_PDF_INLINE_BYTES,
    mediaKindFromMime,
    PREVIEW_LINE_COUNT,
    requireFile,
    validateLineRange,
} from "../_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Repeat-read tracking for `read_file`
//
// Threshold for the "you've already read several ranges of this file —
// consider grep_file" notice. Counts the CURRENT call inclusively, so 3
// means: "this call is the 3rd ranged read of the same file in the
// current turn". Below this, no notice is attached.
//
// Three is the smallest count that unambiguously distinguishes
// "deliberate multi-section pull" (often 1–2 reads) from "scanning the
// file in 100-line slices" (the failure mode this notice exists to
// interrupt). Tunable; not exposed as a setting because it's a
// behaviour nudge, not a hard limit (`maxCallsPerTurn` is the right
// place for hard caps).
// ─────────────────────────────────────────────────────────────────────────────

const READ_FILE_REPEAT_NOTICE_THRESHOLD = 3;

/**
 * Walk the chat history backward and collect the ranged `read_file`
 * tool_calls in the CURRENT turn that target the given file path.
 *
 * Scoping is done by stopping at the most recent `user` message — every
 * `prompt()` invocation pushes the user message *before* the tool loop
 * begins, so the walk terminates exactly at the start of the current
 * turn. (Historical turns from a resumed session contain their own
 * `user` boundaries and stay invisible to this counter.)
 *
 * The current call's own `tool_call` ChatMessage is already pushed onto
 * `_messages` before `exec` runs (see `chat-stream.ts` around the
 * registered handler dispatch), so the returned array INCLUDES the
 * current invocation. Callers should compare its length directly
 * against {@link READ_FILE_REPEAT_NOTICE_THRESHOLD}.
 *
 * Whole-file reads (no `start_line`/`end_line`) are intentionally NOT
 * counted: when a file is small enough to read whole, a single follow-
 * up grep is the right move, not a notice telling the model to grep
 * instead. Only ranged reads — the slicing pattern that produces the
 * "1–100, 101–200, …" failure mode — are tracked here.
 */
function collectRangedReadFileCallsInCurrentTurn(
    chatStream: ChatStream,
    path: string,
): { startLine: number; endLine: number }[] {
    const ranges: { startLine: number; endLine: number }[] = [];
    const messages = chatStream.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m) continue;
        if (m.role === "user") break; // current-turn boundary
        if (m.role !== "tool_call") continue;
        const meta = m.toolCallMeta;
        if (!meta || meta.toolName !== "read_file") continue;
        const args = meta.toolArgs;
        if (!args || args["path"] !== path) continue;
        const startLine = args["start_line"];
        const endLine = args["end_line"];
        if (typeof startLine !== "number" || typeof endLine !== "number") continue;
        ranges.push({ startLine, endLine });
    }
    return ranges;
}

/**
 * Build the "stop scanning, use grep instead" notice that gets
 * attached to a `read_file` result when the model is on its 3rd+
 * ranged read of the same file in one turn.
 *
 * Wording is deliberately specific: it reproduces the offending range
 * sequence so the model can SEE its own pattern rather than abstractly
 * accepting an instruction. The closing "if you have a specific reason
 * this notice doesn't address" clause is the escape valve for legit
 * multi-section reads (e.g. user explicitly asked for the bytes of
 * three named sections) — never word it as a hard prohibition or the
 * model will second-guess every legitimate range read.
 */
function buildRepeatReadFileNotice(
    path: string,
    ranges: { startLine: number; endLine: number }[],
): string {
    // Newest-first when collected; reverse so the printed sequence
    // reads in chronological order (matches the model's mental model
    // of "I read X, then Y, then Z"). Cap at 8 entries so a runaway
    // doesn't itself bloat the notice past the 500-token shrink line.
    const printable = ranges.slice(0, 8).reverse();
    const formatted = printable.map((r) => `${r.startLine}-${r.endLine}`).join(", ");
    return (
        `You have now read ${ranges.length} ranged slices of '${path}' in this turn (${formatted}). ` +
        `If you are scanning to locate a specific keyword, section, or paragraph, STOP reading further ranges and use \`grep_file\` instead — ` +
        `it returns the matching line numbers directly without ingesting the file. ` +
        `If a previous \`grep_file\` already returned matches in this turn but they are no longer visible to you, ` +
        `simply re-issue the same \`grep_file\` call: it is cheap, idempotent, and reproduces the line numbers without further range reads. ` +
        `Continue reading further ranges of this file ONLY if you have a specific reason that this notice doesn't address (e.g. the user explicitly asked for several named sections).`
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: read_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultReadFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "read_file",
                description:
                    "Read a file from the vault. " +
                    "This reads FILES only. If the path is (or might be) a folder, use `browse_folder` to list its contents instead. " +
                    "For text/markdown files, optionally specify `start_line` / `end_line` (1-based physical line numbers, " +
                    "closed interval [start_line, end_line] — both bounds inclusive). " +
                    "Lines are split by `\\n`; leading blank lines count — an empty first line IS line 1. " +
                    "Omit both to read the whole file. When the file is large " +
                    `(>${LARGE_FILE_LINE_THRESHOLD} lines) and no range is given, returns line count plus a short preview ` +
                    "instead of the full body — use `get_metadata` for heading outline, `read_section` " +
                    "for one section, or re-read with `start_line` / `end_line`. " +
                    "\n\n" +
                    "Media files (images: png/jpg/gif/webp/svg/…; audio: mp3/wav/ogg/flac/…; video: " +
                    "mp4/webm/mov/…; document: pdf) are returned as base64 via the multimodal channel; " +
                    "line range is ignored. Whether the model actually consumes the bytes depends on its " +
                    "input modalities (unsupported modalities are silently dropped with a text note). " +
                    "PDFs above ~20 MB are refused. " +
                    "Other binary formats (Office docs, archives, executables, fonts, design files, " +
                    "databases, …) are refused — convert to text/markdown first.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to the file, e.g. 'Notes/MyNote.md' or 'Images/photo.png'.",
                        },
                        start_line: {
                            type: "number",
                            description:
                                "1-based inclusive physical starting line number for reading a specific range. " +
                                "Leading blank lines are not skipped — an empty first line counts as line 1. " +
                                "Must be used together with end_line. Omit to read the entire file.",
                        },
                        end_line: {
                            type: "number",
                            description:
                                "1-based physical ending line number (INCLUSIVE) for reading a specific range. " +
                                "The range is [start_line, end_line] — both bounds inclusive. " +
                                "To read through the end of the file, set end_line = total_lines. " +
                                "Must be used together with start_line. Omit to read the entire file.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            // Media files (images/videos/audio/pdf): read as binary and return base64 for multimodal processing
            if (isMediaFile(file)) {
                const mimeType = getMimeType(file.extension);
                const kind = mediaKindFromMime(mimeType);

                // Pre-check: PDFs above the inline limit would be rejected by upstream providers
                // (OpenAI 32 MB hard cap; Gemini also memory-bound on mobile). Refuse loudly here
                // so the user gets an actionable hint instead of an opaque 4xx.
                if (kind === "pdf" && file.stat.size > MAX_PDF_INLINE_BYTES) {
                    const sizeMb = (file.stat.size / 1024 / 1024).toFixed(1);
                    const limitMb = (MAX_PDF_INLINE_BYTES / 1024 / 1024).toFixed(0);
                    return {
                        success: false,
                        type: "text",
                        content:
                            `PDF '${path}' is too large (${sizeMb} MB) to inline as a multimodal attachment ` +
                            `(limit: ${limitMb} MB). Ask the user to compress the PDF, extract a smaller page range, ` +
                            `or convert the relevant sections to text/markdown first.`,
                    };
                }

                try {
                    const buffer = await plugin.app.vault.readBinary(file);
                    const base64 = arrayBufferToBase64(buffer);
                    return {
                        success: true,
                        type: "media",
                        content: { path, kind, mimeType, base64, size: file.stat.size },
                    };
                } catch (err) {
                    return {
                        success: false,
                        type: "text",
                        content: `Failed to read media file: ${err instanceof Error ? err.message : String(err)}`,
                    };
                }
            }

            // Known non-media binary formats (Office, archives, executables, ...): refuse loudly.
            // Reading these through the text path would yield garbage bytes that the model tends
            // to "interpret" as plausible-looking content (hallucination).
            if (isNonMediaBinaryFile(file)) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Cannot read '${path}' as text: file extension '.${file.extension}' is a binary format ` +
                        `(e.g. Office documents, archives, executables) and cannot be decoded as text. ` +
                        `This tool currently supports text/markdown files and the following media files via the multimodal channel: ` +
                        `images (png, jpg, gif, webp, svg, bmp, ico, tiff), ` +
                        `videos (mp4, webm, mov, avi, mkv), ` +
                        `audio (mp3, wav, ogg, flac, aac, wma, m4a, opus), ` +
                        `documents (pdf). ` +
                        `Other binary formats are not supported — ask the user to convert the file to a supported format first.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const startLine = args["start_line"] as number | undefined;
            const endLine = args["end_line"] as number | undefined;

            // No range specified — check if file is large enough to auto-downgrade
            if (startLine === undefined && endLine === undefined) {
                const lines = content.split("\n");
                const totalLines = lines.length;

                if (isWholeFileReadAvailable(totalLines)) {
                    return {
                        success: true,
                        type: "object",
                        content: {
                            path,
                            content,
                            start_line: 1,
                            end_line: totalLines,
                            total_lines: totalLines,
                            mtime: file.stat.mtime,
                        },
                    };
                }

                // ── Large file: preview only (heading outline lives in get_metadata) ──
                const previewEnd = Math.min(PREVIEW_LINE_COUNT, totalLines);
                const preview = lines.slice(0, previewEnd).join("\n");

                return {
                    success: true,
                    type: "object",
                    content: {
                        path,
                        total_lines: totalLines,
                        mtime: file.stat.mtime,
                        notice: buildLargeFilePreviewNotice(totalLines, previewEnd),
                        preview: {
                            start_line: 1,
                            end_line: previewEnd,
                            content: preview,
                        },
                    },
                };
            }

            // Validate: both or neither must be provided
            if (startLine === undefined || endLine === undefined) {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid line range: start_line and end_line must both be specified together.`,
                };
            }

            const lines = content.split("\n");
            const totalLines = lines.length;

            // `end_line` is inclusive: [startLine, endLine] maps directly to
            // JS `slice(startLine - 1, endLine)`. `slice()` auto-clamps `end`
            // to the array length, so `endLine = totalLines` reads to EOF.
            const rangeErr = validateLineRange(startLine, endLine, totalLines);
            if (rangeErr) return rangeErr;

            const selectedContent = lines.slice(startLine - 1, endLine).join("\n");

            // Behaviour nudge against "scan the file in 100-line slices".
            // We only attach a notice when the same file has been ranged-
            // read at least {@link READ_FILE_REPEAT_NOTICE_THRESHOLD} times
            // in the current turn (inclusive of THIS call); see the helper's
            // doc comment for why this fires now and not on earlier reads.
            // The notice is plain text inside the result object — the
            // serializer will fold it into the JSON the model sees.
            const result: Record<string, unknown> = {
                path,
                content: selectedContent,
                start_line: startLine,
                end_line: endLine,
                total_lines: totalLines,
                mtime: file.stat.mtime,
            };
            const priorRanges = collectRangedReadFileCallsInCurrentTurn(_chatStream, path);
            if (priorRanges.length >= READ_FILE_REPEAT_NOTICE_THRESHOLD) {
                result["notice"] = buildRepeatReadFileNotice(path, priorRanges);
            }
            return { success: true, type: "object", content: result };
        },
    };
}
