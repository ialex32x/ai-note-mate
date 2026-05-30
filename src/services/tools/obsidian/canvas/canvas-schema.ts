/**
 * JSON Canvas 1.0 helpers — parse, validate, summarize, and patch `.canvas` files.
 * Spec: https://jsoncanvas.org/spec/1.0/
 */

export const CANVAS_NODE_TYPES = ["text", "file", "link", "group"] as const;
export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

export interface CanvasValidationIssue {
    severity: "error" | "warning";
    message: string;
}

export interface CanvasNode {
    id: string;
    type: CanvasNodeType;
    x: number;
    y: number;
    width: number;
    height: number;
    text?: string;
    file?: string;
    subpath?: string;
    url?: string;
    label?: string;
    color?: string;
    [key: string]: unknown;
}

export interface CanvasEdge {
    id: string;
    fromNode: string;
    toNode: string;
    fromSide?: string;
    toSide?: string;
    fromEnd?: string;
    toEnd?: string;
    label?: string;
    color?: string;
    [key: string]: unknown;
}

export interface CanvasData {
    nodes?: CanvasNode[];
    edges?: CanvasEdge[];
    [key: string]: unknown;
}

export interface CanvasSummary {
    node_count: number;
    edge_count: number;
    nodes_by_type: Record<string, number>;
    referenced_files: string[];
    groups: Array<{ id: string; label: string | null; child_hint: string | null }>;
    bounds: { min_x: number; min_y: number; max_x: number; max_y: number } | null;
}

const EDGE_SIDES = new Set(["top", "right", "bottom", "left"]);
const EDGE_ENDS = new Set(["none", "arrow"]);

const DEFAULT_DIMENSIONS: Record<CanvasNodeType, { width: number; height: number }> = {
    text: { width: 400, height: 200 },
    file: { width: 400, height: 400 },
    link: { width: 400, height: 200 },
    group: { width: 600, height: 400 },
};

/** Default spacing when auto-arranging or suggesting node positions. */
export const DEFAULT_LAYOUT_GAP = 120;
export const DEFAULT_LAYOUT_COLUMNS = 3;

