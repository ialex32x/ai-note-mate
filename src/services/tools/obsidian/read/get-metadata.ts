import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import {
    isFailure,
    LARGE_FILE_LINE_THRESHOLD,
    largeFileReadHints,
    normalizeVaultPathsArg,
    requireFile,
} from "../_shared";

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
                    "Get parsed frontmatter, structural info (headings / tags / total_lines), and basic file " +
                    "state (mtime / ctime / size) for one or more vault files — without reading the full " +
                    "content. Accepts any file extension; headings, tags, and frontmatter are populated from " +
                    "Obsidian's metadata cache and are most meaningful for markdown (`.md`) notes — for other " +
                    "types you still get total_lines plus timestamps/size. Headings' `line` values and `total_lines` use 1-based physical line numbers; " +
                    "leading blank lines count. When total_lines exceeds " +
                    `${LARGE_FILE_LINE_THRESHOLD}, \`whole_file_read_available\` is false and ` +
                    "`read_guidance` explains how to read targeted slices — plan read_section / grep_file / " +
                    "ranged read_file before attempting a whole-file read. For outgoing links use `get_outgoing_links` (resolved target paths " +
                    "with occurrence counts); for incoming links use `get_backlinks`. " +
                    "Primary inspector for notes: use this (not `get_file_state`) when you need " +
                    "structure or batch inspection. For a single file where you only need timestamps/size " +
                    "with no structure, use `get_file_state` instead. REQUIRED argument shape: " +
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
                                "JSON array of vault-relative file paths (1–200). Single file: " +
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

                const fileContent = await plugin.app.vault.cachedRead(file);
                const totalLines = fileContent.split("\n").length;

                if (!cache) {
                    results.push({
                        path,
                        frontmatter: null,
                        headings: [],
                        total_headings: 0,
                        tags: [],
                        total_tags: 0,
                        total_lines: totalLines,
                        mtime: stat.mtime,
                        ctime: stat.ctime,
                        size: stat.size,
                        ...largeFileReadHints(totalLines),
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
                    total_lines: totalLines,
                    mtime: stat.mtime,
                    ctime: stat.ctime,
                    size: stat.size,
                    ...largeFileReadHints(totalLines),
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
