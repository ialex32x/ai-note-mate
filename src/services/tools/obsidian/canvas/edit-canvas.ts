import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";
import {
    addEdgesToCanvas,
    addNodesToCanvas,
    DEFAULT_LAYOUT_GAP,
    hasCanvasErrors,
    layoutCanvasGrid,
    normalizeNewEdge,
    normalizeNewNode,
    parseCanvasContent,
    removeEdgesFromCanvas,
    removeNodesFromCanvas,
    serializeCanvas,
    updateEdgesInCanvas,
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
                                "link nodes need `url`. Optional: id, x, y, width, height, text, label, subpath, color, " +
                                "background, backgroundStyle (group nodes only: cover|ratio|repeat).",
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
                    valid: inspection.valid,
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
                    action: dryRun ? "dry_run_add_canvas_edges" : "canvas_edges_added",
                    path,
                    added_edge_ids: newEdges.map((e) => e.id),
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    valid: inspection.valid,
                    validation_issues: inspection.validation_issues,
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
                            description: "Pixel gap between grid cells. Defaults to 120.",
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
            const gap = Math.max(0, (args["gap"] as number) ?? DEFAULT_LAYOUT_GAP);
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
                    valid: inspection.valid,
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
                    "changed — omitted fields are left alone. Use `list_canvas_nodes` first " +
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
                                    background: { type: "string", description: "Background image path (group nodes only)." },
                                    backgroundStyle: { type: "string", description: "cover, ratio, or repeat (group nodes)." },
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
                "background", "backgroundStyle",
            ]);
            const stringKeys = new Set(["text", "file", "url", "label", "color", "subpath", "background", "backgroundStyle"]);
            const updatedIds: string[] = [];

            for (let i = 0; i < rawPatches.length; i++) {
                const patch = rawPatches[i] as Record<string, unknown>;
                const nodeId = patch["id"];
                if (typeof nodeId !== "string" || nodeId.length === 0) {
                    return { success: false, type: "text", content: `nodes[${i}].id must be a non-empty string.` };
                }
                const existing = nodeById.get(nodeId);
                if (!existing) {
                    return { success: false, type: "text", content: `Node id '${nodeId}' not found in canvas. Use list_canvas_nodes to list ids.` };
                }
                const merged = { ...existing };
                for (const key of updatableKeys) {
                    const v = patch[key];
                    if (v !== undefined) {
                        if (stringKeys.has(key)) {
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
                    valid: inspection.valid,
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
                    "are automatically removed to keep the canvas valid. Use `list_canvas_nodes` " +
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
                    valid: inspection.valid,
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
                    "Use `list_canvas_edges` to discover edge ids, or `read_file` for full JSON.",
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
                    valid: inspection.valid,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}

export function vaultUpdateCanvasEdges(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "update_canvas_edges",
                description:
                    "Update fields of existing edges in a `.canvas` file by id. Only the provided fields are " +
                    "changed — omitted fields are left alone. Use `list_canvas_edges` first " +
                    "to discover edge ids and current values. Does NOT add or delete edges.",
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
                                "Patches to apply. Each entry needs `id` and any fields to update: " +
                                "label, color, fromSide, toSide, fromEnd, toEnd. " +
                                "Omitted fields are left unchanged.",
                            items: {
                                type: "object",
                                properties: {
                                    id: { type: "string", description: "Edge id to update." },
                                    label: { type: "string" },
                                    color: { type: "string" },
                                    fromSide: { type: "string", description: "top, right, bottom, or left." },
                                    toSide: { type: "string", description: "top, right, bottom, or left." },
                                    fromEnd: { type: "string", description: "none or arrow." },
                                    toEnd: { type: "string", description: "none or arrow." },
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
                    required: ["path", "edges"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawPatches = args["edges"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            const canvasExt = requireCanvasExtension(path);
            if (!canvasExt.ok) {
                return { success: false, type: "text", content: canvasExt.message };
            }
            if (!Array.isArray(rawPatches) || rawPatches.length === 0) {
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
                    content: `\`expected_pre_edit_mtime\` mismatch: expected ${expectedPreEditMtime}, actual ${previousMtime}.`,
                };
            }

            const content = await plugin.app.vault.read(file);
            const parsed = parseCanvasContent(content);
            if (!parsed.ok) {
                return { success: false, type: "text", content: parsed.error };
            }

            const existingIds = new Set((parsed.data.edges ?? []).map((e) => e.id));
            const patches = rawPatches as Array<{ id: string } & Record<string, unknown>>;
            const missing = patches.filter((p) => !existingIds.has(p.id)).map((p) => p.id);
            if (missing.length > 0) {
                return {
                    success: false,
                    type: "text",
                    content: `Edge ids not found: ${missing.join(", ")}. Use list_canvas_edges to list ids.`,
                };
            }

            const result = updateEdgesInCanvas(parsed.data, patches as Parameters<typeof updateEdgesInCanvas>[1]);

            const issues = validateCanvas(result.data, makePathResolver(plugin.app));
            if (hasCanvasErrors(issues)) {
                const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
                return {
                    success: false,
                    type: "text",
                    content: "Merged canvas validation failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
                };
            }

            const serialized = serializeCanvas(result.data);
            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "update_canvas_edges",
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
                    action: dryRun ? "dry_run_update_canvas_edges" : "canvas_edges_updated",
                    path,
                    updated_edge_ids: result.updated_ids,
                    previous_mtime: previousMtime,
                    new_mtime: dryRun ? previousMtime : file.stat.mtime,
                    dry_run: dryRun,
                    valid: inspection.valid,
                    validation_issues: inspection.validation_issues,
                    ...inspection.summary,
                },
            };
        },
        requiresConfirmation: true,
    };
}