export function generateCanvasId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseCanvasContent(
    content: unknown,
): { ok: true; data: CanvasData } | { ok: false; error: string } {
    if (content !== null && typeof content === "object" && !Array.isArray(content)) {
        return { ok: true, data: content as CanvasData };
    }
    if (typeof content !== "string") {
        return {
            ok: false,
            error: "Canvas content must be a JSON string or object with nodes/edges arrays.",
        };
    }
    const trimmed = content.trim();
    if (trimmed.length === 0) {
        return { ok: true, data: { nodes: [], edges: [] } };
    }
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return { ok: false, error: "Canvas root must be a JSON object with nodes/edges arrays." };
        }
        return { ok: true, data: parsed as CanvasData };
    } catch (err) {
        return {
            ok: false,
            error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

export function serializeCanvas(data: CanvasData): string {
    return JSON.stringify(data, null, "\t");
}

function isCanvasNodeType(value: unknown): value is CanvasNodeType {
    return typeof value === "string" && (CANVAS_NODE_TYPES as readonly string[]).includes(value);
}

export function validateCanvas(
    data: CanvasData,
    resolvePath?: (vaultRelativePath: string) => boolean,
): CanvasValidationIssue[] {
    const issues: CanvasValidationIssue[] = [];
    const nodes = data.nodes;
    const edges = data.edges;

    if (nodes !== undefined && !Array.isArray(nodes)) {
        issues.push({ severity: "error", message: "`nodes` must be an array when present." });
        return issues;
    }
    if (edges !== undefined && !Array.isArray(edges)) {
        issues.push({ severity: "error", message: "`edges` must be an array when present." });
        return issues;
    }

    const nodeList: unknown[] = nodes ?? [];
    const edgeList: unknown[] = edges ?? [];
    const nodeIds = new Set<string>();

    for (let i = 0; i < nodeList.length; i++) {
        const n = nodeList[i];
        const prefix = `nodes[${i}]`;
        if (!n || typeof n !== "object" || Array.isArray(n)) {
            issues.push({ severity: "error", message: `${prefix} must be an object.` });
            continue;
        }
        const node = n as Record<string, unknown>;
        const nodeId = node["id"];
        if (typeof nodeId !== "string" || nodeId.length === 0) {
            issues.push({ severity: "error", message: `${prefix}.id must be a non-empty string.` });
        } else if (nodeIds.has(nodeId)) {
            issues.push({ severity: "error", message: `Duplicate node id '${nodeId}'.` });
        } else {
            nodeIds.add(nodeId);
        }
        const nodeType = node["type"];
        if (!isCanvasNodeType(nodeType)) {
            issues.push({
                severity: "error",
                message: `${prefix}.type must be one of: ${CANVAS_NODE_TYPES.join(", ")}.`,
            });
        }
        for (const key of ["x", "y", "width", "height"] as const) {
            const val = node[key];
            if (typeof val !== "number" || !Number.isFinite(val)) {
                issues.push({ severity: "error", message: `${prefix}.${key} must be a finite number.` });
            }
        }
        if (nodeType === "file") {
            const filePath = node["file"];
            if (typeof filePath !== "string" || filePath.length === 0) {
                issues.push({ severity: "error", message: `${prefix}.file is required for file nodes.` });
            } else if (resolvePath && !resolvePath(filePath)) {
                issues.push({
                    severity: "warning",
                    message: `${prefix}.file references missing vault path '${filePath}'.`,
                });
            }
        }
        if (nodeType === "link") {
            const url = node["url"];
            if (typeof url !== "string" || url.length === 0) {
                issues.push({ severity: "error", message: `${prefix}.url is required for link nodes.` });
            }
        }
    }

    const edgeIds = new Set<string>();
    for (let i = 0; i < edgeList.length; i++) {
        const e = edgeList[i];
        const prefix = `edges[${i}]`;
        if (!e || typeof e !== "object" || Array.isArray(e)) {
            issues.push({ severity: "error", message: `${prefix} must be an object.` });
            continue;
        }
        const edge = e as Record<string, unknown>;
        const edgeId = edge["id"];
        if (typeof edgeId !== "string" || edgeId.length === 0) {
            issues.push({ severity: "error", message: `${prefix}.id must be a non-empty string.` });
        } else if (edgeIds.has(edgeId)) {
            issues.push({ severity: "error", message: `Duplicate edge id '${edgeId}'.` });
        } else {
            edgeIds.add(edgeId);
        }
        const fromNode = edge["fromNode"];
        if (typeof fromNode !== "string" || fromNode.length === 0) {
            issues.push({ severity: "error", message: `${prefix}.fromNode must be a non-empty string.` });
        } else if (!nodeIds.has(fromNode)) {
            issues.push({
                severity: "error",
                message: `${prefix}.fromNode '${fromNode}' does not match any node id.`,
            });
        }
        const toNode = edge["toNode"];
        if (typeof toNode !== "string" || toNode.length === 0) {
            issues.push({ severity: "error", message: `${prefix}.toNode must be a non-empty string.` });
        } else if (!nodeIds.has(toNode)) {
            issues.push({
                severity: "error",
                message: `${prefix}.toNode '${toNode}' does not match any node id.`,
            });
        }
        for (const sideKey of ["fromSide", "toSide"] as const) {
            const side = edge[sideKey];
            if (side !== undefined && (typeof side !== "string" || !EDGE_SIDES.has(side))) {
                issues.push({
                    severity: "error",
                    message: `${prefix}.${sideKey} must be top, right, bottom, or left.`,
                });
            }
        }
        for (const endKey of ["fromEnd", "toEnd"] as const) {
            const end = edge[endKey];
            if (end !== undefined && (typeof end !== "string" || !EDGE_ENDS.has(end))) {
                issues.push({ severity: "error", message: `${prefix}.${endKey} must be none or arrow.` });
            }
        }
    }

    return issues;
}

export function hasCanvasErrors(issues: CanvasValidationIssue[]): boolean {
    return issues.some((i) => i.severity === "error");
}

export function summarizeCanvas(data: CanvasData): CanvasSummary {
    const nodes = data.nodes ?? [];
    const edges = data.edges ?? [];
    const nodesByType: Record<string, number> = {};
    const referencedFiles: string[] = [];
    const groups: CanvasSummary["groups"] = [];

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
        nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
        if (node.type === "file" && typeof node.file === "string" && node.file.length > 0) {
            referencedFiles.push(node.file);
        }
        if (node.type === "group") {
            groups.push({
                id: node.id,
                label: typeof node.label === "string" ? node.label : null,
                child_hint: typeof node.text === "string" ? node.text : null,
            });
        }
        if (Number.isFinite(node.x) && Number.isFinite(node.y) && Number.isFinite(node.width) && Number.isFinite(node.height)) {
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + node.width);
            maxY = Math.max(maxY, node.y + node.height);
        }
    }

    const bounds =
        nodes.length > 0 && Number.isFinite(minX)
            ? { min_x: minX, min_y: minY, max_x: maxX, max_y: maxY }
            : null;

    return {
        node_count: nodes.length,
        edge_count: edges.length,
        nodes_by_type: nodesByType,
        referenced_files: [...new Set(referencedFiles)].sort(),
        groups,
        bounds,
    };
}

