import { describe, it, expect } from "vitest";
import {
    parseCanvasContent,
    validateCanvas,
    summarizeCanvas,
    hasCanvasErrors,
    normalizeNewNode,
    normalizeNewEdge,
    addNodesToCanvas,
    updateEdgesInCanvas,
    serializeCanvas,
    layoutCanvasGrid,
    autoLayoutCanvas,
    DEFAULT_LAYOUT_GAP,
} from "../src/services/tools/obsidian/canvas/canvas-schema";

describe("canvas-schema", () => {
    it("parseCanvasContent accepts object body from tool calls", () => {
        const data = {
            nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 100 }],
            edges: [],
        };
        const r = parseCanvasContent(data);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.data.nodes).toHaveLength(1);
        }
    });

    it("parseCanvasContent rejects non-string non-object content", () => {
        const r = parseCanvasContent(42);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toContain("JSON string or object");
        }
    });

    it("parseCanvasContent accepts empty document", () => {
        const r = parseCanvasContent("");
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.data.nodes).toEqual([]);
            expect(r.data.edges).toEqual([]);
        }
    });

    it("validateCanvas rejects duplicate node ids", () => {
        const data = {
            nodes: [
                { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100 },
                { id: "a", type: "text", x: 200, y: 0, width: 100, height: 100 },
            ],
            edges: [],
        };
        const issues = validateCanvas(data);
        expect(hasCanvasErrors(issues)).toBe(true);
        expect(issues.some((i) => i.message.includes("Duplicate"))).toBe(true);
    });

    it("validateCanvas rejects edge to missing node", () => {
        const data = {
            nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 100 }],
            edges: [{ id: "e1", fromNode: "a", toNode: "missing" }],
        };
        const issues = validateCanvas(data);
        expect(hasCanvasErrors(issues)).toBe(true);
    });

    it("validateCanvas requires text field for text nodes", () => {
        const data = {
            nodes: [{ id: "a", type: "text" as const, x: 0, y: 0, width: 100, height: 100 }],
            edges: [],
        };
        const issues = validateCanvas(data);
        expect(hasCanvasErrors(issues)).toBe(true);
        expect(issues.some((i) => i.message.includes(".text is required"))).toBe(true);
    });

    it("validateCanvas warns on invalid color value", () => {
        const data = {
            nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 100, text: "ok", color: "invalid" }],
            edges: [],
        };
        const issues = validateCanvas(data);
        expect(hasCanvasErrors(issues)).toBe(false); // color is warning, not error
        expect(issues.some((i) => i.message.includes("color must be"))).toBe(true);
    });

    it("validateCanvas accepts valid color presets and hex", () => {
        const data = {
            nodes: [
                { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100, text: "ok", color: "4" },
                { id: "b", type: "text", x: 0, y: 0, width: 100, height: 100, text: "ok", color: "#FF0000" },
                { id: "c", type: "text", x: 0, y: 0, width: 100, height: 100, text: "ok", color: "#abc" },
            ],
            edges: [],
        };
        const issues = validateCanvas(data);
        expect(hasCanvasErrors(issues)).toBe(false);
        expect(issues.filter((i) => i.message.includes("color")).length).toBe(0);
    });

    it("validateCanvas rejects cross-collection id collision", () => {
        const data = {
            nodes: [{ id: "same_id", type: "text", x: 0, y: 0, width: 100, height: 100, text: "hi" }],
            edges: [{ id: "same_id", fromNode: "same_id", toNode: "same_id" }],
        };
        const issues = validateCanvas(data);
        expect(hasCanvasErrors(issues)).toBe(true);
        expect(issues.some((i) => i.message.includes("collides with a node id"))).toBe(true);
    });

    it("summarizeCanvas counts types and bounds", () => {
        const data = {
            nodes: [
                { id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "Hi" },
                { id: "b", type: "file", x: 200, y: 0, width: 100, height: 50, file: "Notes/A.md" },
            ],
            edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
        };
        const summary = summarizeCanvas(data);
        expect(summary.node_count).toBe(2);
        expect(summary.edge_count).toBe(1);
        expect(summary.nodes_by_type.text).toBe(1);
        expect(summary.referenced_files).toEqual(["Notes/A.md"]);
        expect(summary.bounds).toEqual({ min_x: 0, min_y: 0, max_x: 300, max_y: 50 });
    });

    it("normalizeNewNode assigns id and position", () => {
        const used = new Set<string>();
        const node = normalizeNewNode({ type: "text", text: "Hello" }, 0, [], used);
        expect(typeof node).toBe("object");
        if (typeof node === "object") {
            expect(node.type).toBe("text");
            expect(node.id.length).toBeGreaterThan(0);
            expect(node.width).toBe(400);
        }
    });

    it("addNodesToCanvas and serialize round-trip", () => {
        const base = { nodes: [], edges: [] };
        const used = new Set<string>();
        const n = normalizeNewNode({ type: "text", x: 10, y: 20 }, 0, [], used);
        expect(typeof n).toBe("object");
        if (typeof n !== "object") return;
        const merged = addNodesToCanvas(base, [n]);
        const json = serializeCanvas(merged);
        const reparsed = parseCanvasContent(json);
        expect(reparsed.ok).toBe(true);
    });

    it("layoutCanvasGrid repositions nodes on a grid", () => {
        const data = {
            nodes: [
                { id: "a", type: "text", x: 999, y: 999, width: 100, height: 50, text: "A" },
                { id: "b", type: "text", x: 888, y: 888, width: 100, height: 50, text: "B" },
            ],
            edges: [],
        };
        const result = layoutCanvasGrid(data, {
            columns: 2,
            gap: 20,
            originX: 0,
            originY: 0,
            includeGroupNodes: false,
        });
        expect(typeof result).toBe("object");
        if (typeof result === "string") return;
        expect(result.laid_out_ids).toEqual(["a", "b"]);
        const a = result.data.nodes!.find((n) => n.id === "a")!;
        const b = result.data.nodes!.find((n) => n.id === "b")!;
        expect(a.x).toBe(0);
        expect(a.y).toBe(0);
        expect(b.x).toBe(120);
        expect(b.y).toBe(0);
    });

    it("autoLayoutCanvas spreads densely packed nodes", () => {
        const data = {
            nodes: [
                { id: "a", type: "text", x: 0, y: 0, width: 400, height: 200, text: "A" },
                { id: "b", type: "text", x: 10, y: 10, width: 400, height: 200, text: "B" },
                { id: "c", type: "text", x: 20, y: 20, width: 400, height: 200, text: "C" },
            ],
            edges: [],
        };
        const laidOut = autoLayoutCanvas(data);
        const a = laidOut.nodes!.find((n) => n.id === "a")!;
        const b = laidOut.nodes!.find((n) => n.id === "b")!;
        const c = laidOut.nodes!.find((n) => n.id === "c")!;
        expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_GAP - 1);
        expect(c.x - (b.x + b.width)).toBeGreaterThanOrEqual(DEFAULT_LAYOUT_GAP - 1);
    });

    it("autoLayoutCanvas lays out group children separately from outer grid", () => {
        const data = {
            nodes: [
                { id: "g1", type: "group", x: 0, y: 0, width: 600, height: 400, label: "Group" },
                { id: "a", type: "text", x: 5, y: 5, width: 200, height: 100, text: "A" },
                { id: "b", type: "text", x: 10, y: 10, width: 200, height: 100, text: "B" },
                { id: "root", type: "text", x: 800, y: 0, width: 300, height: 150, text: "Root" },
            ],
            edges: [],
        };
        const laidOut = autoLayoutCanvas(data, { columns: 2, gap: 80 });
        const a = laidOut.nodes!.find((n) => n.id === "a")!;
        const b = laidOut.nodes!.find((n) => n.id === "b")!;
        const root = laidOut.nodes!.find((n) => n.id === "root")!;
        expect(b.x - (a.x + a.width)).toBeGreaterThanOrEqual(79);
        expect(root.y).toBeGreaterThanOrEqual(0);
    });

    it("normalizeNewNode suggests wider positions for group nodes", () => {
        const used = new Set<string>();
        const groupNode = normalizeNewNode({ type: "group", label: "G1" }, 0, [], used);
        expect(typeof groupNode).toBe("object");
        if (typeof groupNode !== "object") return;
        // Second group node should be placed beyond first group's width + gap
        const group2 = normalizeNewNode({ type: "group", label: "G2" }, 1, [groupNode], used);
        expect(typeof group2).toBe("object");
        if (typeof group2 !== "object") return;
        // Group nodes are 600px wide + 120 gap = 720, so x >= 720
        expect(group2.x).toBeGreaterThanOrEqual(720);
    });

    it("updateEdgesInCanvas updates edge fields by id", () => {
        const data = {
            nodes: [{ id: "a", type: "text" as const, x: 0, y: 0, width: 100, height: 100 }],
            edges: [
                { id: "e1", fromNode: "a", toNode: "a", label: "old", color: "#000" },
                { id: "e2", fromNode: "a", toNode: "a" },
            ],
        };
        const result = updateEdgesInCanvas(data, [
            { id: "e1", label: "new", toEnd: "none" },
        ]);
        expect(result.updated_ids).toEqual(["e1"]);
        const e1 = result.data.edges!.find((e) => e.id === "e1")!;
        expect(e1.label).toBe("new");
        expect(e1.toEnd).toBe("none");
        expect(e1.color).toBe("#000"); // unchanged
        // e2 untouched
        const e2 = result.data.edges!.find((e) => e.id === "e2")!;
        expect(e2.label).toBeUndefined();
    });

    it("updateEdgesInCanvas ignores missing edge ids", () => {
        const data = {
            nodes: [],
            edges: [{ id: "e1", fromNode: "missing", toNode: "missing" }],
        };
        const result = updateEdgesInCanvas(data, [{ id: "nonexistent", label: "x" }]);
        expect(result.updated_ids).toEqual([]);
    });
});
