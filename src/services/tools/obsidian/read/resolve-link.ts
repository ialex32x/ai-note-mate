import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { resolveFileRef } from "../../../../utils/workspace-utils";

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
