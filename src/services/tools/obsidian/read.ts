import { arrayBufferToBase64 } from "obsidian";
import type NoteAssistantPlugin from "../../../main";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../../chat-stream";
import type { ToolCapability } from "../../llm-provider";
import { resolveFileRef } from "../../../utils/workspace-utils";
import { TFolder } from "obsidian";
import {
    getMimeType,
    isFailure,
    isMediaFile,
    isNonMediaBinaryFile,
    buildLargeFilePreviewNotice,
    LARGE_FILE_LINE_THRESHOLD,
    MAX_PDF_INLINE_BYTES,
    mediaKindFromMime,
    PREVIEW_LINE_COUNT,
    normalizeVaultPathsArg,
    requireFile,
    validateLineRange,
} from "./_shared";
import {
    formatFindSectionError,
    normalizeHeadingPathArg,
    resolveHeadingPathToRange,
    type HeadingNode,
} from "./heading-section";

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
                    "For text/markdown files, optionally specify `start_line` / `end_line` (1-based, " +
                    "inclusive) for a range; omit both to read the whole file. When the file is large " +
                    "(> ~200 lines) and no range is given, returns line count plus a short preview " +
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
                                "1-based starting line number for reading a specific range. " +
                                "Must be used together with end_line. Omit to read the entire file.",
                        },
                        end_line: {
                            type: "number",
                            description:
                                "1-based ending line number (inclusive) for reading a specific range. " +
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

                if (totalLines <= LARGE_FILE_LINE_THRESHOLD) {
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

            // Read path is forgiving about a one-line overshoot on end_line:
            // LLMs routinely emit an exclusive-style upper bound (totalLines + 1).
            // Slicing past the end is harmless for reads.
            const rangeErr = validateLineRange(startLine, endLine, totalLines, { clampEndLine: true });
            if (rangeErr) return rangeErr;

            const effectiveEndLine = Math.min(endLine, totalLines);
            const selectedContent = lines.slice(startLine - 1, effectiveEndLine).join("\n");

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
                end_line: effectiveEndLine,
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

// ─────────────────────────────────────────────────────────────────────────────
// Tool: read_section
//
// Drill into ONE section of a markdown file by heading path, instead of
// fetching the whole file. Designed as the natural follow-up to
// `get_metadata`: once the model knows a file's outline, it can pull just
// the section it needs without dragging the rest of the file into context.
//
// Intentionally *not* exposed to the main agent in multi-agent mode — it
// is registered alongside other read-only tools so that the vault
// inspector sub-agent uses it during digest workflows. Letting the main
// agent call it directly would re-encourage "read full file in main
// thread" patterns, defeating the digest-via-delegation design.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultReadSection(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "read_section",
                description:
                    "Read a single section of a markdown file by heading path. " +
                    "Use this AFTER get_metadata has revealed the heading outline " +
                    "to drill into a specific heading instead of pulling the whole file. " +
                    "The section spans from the matched heading line up to (but not including) " +
                    "the next heading at the same OR shallower level — i.e. nested subsections " +
                    "are included by default. Set include_subsections=false to stop at the very " +
                    "next heading of any level. Matching is exact (case-sensitive, trimmed). " +
                    "If the heading path is ambiguous or missing, the tool returns an error " +
                    "with concrete diagnostics so you can refine the path on the next call.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to a markdown file, e.g. 'Notes/MyNote.md'.",
                        },
                        heading_path: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Parameter name is heading_path (not heading or section). Heading titles, " +
                                "ordered outermost → innermost, that the target heading's ancestor chain " +
                                "must END WITH. The full chain ['Chapter 2', 'Background'] and the shorter " +
                                "tail ['Background'] both resolve to the same heading IF that tail is unique " +
                                "in the file; otherwise the call fails as ambiguous and you must prepend more " +
                                "ancestors. Intermediate ancestors must NOT be skipped (['Chapter 1', 'Background'] " +
                                "is rejected when 'Background' actually sits under 'Chapter 1 > Body').",
                        },
                        include_subsections: {
                            type: "boolean",
                            description:
                                "If true (default), nested subsections are included until a sibling " +
                                "or shallower heading. If false, the section ends at the next heading " +
                                "of any level.",
                        },
                    },
                    required: ["path", "heading_path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const includeSubsections = (args["include_subsections"] as boolean | undefined) ?? true;

            const headingPathResult = normalizeHeadingPathArg(args, { required: true });
            if (!headingPathResult.ok) {
                return {
                    success: false,
                    type: "text",
                    content: headingPathResult.message,
                };
            }
            const headingPath = headingPathResult.value!;

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            // Refuse non-markdown / binary files: heading paths only make sense
            // for markdown, and silently text-decoding e.g. a PDF or a docx
            // would feed garbage to the model.
            if (isMediaFile(file) || isNonMediaBinaryFile(file)) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `read_section only supports markdown / plain-text files; '${path}' has extension '.${file.extension}'. ` +
                        `Use read_file (multimodal channel) for media or get_metadata for structural inspection.`,
                };
            }
            if (file.extension.toLowerCase() !== "md") {
                return {
                    success: false,
                    type: "text",
                    content:
                        `read_section only operates on markdown files (.md); '${path}' has extension '.${file.extension}'. ` +
                        `Use read_file with start_line/end_line for non-markdown text files.`,
                };
            }

            const cache = plugin.app.metadataCache.getFileCache(file);
            const cachedHeadings: HeadingNode[] = (cache?.headings ?? []).map((h) => ({
                level: h.level,
                heading: h.heading,
                line: h.position.start.line,
            }));

            const content = await plugin.app.vault.read(file);
            const lines = content.split("\n");
            const totalLines = lines.length;

            const resolved = resolveHeadingPathToRange(
                cachedHeadings,
                headingPath,
                totalLines,
                includeSubsections,
            );
            if (!resolved.ok) {
                return {
                    success: false,
                    type: "text",
                    content: formatFindSectionError(resolved.error, headingPath),
                };
            }

            const { start_line, end_line, level, heading } = resolved.section;
            const sliced = lines.slice(start_line - 1, end_line).join("\n");

            return {
                success: true,
                type: "object",
                content: {
                    path,
                    heading_path: headingPath,
                    matched_heading: heading,
                    level,
                    start_line,
                    end_line,
                    total_lines: totalLines,
                    include_subsections: includeSubsections,
                    content: sliced,
                    mtime: file.stat.mtime,
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_active_file
// ─────────────────────────────────────────────────────────────────────────────

export function vaultGetActiveFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "get_active_file",
                description:
                    "Get info about the file currently focused in the editor. Use when the user refers " +
                    "to 'this file', 'current note', 'the note I'm viewing', etc. Optionally include " +
                    "its content. When `include_content` is true and the file is large (> ~200 lines), " +
                    "line count plus a short preview is returned instead of the full body — use " +
                    "`get_metadata` for heading outline and `read_file` with `start_line` / `end_line` " +
                    "for specific sections.",
                parameters: {
                    type: "object",
                    properties: {
                        include_content: {
                            type: "boolean",
                            description:
                                "If true, also return the text content of the file (or preview-only for large files). Defaults to false.",
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const includeContent = (args["include_content"] as boolean) ?? false;
            const activeFile = plugin.app.workspace.getActiveFile();

            if (!activeFile) {
                return { success: false, type: "text", content: "No file is currently active in the editor." };
            }

            const result: Record<string, unknown> = {
                path: activeFile.path,
                name: activeFile.name,
                extension: activeFile.extension,
                size: activeFile.stat.size,
                ctime: activeFile.stat.ctime,
                mtime: activeFile.stat.mtime,
            };

            if (includeContent) {
                if (isMediaFile(activeFile)) {
                    result["content_omitted"] =
                        `File extension '.${activeFile.extension}' is a media file. ` +
                        `Use read_file to load it via the multimodal channel.`;
                } else if (isNonMediaBinaryFile(activeFile)) {
                    result["content_omitted"] =
                        `File extension '.${activeFile.extension}' is a binary format and cannot be decoded as text.`;
                } else {
                    const content = await plugin.app.vault.read(activeFile);
                    const lines = content.split("\n");
                    const totalLines = lines.length;

                    if (totalLines <= LARGE_FILE_LINE_THRESHOLD) {
                        result["content"] = content;
                    } else {
                        // Large file: preview only (heading outline lives in get_metadata)
                        const previewEnd = Math.min(PREVIEW_LINE_COUNT, totalLines);
                        result["content"] = {
                            total_lines: totalLines,
                            notice: buildLargeFilePreviewNotice(totalLines, previewEnd),
                            preview: {
                                start_line: 1,
                                end_line: previewEnd,
                                content: lines.slice(0, previewEnd).join("\n"),
                            },
                        };
                    }
                }
            }

            return { success: true, type: "object", content: result };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_metadata
// ─────────────────────────────────────────────────────────────────────────────

export function vaultGetMetadata(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "get_metadata",
                description:
                    "Get parsed frontmatter, structural info (headings / tags), and basic file " +
                    "state (mtime / ctime / size) of one or more markdown files — without reading the " +
                    "full content. For outgoing links use `get_outgoing_links` (resolved target paths " +
                    "with occurrence counts); for incoming links use `get_backlinks`. " +
                    "Primary inspector for notes: use this (not `get_file_state`) when you need " +
                    "structure or batch inspection. For a single non-markdown file where you only need " +
                    "timestamps/size with no structure, use `get_file_state` instead. REQUIRED argument shape: " +
                    "`paths` as a JSON array of strings — even for a single file use {\"paths\": [\"note.md\"]}, " +
                    "not a bare string and not the `path` key. Accepts up to 200 paths per call; batch multiple " +
                    "files in one call instead of repeated single-path calls.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "JSON array of vault-relative markdown paths (1–200). Single file: " +
                                "['Notes/A.md']. Multiple: ['Notes/A.md', 'Notes/B.md']. Never a bare string.",
                        },
                    },
                    required: ["paths"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const pathsOrErr = normalizeVaultPathsArg(args);
            if (isFailure(pathsOrErr)) return pathsOrErr;
            const rawPaths = pathsOrErr;

            if (rawPaths.length > 200) {
                return { success: false, type: "text", content: `Too many paths (${rawPaths.length}); maximum is 200.` };
            }

            const results: Array<Record<string, unknown>> = [];

            for (const path of rawPaths) {
                const fileOrErr = requireFile(plugin.app, path);
                if (isFailure(fileOrErr)) {
                    results.push({ path, error: fileOrErr.content });
                    continue;
                }
                const file = fileOrErr;

                const cache = plugin.app.metadataCache.getFileCache(file);
                // File state is independent of metadataCache parsing — always
                // include it so a single get_metadata call can answer both
                // "what's in this note" and "when was it last modified".
                const stat = file.stat;

                if (!cache) {
                    results.push({
                        path,
                        frontmatter: null,
                        headings: [],
                        total_headings: 0,
                        tags: [],
                        total_tags: 0,
                        mtime: stat.mtime,
                        ctime: stat.ctime,
                        size: stat.size,
                    });
                    continue;
                }

                const headings = (cache.headings ?? []).map((h) => ({
                    level: h.level,
                    heading: h.heading,
                    line: h.position.start.line + 1, // Convert 0-based to 1-based
                }));

                const tags = (cache.tags ?? []).map((t) => t.tag);

                const frontmatterPosition = cache.frontmatterPosition
                    ? {
                          start_line: cache.frontmatterPosition.start.line + 1, // Convert 0-based to 1-based
                          end_line: cache.frontmatterPosition.end.line + 1,
                      }
                    : null;

                results.push({
                    path,
                    frontmatter: cache.frontmatter ?? null,
                    frontmatter_position: frontmatterPosition,
                    headings,
                    total_headings: headings.length,
                    tags,
                    total_tags: tags.length,
                    mtime: stat.mtime,
                    ctime: stat.ctime,
                    size: stat.size,
                });
            }

            return {
                success: true,
                type: "object",
                content: { files: results },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: get_file_state
// ─────────────────────────────────────────────────────────────────────────────

export function vaultGetFileState(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "get_file_state",
                description:
                    "Get timestamps and size for one file (ctime, mtime, size) without reading content or " +
                    "parsing note structure. Use for non-markdown files (images, PDFs, etc.) or when you " +
                    "only need stat fields for a single path. Do NOT use for markdown structure (headings, " +
                    "tags, frontmatter) or batch inspection — use `get_metadata` instead. For outgoing or " +
                    "incoming links use `get_outgoing_links` / `get_backlinks`. If you already called " +
                    "`read_file`, `read_section`, or `get_metadata`, reuse their `mtime` rather than calling " +
                    "this tool again. Times are Unix timestamps in milliseconds.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const stat = file.stat;
            return {
                success: true,
                type: "object",
                content: {
                    path,
                    name: file.name,
                    extension: file.extension,
                    ctime: stat.ctime,
                    mtime: stat.mtime,
                    size: stat.size,
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: is_folder
// ─────────────────────────────────────────────────────────────────────────────

export function vaultIsFolder(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "is_folder",
                description:
                    "Check if a given path in the vault is a folder or a file. " +
                    "Use this when the user wants to verify if a path is a folder or check path type.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to check.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const file = plugin.app.vault.getAbstractFileByPath(path);

            if (!file) {
                return {
                    success: true,
                    type: "object",
                    content: {
                        path,
                        exists: false,
                        is_folder: false,
                    },
                };
            }

            const isFolder = file instanceof TFolder;
            return {
                success: true,
                type: "object",
                content: {
                    path,
                    exists: true,
                    is_folder: isFolder,
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: resolve_link
// ─────────────────────────────────────────────────────────────────────────────

export function vaultResolveLink(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "resolve_link",
                description:
                    "Resolve a wikilink reference (filename-only) to its full vault path. ONLY use when " +
                    "the reference has no `/` — for paths like `Notes/MyNote.md` resolve directly. " +
                    "Searches the whole vault for a unique match; if a file and folder share the name, " +
                    "the file wins.",
                parameters: {
                    type: "object",
                    properties: {
                        reference: {
                            type: "string",
                            description:
                                "The file/folder reference to resolve, e.g. 'MyNote' or 'Notes/MyNote.md'. " +
                                "Can be a wikilink inner text without the [[]] brackets.",
                        },
                    },
                    required: ["reference"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const reference = args["reference"] as string;
            const resolved = resolveFileRef(plugin.app, reference);

            if (!resolved) {
                return {
                    success: false,
                    type: "text",
                    content: `Could not resolve reference: '${reference}'. No unique match found in the vault.`,
                };
            }

            return {
                success: true,
                type: "object",
                content: {
                    reference,
                    resolved_path: resolved.path,
                    is_folder: resolved.isFolder,
                    is_short_link: resolved.isShortLink,
                },
            };
        },
    };
}
