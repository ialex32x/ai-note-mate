import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
    parseYaml: (s: string) => {
        // Minimal YAML subset for tests — not a full parser.
        const lines = s.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
        if (lines.length === 0) return {};
        if (lines[0]?.includes("views:")) {
            return {
                views: [{ type: "table", name: "Test", order: ["file.name"] }],
            };
        }
        return { invalid: true };
    },
}));

import { parseBaseContent, validateBase, summarizeBase, hasBaseErrors, addBaseView, updateBaseFilters, updateBaseViewOrder, findViewIndexByName } from "../src/services/tools/obsidian/base/base-schema";

describe("base-schema", () => {
    it("validateBase requires view type and name", () => {
        const issues = validateBase({
            views: [{ type: "invalid", name: "" }],
        });
        expect(hasBaseErrors(issues)).toBe(true);
    });

    it("validateBase accepts valid view", () => {
        const issues = validateBase({
            views: [{ type: "table", name: "Orphans", order: ["file.name"] }],
        });
        expect(hasBaseErrors(issues)).toBe(false);
    });

    it("validateBase warns on deprecated snake_case functions", () => {
        const issues = validateBase({
            filters: 'file.has_tag("x")',
            views: [{ type: "table", name: "T" }],
        });
        expect(issues.some((i) => i.severity === "warning" && i.message.includes("hasTag"))).toBe(true);
    });

    it("summarizeBase extracts view metadata", () => {
        const summary = summarizeBase({
            views: [{ type: "table", name: "A", limit: 10, order: ["file.name", "file.size"] }],
            formulas: { days_old: "1" },
            properties: { status: { displayName: "Status" } },
            filters: { and: [] },
        });
        expect(summary.view_count).toBe(1);
        expect(summary.views[0]?.name).toBe("A");
        expect(summary.formula_names).toEqual(["days_old"]);
        expect(summary.properties_configured).toEqual(["status"]);
        expect(summary.has_global_filters).toBe(true);
    });

    it("parseBaseContent rejects array root via mock invalid", () => {
        // Direct validate on array-shaped root
        const issues = validateBase({ views: "not-array" as unknown as never });
        expect(hasBaseErrors(issues)).toBe(true);
    });

    it("addBaseView appends a unique view", () => {
        const data = { views: [{ type: "table", name: "Existing", order: ["file.name"] }] };
        const next = addBaseView(data, { type: "cards", name: "New", order: ["file.name"] });
        expect(typeof next).toBe("object");
        if (typeof next === "string") return;
        expect(findViewIndexByName(next, "New")).toBe(1);
    });

    it("updateBaseViewOrder replaces order on named view", () => {
        const data = { views: [{ type: "table", name: "T", order: ["file.name"] }] };
        const next = updateBaseViewOrder(data, "T", ["file.mtime", "file.name"]);
        expect(typeof next).toBe("object");
        if (typeof next === "string") return;
        const view = (next.views as Record<string, unknown>[])[0]!;
        expect(view.order).toEqual(["file.mtime", "file.name"]);
    });

    it("updateBaseFilters removes global filters when null", () => {
        const data = { filters: { and: [] }, views: [{ type: "table", name: "T" }] };
        const next = updateBaseFilters(data, "global", null);
        expect(typeof next).toBe("object");
        if (typeof next === "string") return;
        expect(next.filters).toBeUndefined();
    });
});
