import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";
import {
    addEdgesToCanvas,
    addNodesToCanvas,
    autoLayoutCanvas,
    hasCanvasErrors,
    layoutCanvasGrid,
    normalizeNewEdge,
    normalizeNewNode,
    parseCanvasContent,
    removeEdgesFromCanvas,
    removeNodesFromCanvas,
    serializeCanvas,
    validateCanvas,
    type CanvasEdge,
    type CanvasNode,
} from "./canvas-schema";
import { inspectCanvasContent, makePathResolver, requireCanvasExtension } from "./_canvas-io";

export function vaultAddCanvasNodes(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "add_canvas_nodes",
                description:
                    "Add one or more nodes to an existing `.canvas` file. Missing `id` values are generated; " +
                    "missing `x`/`y`/`width`/`height` get sensible defaults (grid below existing content). " +
                    "The merged document is validated before writing. Use `read_canvas` first to inspect layout.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        nodes: {
                            type: "array",
                            minItems: 1,
                            description:
                                "Nodes to append. Each needs `type` (text|file|link|group). File nodes need `file`; " +
                                "link nodes need `url`. Optional: id, x, y, width, height, text, label, subpath, color.",
                            items: { type: "object" },
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate and preview without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "nodes"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawNodes = args["nodes"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
                return { success: false, type: "text", content: "`nodes` must be a non-empty array." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const existing = parsed.data.nodes ?? [];
            const usedIds = new Set(existing.map((n) => n.id));
            const newNodes: CanvasNode[] = [];

            for (let i = 0; i < rawNodes.length; i++) {
                const result = normalizeNewNode(rawNodes[i], i, [...existing, ...newNodes], usedIds);
                if (typeof result === "string") {
                    return { success: false, type: "text", content: result };
                }
                newNodes.push(result);
            }

            const merged = addNodesToCanvas(parsed.data, newNodes);
            const issues = validateCanvas(merged, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content: "Merged canvas validation failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const serialized = serializeCanvas(merged);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "add_canvas_nodes",
                    perform: async () => {
                        await plugin.app.vault.modify(file, serialized);
                    },
                });
                if (lockErr) return lockErr;
            }

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_add_canvas_nodes" : "canvas_nodes_added",
                    path,
                    added_node_ids: newNodes.map((n) => n.id),
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultAddCanvasEdges(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "add_canvas_edges",
                description:
                    "Add one or more edges to an existing `.canvas` file. Missing `id` values are generated. " +
                    "`fromNode` and `toNode` must reference existing node ids. Validated before writing.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        edges: {
                            type: "array",
                            minItems: 1,
                            description:
                                "Edges to append. Each needs `fromNode` and `toNode`. Optional: id, fromSide, " +
                                "toSide, fromEnd, toEnd, label, color.",
                            items: { type: "object" },
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate and preview without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "edges"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawEdges = args["edges"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            if (!Array.isArray(rawEdges) || rawEdges.length === 0) {
                return { success: false, type: "text", content: "`edges` must be a non-empty array." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const usedIds = new Set((parsed.data.edges ?? []).map((e) => e.id));
            const newEdges: CanvasEdge[] = [];

            for (let i = 0; i < rawEdges.length; i++) {
                const result = normalizeNewEdge(rawEdges[i], i, usedIds);
                if (typeof result === "string") {
                    return { success: false, type: "text", content: result };
                }
                newEdges.push(result);
            }

            const merged = addEdgesToCanvas(parsed.data, newEdges);
            const issues = validateCanvas(merged, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content: "Merged canvas validation failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const serialized = serializeCanvas(merged);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "add_canvas_edges",
                    perform: async () => {
                        await plugin.app.vault.modify(file, serialized);
                    },
                });
                if (lockErr) return lockErr;
            }

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultLayoutCanvasGrid(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "layout_canvas_grid",
                description:
                    "Reposition existing nodes in a `.canvas` file on a uniform grid without changing node " +
                    "content or size. Opt-in layout tool — call explicitly when the user wants cards de-overlapped " +
                    "or neatly arranged. Scope: all non-group nodes (default), specific `node_ids`, or nodes whose " +
                    "center falls inside `group_id`. Does not create or delete nodes/edges.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        columns: {
                            type: "number",
                            description: "Grid column count. Defaults to 3.",
                        },
                        gap: {
                            type: "number",
                            description: "Pixel gap between grid cells. Defaults to 80.",
                        },
                        origin_x: {
                            type: "number",
                            description: "Top-left X origin of the grid. Defaults to 0.",
                        },
                        origin_y: {
                            type: "number",
                            description: "Top-left Y origin of the grid. Defaults to 0.",
                        },
                        node_ids: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "When set, only these node ids are repositioned (mutually exclusive with group_id).",
                        },
                        group_id: {
                            type: "string",
                            description:
                                "When set, reposition non-group nodes whose center lies inside this group node " +
                                "(mutually exclusive with node_ids).",
                        },
                        include_group_nodes: {
                            type: "boolean",
                            description:
                                "When laying out all nodes (no node_ids/group_id), also reposition group-type nodes. " +
                                "Defaults to false.",
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, preview layout without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const columns = Math.max(1, (args["columns"] as number) ?? 3);
            const gap = Math.max(0, (args["gap"] as number) ?? 80);
            const originX = (args["origin_x"] as number) ?? 0;
            const originY = (args["origin_y"] as number) ?? 0;
            const rawNodeIds = args["node_ids"] as string[] | undefined;
            const groupId = args["group_id"] as string | undefined;
            const includeGroupNodes = (args["include_group_nodes"] as boolean) ?? false;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            if (rawNodeIds !== undefined && groupId !== undefined) {
                return {
                    success: false,
                    type: "text",
                    content: "Provide either `node_ids` or `group_id`, not both.",
                };
            }
            if (rawNodeIds !== undefined && (!Array.isArray(rawNodeIds) || rawNodeIds.length === 0)) {
                return { success: false, type: "text", content: "`node_ids` must be a non-empty array when provided." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const layoutResult = layoutCanvasGrid(parsed.data, {
                columns,
                gap,
                originX,
                originY,
                nodeIds: rawNodeIds ? new Set(rawNodeIds) : undefined,
                groupId,
                includeGroupNodes,
            });
            if (typeof layoutResult === "string") {
                return { success: false, type: "text", content: layoutResult };
            }

            const issues = validateCanvas(layoutResult.data, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content: "Layout produced invalid canvas:\n" + messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const serialized = serializeCanvas(layoutResult.data);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "layout_canvas_grid",
                    perform: async () => {
                        await plugin.app.vault.modify(file, serialized);
                    },
                });
                if (lockErr) return lockErr;
            }

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_layout_canvas_grid" : "canvas_grid_layout_applied",
                    path,
                    laid_out_node_ids: layoutResult.laid_out_ids,
                    columns,
                    gap,
                    origin_x: originX,
                    origin_y: originY,
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultUpdateCanvasNodes(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "update_canvas_nodes",
                description:
                    "Update fields of existing nodes in a `.canvas` file by id. Only the provided fields are " +
                    "changed — omitted fields are left alone. Use `read_canvas` with `include_node_ids: true` first " +
                    "to discover node ids and current values. Does NOT add or delete nodes.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        nodes: {
                            type: "array",
                            minItems: 1,
                            description:
                                "Patches to apply. Each entry needs `id` and any fields to update: " +
                                "text, file, url, label, color, x, y, width, height, subpath. " +
                                "Omitted fields are left unchanged.",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string", description: "Node id to update." },
                                    text: { type: "string" },
                                    file: { type: "string" },
                                    url: { type: "string" },
                                    label: { type: "string" },
                                    color: { type: "string" },
                                    x: { type: "number" },
                                    y: { type: "number" },
                                    width: { type: "number" },
                                    height: { type: "number" },
                                    subpath: { type: "string" },
                                },
                                required: ["id"],
                            },
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate and preview without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "nodes"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawPatches = args["nodes"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            if (!Array.isArray(rawPatches) || rawPatches.length === 0) {
                return { success: false, type: "text", content: "`nodes` must be a non-empty array." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content: `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const nodes = [...(parsed.data.nodes ?? [])];
            const nodeById = new Map(nodes.map((n) => [n.id, n]));
            const updatableKeys = new Set([
                "text", "file", "url", "label", "color", "x", "y", "width", "height", "subpath",
            ]);
            const updatedIds: string[] = [];

            for (let i = 0; i < rawPatches.length; i++) {
                const patch = rawPatches[i] as Record<string, unknown>;
                const nodeId = patch["id"];
                if (typeof nodeId !== "string" || nodeId.length === 0) {
                    return { success: false, type: "text", content: `nodes[${i}].id must be a non-empty string.` };
                }
                const existing = nodeById.get(nodeId);
                if (!existing) {
                    return { success: false, type: "text", content: `Node id '${nodeId}' not found in canvas. Use read_canvas with include_node_ids: true to list ids.` };
                }
                const merged = { ...existing };
                for (const key of updatableKeys) {
                    const v = patch[key];
                    if (v !== undefined) {
                        if (key === "text" || key === "file" || key === "url" || key === "label" || key === "color" || key === "subpath") {
                            if (typeof v === "string") (merged as Record<string, unknown>)[key] = v;
                        } else {
                            if (typeof v === "number" && Number.isFinite(v)) (merged as Record<string, unknown>)[key] = v;
                        }
                    }
                }
                nodeById.set(nodeId, merged);
                updatedIds.push(nodeId);
            }

            const updatedNodes = nodes.map((n) => nodeById.get(n.id) ?? n);
            const merged = { ...parsed.data, nodes: updatedNodes };

            const issues = validateCanvas(merged, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content: "Merged canvas validation failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const serialized = serializeCanvas(merged);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "update_canvas_nodes",
                    perform: async () => {
                        await plugin.app.vault.modify(file, serialized);
                    },
                });
                if (lockErr) return lockErr;
            }

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_update_canvas_nodes" : "canvas_nodes_updated",
                    path,
                    updated_node_ids: updatedIds,
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultDeleteCanvasNodes(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "delete_canvas_nodes",
                description:
                    "Delete one or more nodes from a `.canvas` file by id. Edges connected to deleted nodes " +
                    "are automatically removed to keep the canvas valid. Use `read_canvas` with `include_node_ids: true` " +
                    "first to discover node ids.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        node_ids: {
                            type: "array",
                            minItems: 1,
                            items: { type: "string" },
                            description: "Node ids to remove.",
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate and preview without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "node_ids"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawNodeIds = args["node_ids"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            if (!Array.isArray(rawNodeIds) || rawNodeIds.length === 0) {
                return { success: false, type: "text", content: "`node_ids` must be a non-empty array." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content: `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const existingIds = new Set((parsed.data.nodes ?? []).map((n) => n.id));
            const toRemove = new Set(rawNodeIds as string[]);
            const missing = [...toRemove].filter((id) => !existingIds.has(id));
            if (missing.length > 0) {
                return {
                    success: false,
                    type: "text",
                    content: `Node ids not found: ${missing.join(", ")}.`,
                };
            }

            const merged = removeNodesFromCanvas(parsed.data, toRemove);
            const issues = validateCanvas(merged, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content: "Canvas validation after removal failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const removedEdgesCount =
                (parsed.data.edges ?? []).length - (merged.edges ?? []).length;

            const serialized = serializeCanvas(merged);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "delete_canvas_nodes",
                    perform: async () => {
                        await plugin.app.vault.modify(file, serialized);
                    },
                });
                if (lockErr) return lockErr;
            }

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_delete_canvas_nodes" : "canvas_nodes_deleted",
                    path,
                    removed_node_ids: [...toRemove],
                    auto_removed_edge_count: removedEdgesCount,
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultDeleteCanvasEdges(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "delete_canvas_edges",
                description:
                    "Delete one or more edges from a `.canvas` file by id. Does NOT affect nodes. " +
                    "Use `read_canvas` or `read_file` to find edge ids.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        edge_ids: {
                            type: "array",
                            minItems: 1,
                            items: { type: "string" },
                            description: "Edge ids to remove.",
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate and preview without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "edge_ids"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawEdgeIds = args["edge_ids"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            if (!Array.isArray(rawEdgeIds) || rawEdgeIds.length === 0) {
                return { success: false, type: "text", content: "`edge_ids` must be a non-empty array." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content: `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const existingIds = new Set((parsed.data.edges ?? []).map((e) => e.id));
            const toRemove = new Set(rawEdgeIds as string[]);
            const missing = [...toRemove].filter((id) => !existingIds.has(id));
            if (missing.length > 0) {
                return {
                    success: false,
                    type: "text",
                    content: `Edge ids not found: ${missing.join(", ")}.`,
                };
            }

            const merged = removeEdgesFromCanvas(parsed.data, toRemove);
            const issues = validateCanvas(merged, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content: "Canvas validation after removal failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const serialized = serializeCanvas(merged);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "delete_canvas_edges",
                    perform: async () => {
                        await plugin.app.vault.modify(file, serialized);
                    },
                });
                if (lockErr) return lockErr;
            }

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_delete_canvas_edges" : "canvas_edges_deleted",
                    path,
                    removed_edge_ids: [...toRemove],
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultAutoLayoutCanvas(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "auto_layout_canvas",
                description:
                    "Smart auto-layout for a `.canvas` file that handles groups and hierarchy. Children inside " +
                    "each group node are laid out on a local grid and the group is expanded to fit them. " +
                    "Top-level groups and orphan nodes are then arranged on an outer grid. Use after adding, " +
                    "updating, or deleting nodes to keep the canvas neatly organized.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .canvas file.",
                        },
                        columns: {
                            type: "number",
                            description: "Grid column count for top-level layout. Defaults to 3.",
                        },
                        gap: {
                            type: "number",
                            description: "Pixel gap between grid cells. Defaults to 120.",
                        },
                        group_label_offset: {
                            type: "number",
                            description:
                                "Vertical space reserved for a group label above its children. Defaults to 40.",
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, preview layout without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const columns = Math.max(1, (args["columns"] as number) ?? 3);
            const gap = Math.max(0, (args["gap"] as number) ?? 120);
            const groupLabelOffset = (args["group_label_offset"] as number) ?? 40;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (expectedPreEditMtime !== undefined && expectedPreEditMtime !== previousMtime) {
                return {
                    success: false,
                    type: "text",
                    content: `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const layoutResult = autoLayoutCanvas(parsed.data, { columns, gap, groupLabelOffset });
            const issues = validateCanvas(layoutResult, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content:
                        "Auto-layout produced invalid canvas:\n" +
                        messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const serialized = serializeCanvas(layoutResult);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "auto_layout_canvas",
                    perform: async () => {
                        await plugin.app.vault.modify(file, serialized);
                    },
                });
                if (lockErr) return lockErr;
            }

            const inspection = inspectCanvasContent(serialized, makePathResolver(plugin.app));
            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_auto_layout_canvas" : "canvas_auto_layout_applied",
                    path,
                    columns,
                    gap,
                    group_label_offset: groupLabelOffset,
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    parse_ok: inspection.parse_ok,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}
