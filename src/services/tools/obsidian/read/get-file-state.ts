import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";

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
