import { describe, it, expect } from "vitest";
import { structuredFileCreateRedirect } from "../src/services/tools/obsidian/_shared";

describe("structuredFileCreateRedirect", () => {
    it("redirects .canvas paths to create_canvas", () => {
        const r = structuredFileCreateRedirect("Boards/Overview.canvas");
        expect(r).not.toBeNull();
        expect(r!.content).toContain("create_canvas");
    });

    it("redirects .base paths to create_base", () => {
        const r = structuredFileCreateRedirect("Bases/Orphans.base");
        expect(r).not.toBeNull();
        expect(r!.content).toContain("create_base");
    });

    it("returns null for markdown paths", () => {
        expect(structuredFileCreateRedirect("Notes/A.md")).toBeNull();
    });
});
