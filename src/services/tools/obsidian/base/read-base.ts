import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { inspectBaseContent, loadBaseFromVault } from "./_base-io";

export function vaultReadBase(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "read_base",
                description:
                    "Inspect an Obsidian Bases file (`.base`, YAML) without returning the full source. " +
                    "Returns view list (name, type, columns), formula names, configured properties, whether " +
                    "global filters exist, and validation issues (including deprecated snake_case function warnings). " +
                    "Use BEFORE editing a base. For full raw YAML use `read_file`; for mutations use " +
                    "`create_base`, `write_base`, `add_base_view`, `update_base_filters`, or `update_base_view_order` — " +
                    "do NOT use `replace_text` on `.base` files.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to a .base file, e.g. 'Bases/Orphans.base'.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const loaded = await loadBaseFromVault(plugin.app, path);
            if (!loaded.ok) return loaded.result;

            const inspection = inspectBaseContent(loaded.content);

            return {
                success: true,
                type: "object",
                content: {
                    path,
                    mtime: loaded.mtime,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
    };
}