export interface NewCanvasNodeInput {
    type: CanvasNodeType;
    id?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    text?: string;
    file?: string;
    subpath?: string;
    url?: string;
    label?: string;
    color?: string;
}

export interface NewCanvasEdgeInput {
    id?: string;
    fromNode: string;
    toNode: string;
    fromSide?: string;
    toSide?: string;
    fromEnd?: string;
    toEnd?: string;
    label?: string;
    color?: string;
}

function suggestNodePosition(existing: CanvasNode[], index: number): { x: number; y: number } {
    const dims = DEFAULT_DIMENSIONS.text;
    const gap = DEFAULT_LAYOUT_GAP;
    if (existing.length === 0) {
        return { x: index * (dims.width + gap), y: 0 };
    }
    let maxBottom = 0;
    for (const n of existing) {
        if (Number.isFinite(n.y) && Number.isFinite(n.height)) {
            maxBottom = Math.max(maxBottom, n.y + n.height);
        }
    }
    return { x: index * (dims.width + gap), y: maxBottom + gap };
}

export function normalizeNewNode(
    raw: unknown,
    index: number,
    existing: CanvasNode[],
    usedIds: Set<string>,
): CanvasNode | string {
    if (!raw || typeof raw !== "object") {
        return `nodes[${index}] must be an object.`;
    }
    const r = raw as Record<string, unknown>;
    const type = r["type"];
    if (!isCanvasNodeType(type)) {
        return `nodes[${index}].type must be one of: ${CANVAS_NODE_TYPES.join(", ")}.`;
    }
    const dims = DEFAULT_DIMENSIONS[type];
    let id = r["id"];
    if (id === undefined || id === null || id === "") {
        id = generateCanvasId();
    }
    if (typeof id !== "string" || id.length === 0) {
        return `nodes[${index}].id must be a non-empty string when provided.`;
    }
    while (usedIds.has(id as string)) {
        id = generateCanvasId();
    }
    usedIds.add(id as string);

    const pos =
        typeof r["x"] === "number" && typeof r["y"] === "number"
            ? { x: r["x"], y: r["y"] }
            : suggestNodePosition(existing, index);

    const node: CanvasNode = {
        id: id as string,
        type,
        x: pos.x,
        y: pos.y,
        width: typeof r["width"] === "number" ? r["width"] : dims.width,
        height: typeof r["height"] === "number" ? r["height"] : dims.height,
    };
    for (const key of ["text", "file", "subpath", "url", "label", "color"] as const) {
        const v = r[key];
        if (typeof v === "string") node[key] = v;
    }
    return node;
}

