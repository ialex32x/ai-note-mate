import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { inspectCanvasContent, loadCanvasFromVault, makePathResolver } from "./_canvas-io";

export function vaultReadCanvas(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "read_canvas",
                description:
                    "Inspect an Obsidian Canvas file (`.canvas`, JSON Canvas 1.0) without returning the full JSON. " +
                    "Returns node/edge counts, type breakdown, referenced vault files, group nodes, bounding box, " +
                    "and validation issues. Use BEFORE editing a canvas to understand layout and references. " +
                    "For full raw JSON use `read_file`; for mutations use `create_canvas`, `write_canvas`, " +
                    "`add_canvas_nodes`, `add_canvas_edges`, or `layout_canvas_grid` — do NOT use `replace_text` on `.canvas` files.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to a .canvas file, e.g. 'Boards/Overview.canvas'.",
                        },
                        include_node_ids: {
                            type: "boolean",
                            description:
                                "When true, returns `node_ids` grouped by type so you can reference " +
                                "specific nodes in follow-up tools (add_canvas_edges, update_canvas_nodes, " +
                                "delete_canvas_nodes, layout_canvas_grid). Defaults to false.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const includeNodeIds = (args["include_node_ids"] as boolean) ?? false;
            const loaded = await loadCanvasFromVault(plugin.app, path);
            if (!loaded.ok) return loaded.result;

            const resolvePath = makePathResolver(plugin.app);
            const inspection = inspectCanvasContent(loaded.content, resolvePath, includeNodeIds);

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
