import { arrayBufferToBase64 } from "obsidian";
import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool, ToolCallResult } from "../../chat-stream";
import type { ToolCapability } from "../../llm-provider";
import { resolveFileRef } from "../../../utils/workspace-utils";
import { TFolder } from "obsidian";
import {
    getMimeType,
    isFailure,
    isMediaFile,
    isNonMediaBinaryFile,
    LARGE_FILE_LINE_THRESHOLD,
    MAX_PDF_INLINE_BYTES,
    mediaKindFromMime,
    PREVIEW_LINE_COUNT,
    requireFile,
    validateLineRange,
} from "./_shared";
import {
    formatFindSectionError,
    resolveHeadingPathToRange,
    type HeadingNode,
} from "./heading-section";

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
                    "Read the content of a file in the Obsidian vault. " +
                    "For text/markdown files, optionally specify start_line and end_line (1-based, inclusive) " +
                    "to read only a specific line range; omit both to read the entire file. " +
                    "IMPORTANT: When the file is large (more than ~200 lines) and no line range is specified, " +
                    "this tool returns a structured outline with headings and line numbers plus a content preview " +
                    "instead of the full content. Use the heading line numbers to decide which sections to read " +
                    "with start_line/end_line in a follow-up call. " +
                    "For media files (images: png, jpg, gif, webp, svg, etc.; videos: mp4, webm, mov, etc.; " +
                    "audio: mp3, wav, ogg, flac, etc.; documents: pdf), " +
                    "returns the file as base64 data for viewing and analysis (line range is not applicable). " +
                    "Whether the audio/video/pdf content is actually delivered to you depends on the active model's " +
                    "configured input modalities; unsupported modalities are silently dropped with a short text note. " +
                    "PDFs above ~20 MB are rejected to stay within provider inline-attachment limits. " +
                    "BINARY FORMATS NOT SUPPORTED: Office documents (doc/docx/xls/xlsx/ppt/pptx/...), archives (zip/rar/7z/...), " +
                    "executables, fonts, design files, databases, etc. are rejected — do not attempt to read them with this tool; " +
                    "ask the user to convert to a supported format first. " +
                    "Use this when the user wants to read, view, check, examine, see, open, or show the content of a specific file.",
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
                        },
                    };
                }

                // ── Large file: return outline + preview instead of full content ──
                const cache = plugin.app.metadataCache.getFileCache(file);
                const headings = (cache?.headings ?? []).map((h) => ({
                    level: h.level,
                    heading: h.heading,
                    line: h.position.start.line + 1, // Convert 0-based to 1-based
                }));

                const previewEnd = Math.min(PREVIEW_LINE_COUNT, totalLines);
                const preview = lines.slice(0, previewEnd).join("\n");

                return {
                    success: true,
                    type: "object",
                    content: {
                        path,
                        total_lines: totalLines,
                        notice:
                            `This file is large (${totalLines} lines). Showing outline and first ${previewEnd} lines as preview. ` +
                            `Use start_line and end_line to read specific sections.`,
                        outline: headings,
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

            return {
                success: true,
                type: "object",
                content: {
                    path,
                    content: selectedContent,
                    start_line: startLine,
                    end_line: effectiveEndLine,
                    total_lines: totalLines,
                },
            };
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
                    "Use this AFTER get_metadata (or read_file's outline mode for large files) " +
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
                                "Heading titles, ordered outermost → innermost, that the target " +
                                "heading's ancestor chain must END WITH. The full chain " +
                                "['Chapter 2', 'Background'] and the shorter tail ['Background'] " +
                                "both resolve to the same heading IF that tail is unique in the " +
                                "file; otherwise the call fails as ambiguous and you must prepend " +
                                "more ancestors. Intermediate ancestors must NOT be skipped " +
                                "(['Chapter 1', 'Background'] is rejected when 'Background' " +
                                "actually sits under 'Chapter 1 > Body').",
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
            const headingPathRaw = args["heading_path"];
            const includeSubsections = (args["include_subsections"] as boolean | undefined) ?? true;

            if (!Array.isArray(headingPathRaw) || headingPathRaw.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content: `heading_path must be a non-empty array of heading titles (outermost to innermost).`,
                };
            }
            const headingPath: string[] = [];
            for (const item of headingPathRaw) {
                if (typeof item !== "string") {
                    return {
                        success: false,
                        type: "text",
                        content: `heading_path must contain only strings; got ${typeof item}.`,
                    };
                }
                headingPath.push(item);
            }

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
                    "Get information about the file currently open and focused in the editor. " +
                    "Use this when the user refers to 'this file', 'current note', 'active file', " +
                    "'the note I'm viewing', or 'the file I'm looking at'. " +
                    "Optionally include its content. " +
                    "NOTE: When include_content is true and the file is large (more than ~200 lines), " +
                    "only an outline with headings/line numbers and a content preview are returned " +
                    "instead of the full content. Use read_file with start_line/end_line to read specific sections.",
                parameters: {
                    type: "object",
                    properties: {
                        include_content: {
                            type: "boolean",
                            description:
                                "If true, also return the text content of the file (or outline+preview for large files). Defaults to false.",
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
                created: activeFile.stat.ctime,
                modified: activeFile.stat.mtime,
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
                        // Large file: return outline + preview
                        const cache = plugin.app.metadataCache.getFileCache(activeFile);
                        const headings = (cache?.headings ?? []).map((h) => ({
                            level: h.level,
                            heading: h.heading,
                            line: h.position.start.line + 1,
                        }));
                        const previewEnd = Math.min(PREVIEW_LINE_COUNT, totalLines);
                        result["content"] = {
                            total_lines: totalLines,
                            notice:
                                `This file is large (${totalLines} lines). Showing outline and first ${previewEnd} lines as preview. ` +
                                `Use read_file with start_line/end_line to read specific sections.`,
                            outline: headings,
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
                    "Get the parsed frontmatter metadata and structural info (headings, tags, links) " +
                    "of one or more markdown files, without reading the full content. " +
                    "Accepts up to 200 paths in a single call — prefer batching over sequential single-path calls. " +
                    "Use this when the user wants to see a note's structure, outline, tags, links, " +
                    "or frontmatter/YAML metadata without loading the entire file.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Array of vault-relative paths to markdown files (1–200 paths). " +
                                "Example: ['Notes/A.md', 'Notes/B.md'].",
                        },
                    },
                    required: ["paths"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const rawPaths = args["paths"] as string[];

            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return { success: false, type: "text", content: "paths must be a non-empty array of file paths." };
            }
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

                if (!cache) {
                    results.push({ path, frontmatter: null, headings: [], tags: [], links: [] });
                    continue;
                }

                const headings = (cache.headings ?? []).map((h) => ({
                    level: h.level,
                    heading: h.heading,
                    line: h.position.start.line + 1, // Convert 0-based to 1-based
                }));

                const tags = (cache.tags ?? []).map((t) => t.tag);

                const links = (cache.links ?? []).map((l) => ({
                    link: l.link,
                    displayText: l.displayText,
                }));

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
                    tags,
                    links,
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
                    "Get the state information (creation time, modification time, size) for a file. " +
                    "Use this when the user asks about when a file was created, modified, last edited, " +
                    "or its size/file size. Time is represented as a Unix timestamp in milliseconds.",
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
                        isFolder: false,
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
                    isFolder,
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
                    "Resolve a wikilink reference to its full vault path. " +
                    "IMPORTANT: Only use this tool when the reference does NOT contain a path separator (/). " +
                    "For example, use this for 'MyNote' but NOT for 'Notes/MyNote.md' (which already has a path). " +
                    "When the reference contains '/', resolve it directly from the path structure without using this tool. " +
                    "For short links (filename-only), searches the entire vault for a unique match. " +
                    "If a file and folder share the same name, the file takes priority.",
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
                    resolvedPath: resolved.path,
                    isFolder: resolved.isFolder,
                    isShortLink: resolved.isShortLink,
                },
            };
        },
    };
}