export function normalizeNewEdge(
    raw: unknown,
    index: number,
    usedIds: Set<string>,
): CanvasEdge | string {
    if (!raw || typeof raw !== "object") {
        return `edges[${index}] must be an object.`;
    }
    const r = raw as Record<string, unknown>;
    const fromNode = r["fromNode"];
    const toNode = r["toNode"];
    if (typeof fromNode !== "string" || fromNode.length === 0) {
        return `edges[${index}].fromNode must be a non-empty string.`;
    }
    if (typeof toNode !== "string" || toNode.length === 0) {
        return `edges[${index}].toNode must be a non-empty string.`;
    }
    let id = r["id"];
    if (id === undefined || id === null || id === "") {
        id = generateCanvasId();
    }
    if (typeof id !== "string" || id.length === 0) {
        return `edges[${index}].id must be a non-empty string when provided.`;
    }
    while (usedIds.has(id as string)) {
        id = generateCanvasId();
    }
    usedIds.add(id as string);

    const edge: CanvasEdge = {
        id: id as string,
        fromNode,
        toNode,
    };
    for (const key of ["fromSide", "toSide", "fromEnd", "toEnd", "label", "color"] as const) {
        const v = r[key];
        if (typeof v === "string") edge[key] = v;
    }
    if (edge.fromEnd === undefined) edge.fromEnd = "none";
    if (edge.toEnd === undefined) edge.toEnd = "arrow";
    return edge;
}

export function addNodesToCanvas(data: CanvasData, newNodes: CanvasNode[]): CanvasData {
    const nodes = [...(data.nodes ?? []), ...newNodes];
    return { ...data, nodes };
}

export function addEdgesToCanvas(data: CanvasData, newEdges: CanvasEdge[]): CanvasData {
    const edges = [...(data.edges ?? []), ...newEdges];
    return { ...data, edges };
}

export interface LayoutCanvasGridOptions {
    columns: number;
    gap: number;
    originX: number;
    originY: number;
    /** When set, only these node ids are repositioned. */
    nodeIds?: Set<string>;
    /** When set, only non-group nodes whose center lies inside this group are repositioned. */
    groupId?: string;
    /** When laying out all nodes (no nodeIds/groupId), include group-type nodes. Defaults to false. */
    includeGroupNodes: boolean;
}

export interface LayoutCanvasGridResult {
    data: CanvasData;
    laid_out_ids: string[];
}

function nodeCenterInsideGroup(node: CanvasNode, group: CanvasNode): boolean {
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    return (
        cx >= group.x &&
        cx <= group.x + group.width &&
        cy >= group.y &&
        cy <= group.y + group.height
    );
}

/**
 * Reposition selected canvas nodes on a uniform grid. Does not resize nodes.
 * Stable ordering is by node id so repeated calls are deterministic.
 */
export function layoutCanvasGrid(
    data: CanvasData,
    opts: LayoutCanvasGridOptions,
): LayoutCanvasGridResult | string {
    const allNodes = [...(data.nodes ?? [])];
    if (allNodes.length === 0) {
        return "Canvas has no nodes to layout.";
    }

    let targets: CanvasNode[];

    if (opts.groupId) {
        const group = allNodes.find((n) => n.id === opts.groupId);
        if (!group) {
            return `group_id '${opts.groupId}' not found among canvas nodes.`;
        }
        if (group.type !== "group") {
            return `Node '${opts.groupId}' is type '${group.type}', not 'group'.`;
        }
        targets = allNodes.filter(
            (n) => n.id !== group.id && nodeCenterInsideGroup(n, group),
        );
    } else if (opts.nodeIds) {
        targets = allNodes.filter((n) => opts.nodeIds!.has(n.id));
        const missing = [...opts.nodeIds].filter((id) => !targets.some((n) => n.id === id));
        if (missing.length > 0) {
            return `node_ids not found in canvas: ${missing.join(", ")}.`;
        }
    } else {
        targets = allNodes.filter((n) => opts.includeGroupNodes || n.type !== "group");
    }

    if (targets.length === 0) {
        return "No nodes matched the layout scope.";
    }

    targets.sort((a, b) => a.id.localeCompare(b.id));

    const maxW = Math.max(...targets.map((n) => n.width), 1);
    const maxH = Math.max(...targets.map((n) => n.height), 1);
    const colStride = maxW + opts.gap;
    const rowStride = maxH + opts.gap;

    const byId = new Map(allNodes.map((n) => [n.id, { ...n }]));
    const laidOutIds: string[] = [];

    for (let i = 0; i < targets.length; i++) {
        const col = i % opts.columns;
        const row = Math.floor(i / opts.columns);
        const node = byId.get(targets[i]!.id)!;
        node.x = opts.originX + col * colStride;
        node.y = opts.originY + row * rowStride;
        laidOutIds.push(node.id);
    }

    const nodes = allNodes.map((n) => byId.get(n.id)!);
    return { data: { ...data, nodes }, laid_out_ids: laidOutIds };
}

