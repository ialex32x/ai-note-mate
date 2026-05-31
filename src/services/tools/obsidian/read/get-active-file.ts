import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import {
    buildLargeFilePreviewNotice,
    isMediaFile,
    isNonMediaBinaryFile,
    isWholeFileReadAvailable,
    LARGE_FILE_LINE_THRESHOLD,
    PREVIEW_LINE_COUNT,
} from "../_shared";

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
                    `its content. When \`include_content\` is true and the file is large (> ${LARGE_FILE_LINE_THRESHOLD} lines), ` +
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

                    if (isWholeFileReadAvailable(totalLines)) {
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
