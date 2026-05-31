import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { inspectCanvasContent, loadCanvasFromVault, makePathResolver } from "./_canvas-io";
import { parseCanvasContent } from "./canvas-schema";
import type { CanvasNode, CanvasEdge } from "./canvas-schema";

export function vaultReadCanvas(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "read_canvas",
                description:
                    "Inspect an Obsidian Canvas file (`.canvas`, JSON Canvas 1.0) WITHOUT returning full JSON. " +
                    "Returns node/edge counts, type breakdown, referenced vault files, group nodes (id + label), " +
                    "bounding box, and validation issues — enough to understand structure at a glance. " +
                    "For node ids call `list_canvas_nodes`; for full node detail call `read_canvas_node`; " +
                    "for edge ids call `list_canvas_edges`. " +
                    "For full raw JSON use `read_file`; for mutations use `create_canvas`, `write_canvas`, " +
                    "`add_canvas_nodes`, `add_canvas_edges`, `update_canvas_nodes`, `update_canvas_edges`, " +
                    "`delete_canvas_nodes`, `delete_canvas_edges`, or `layout_canvas_grid` — " +
                    "do NOT use `replace_text` on `.canvas` files.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to a .canvas file, e.g. 'Boards/Overview.canvas'.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const loaded = await loadCanvasFromVault(plugin.app, path);
            if (!loaded.ok) return loaded.result;

            const resolvePath = makePathResolver(plugin.app);
            // Always summary-only — no node_ids/edge_ids
            const inspection = inspectCanvasContent(loaded.content, resolvePath, false, false);

            return {
                success: true,
                type: "object",
                content: {
                    path,
                    mtime: loaded.mtime,
                    valid: inspection.valid,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
    };
}

export function vaultListCanvasNodes(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "list_canvas_nodes",
                description:
                    "List all nodes in a `.canvas` file with id, type, and key attributes. " +
                    "Use to discover node ids before calling `update_canvas_nodes`, `delete_canvas_nodes`, " +
                    "`add_canvas_edges`, or `layout_canvas_grid`. " +
                    "Call AFTER `read_canvas` when you need to reference specific nodes.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to a .canvas file.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const loaded = await loadCanvasFromVault(plugin.app, path);
            if (!loaded.ok) return loaded.result;

            const parsed = parseCanvasContent(loaded.content);
            const nodes: CanvasNode[] = parsed.ok ? (parsed.data.nodes ?? []) : [];

            const items = nodes.map((n) => {
                const item: Record<string, unknown> = { id: n.id, type: n.type };
                if (typeof n.label === "string" && n.label.length > 0) item.label = n.label;
                if (typeof n.text === "string" && n.text.length > 0) {
                    item.text_preview = n.text.length > 120 ? n.text.slice(0, 117) + "..." : n.text;
                }
                if (typeof n.file === "string" && n.file.length > 0) item.file = n.file;
                if (typeof n.url === "string" && n.url.length > 0) item.url = n.url;
                return item;
            });

            return {
                success: true,
                type: "object",
                content: {
                    path,
                    node_count: nodes.length,
                    nodes: items,
                },
            };
        },
    };
}

export function vaultReadCanvasNode(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "read_canvas_node",
                description:
                    "Read the FULL data of a single canvas node by id — including text, position, size, " +
                    "color, file/url, subpath, label, background, and backgroundStyle. " +
                    "Use BEFORE `update_canvas_nodes` when you need to know current values to make " +
                    "informed edits (e.g. appending to existing text, adjusting position relatively). " +
                    "Get the `node_id` from `list_canvas_nodes` first.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to a .canvas file.",
                        },
                        node_id: {
                            type: "string",
                            description: "The id of the node to read.",
                        },
                    },
                    required: ["path", "node_id"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const nodeId = args["node_id"] as string;

            if (typeof nodeId !== "string" || nodeId.length === 0) {
                return { success: false, type: "text", content: "`node_id` must be a non-empty string." };
            }

            const loaded = await loadCanvasFromVault(plugin.app, path);
            if (!loaded.ok) return loaded.result;

            const parsed = parseCanvasContent(loaded.content);
            const nodes: CanvasNode[] = parsed.ok ? (parsed.data.nodes ?? []) : [];
            const node = nodes.find((n) => n.id === nodeId);
            if (!node) {
                return {
                    success: false,
                    type: "text",
                    content: `Node '${nodeId}' not found in canvas. Use list_canvas_nodes to list ids.`,
                };
            }

            const detail: Record<string, unknown> = {
                id: node.id,
                type: node.type,
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
            };
            for (const key of ["text", "file", "subpath", "url", "label", "color", "background", "backgroundStyle"] as const) {
                if (typeof node[key] === "string") detail[key] = node[key];
            }

            return {
                success: true,
                type: "object",
                content: { path, node: detail },
            };
        },
    };
}

export function vaultListCanvasEdges(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "list_canvas_edges",
                description:
                    "List all edges in a `.canvas` file with id, fromNode, toNode, and styling fields " +
                    "(label, color, fromSide, toSide, fromEnd, toEnd). " +
                    "Use to discover edge ids before calling `update_canvas_edges` or `delete_canvas_edges`. " +
                    "Call AFTER `read_canvas` when you need to reference specific edges.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to a .canvas file.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const path = args["path"] as string;
            const loaded = await loadCanvasFromVault(plugin.app, path);
            if (!loaded.ok) return loaded.result;

            const parsed = parseCanvasContent(loaded.content);
            const edges: CanvasEdge[] = parsed.ok ? (parsed.data.edges ?? []) : [];

            const items = edges.map((e) => {
                const item: Record<string, unknown> = { id: e.id, fromNode: e.fromNode, toNode: e.toNode };
                for (const key of ["label", "color", "fromSide", "toSide", "fromEnd", "toEnd"] as const) {
                    const value = e[key];
                    if (typeof value === "string" && value.length > 0) item[key] = value;
                }
                return item;
            });

            return {
                success: true,
                type: "object",
                content: {
                    path,
                    edge_count: edges.length,
                    edges: items,
                },
            };
        },
    };
}