export interface AutoLayoutCanvasOptions {
    columns?: number;
    gap?: number;
    /** Vertical space reserved for a group label above its children. */
    groupLabelOffset?: number;
}

function expandGroupAroundChildren(
    data: CanvasData,
    groupId: string,
    gap: number,
    labelOffset: number,
): CanvasData {
    const nodes = [...(data.nodes ?? [])];
    const groupIdx = nodes.findIndex((n) => n.id === groupId && n.type === "group");
    if (groupIdx < 0) return data;

    const groupBefore = nodes[groupIdx]!;
    const childIndices: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        if (n.id !== groupId && n.type !== "group" && nodeCenterInsideGroup(n, groupBefore)) {
            childIndices.push(i);
        }
    }
    if (childIndices.length === 0) return data;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of childIndices) {
        const child = nodes[i]!;
        minX = Math.min(minX, child.x);
        minY = Math.min(minY, child.y);
        maxX = Math.max(maxX, child.x + child.width);
        maxY = Math.max(maxY, child.y + child.height);
    }

    const pad = gap;
    const newX = minX - pad;
    const newY = minY - labelOffset;
    const newW = maxX - minX + pad * 2;
    const newH = maxY - minY + labelOffset + pad;
    const dx = newX - groupBefore.x;
    const dy = newY - groupBefore.y;

    nodes[groupIdx] = {
        ...groupBefore,
        x: newX,
        y: newY,
        width: Math.max(groupBefore.width, newW),
        height: Math.max(groupBefore.height, newH),
    };

    if (dx !== 0 || dy !== 0) {
        for (const i of childIndices) {
            const child = nodes[i]!;
            nodes[i] = { ...child, x: child.x + dx, y: child.y + dy };
        }
    }

    return { ...data, nodes };
}

function isInsideAnyGroup(node: CanvasNode, groups: CanvasNode[]): boolean {
    return groups.some((g) => nodeCenterInsideGroup(node, g));
}

/**
 * Reposition all nodes on readable grids. Children inside group nodes are laid out
 * locally first; groups and orphan nodes are then arranged on an outer grid.
 */
export function autoLayoutCanvas(data: CanvasData, opts?: AutoLayoutCanvasOptions): CanvasData {
    const nodes = data.nodes ?? [];
    if (nodes.length === 0) return data;

    const columns = opts?.columns ?? DEFAULT_LAYOUT_COLUMNS;
    const gap = opts?.gap ?? DEFAULT_LAYOUT_GAP;
    const labelOffset = opts?.groupLabelOffset ?? 40;

    let current: CanvasData = { ...data, nodes: nodes.map((n) => ({ ...n })) };
    const groups = (current.nodes ?? [])
        .filter((n) => n.type === "group")
        .sort((a, b) => a.id.localeCompare(b.id));

    for (const group of groups) {
        const childResult = layoutCanvasGrid(current, {
            columns: Math.min(columns, 2),
            gap,
            originX: group.x + gap,
            originY: group.y + labelOffset,
            groupId: group.id,
            includeGroupNodes: false,
        });
        if (typeof childResult === "string") continue;
        current = childResult.data;
        current = expandGroupAroundChildren(current, group.id, gap, labelOffset);
    }

    const refreshedGroups = (current.nodes ?? []).filter((n) => n.type === "group");
    const topLevelIds = new Set<string>();
    for (const node of current.nodes ?? []) {
        if (node.type === "group") {
            topLevelIds.add(node.id);
        } else if (!isInsideAnyGroup(node, refreshedGroups)) {
            topLevelIds.add(node.id);
        }
    }
    if (topLevelIds.size === 0) return current;

    const outerResult = layoutCanvasGrid(current, {
        columns,
        gap,
        originX: 0,
        originY: 0,
        nodeIds: topLevelIds,
        includeGroupNodes: false,
    });
    return typeof outerResult === "string" ? current : outerResult.data;
}
