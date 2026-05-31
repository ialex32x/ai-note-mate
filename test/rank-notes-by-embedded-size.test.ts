import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import {
    aggregateEmbeddedAttachmentBytesByNote,
    extensionFromVaultPath,
    isEmbeddedAttachmentTarget,
    isNoteSourcePath,
} from "../src/services/tools/obsidian/vault/rank-notes-by-embedded-size";

function mockFile(path: string, size: number): TFile {
    const ext = extensionFromVaultPath(path);
    return {
        path,
        extension: ext,
        stat: { size, ctime: 0, mtime: 0 },
    } as TFile;
}

function makeGetFile(files: Record<string, TFile>): (path: string) => TFile | null {
    return (path) => files[path] ?? null;
}

describe("rank-notes-by-embedded-size helpers", () => {
    it("isNoteSourcePath accepts md and canvas only", () => {
        expect(isNoteSourcePath("Notes/A.md")).toBe(true);
        expect(isNoteSourcePath("Board.canvas")).toBe(true);
        expect(isNoteSourcePath("img.png")).toBe(false);
    });

    it("isEmbeddedAttachmentTarget excludes md, base, canvas", () => {
        expect(isEmbeddedAttachmentTarget(mockFile("a.png", 1))).toBe(true);
        expect(isEmbeddedAttachmentTarget(mockFile("a.pdf", 1))).toBe(true);
        expect(isEmbeddedAttachmentTarget(mockFile("a.md", 1))).toBe(false);
        expect(isEmbeddedAttachmentTarget(mockFile("a.base", 1))).toBe(false);
        expect(isEmbeddedAttachmentTarget(mockFile("a.canvas", 1))).toBe(false);
    });
});

describe("aggregateEmbeddedAttachmentBytesByNote", () => {
    const baseOpts = {
        limit: 10,
        skip: 0,
        includeBreakdown: false,
        breakdownLimit: 5,
    };

    it("sums each distinct target size once per note and ranks descending", () => {
        const resolved = {
            "Notes/A.md": { "img/a.png": 2, "Notes/B.md": 1 },
            "Notes/C.md": { "img/b.png": 1 },
        };
        const files = {
            "img/a.png": mockFile("img/a.png", 1000),
            "img/b.png": mockFile("img/b.png", 5000),
        };

        const result = aggregateEmbeddedAttachmentBytesByNote(
            resolved,
            makeGetFile(files),
            baseOpts,
        );

        expect(result.notes).toHaveLength(2);
        expect(result.notes[0]!.path).toBe("Notes/C.md");
        expect(result.notes[0]!.attachment_total_bytes).toBe(5000);
        expect(result.notes[1]!.path).toBe("Notes/A.md");
        expect(result.notes[1]!.attachment_total_bytes).toBe(1000);
        expect(result.notes[1]!.attachment_reference_count).toBe(2);
    });

    it("does not multiply total by embed count when same target appears once in index", () => {
        const resolved = { "Notes/A.md": { "img/a.png": 3 } };
        const files = { "img/a.png": mockFile("img/a.png", 1000) };

        const result = aggregateEmbeddedAttachmentBytesByNote(
            resolved,
            makeGetFile(files),
            { ...baseOpts, includeBreakdown: true },
        );

        expect(result.notes[0]!.attachment_total_bytes).toBe(1000);
        expect(result.notes[0]!.attachment_reference_count).toBe(3);
        expect(result.notes[0]!.top_attachments![0]).toEqual({
            path: "img/a.png",
            size: 1000,
            count: 3,
            bytes: 1000,
        });
    });

    it("ignores md/base/canvas targets and non-note sources", () => {
        const resolved = {
            "Notes/A.md": {
                "Notes/B.md": 1,
                "x.base": 1,
                "y.canvas": 1,
                "z.pdf": 1,
            },
            "img/x.png": { "Notes/A.md": 1 },
        };
        const files = {
            "Notes/B.md": mockFile("Notes/B.md", 999),
            "x.base": mockFile("x.base", 888),
            "y.canvas": mockFile("y.canvas", 777),
            "z.pdf": mockFile("z.pdf", 100),
        };

        const result = aggregateEmbeddedAttachmentBytesByNote(
            resolved,
            makeGetFile(files),
            baseOpts,
        );

        expect(result.notes).toHaveLength(1);
        expect(result.notes[0]!.attachment_total_bytes).toBe(100);
    });

    it("applies min_total_bytes and include_breakdown", () => {
        const resolved = {
            "Notes/A.md": { "a.png": 1 },
            "Notes/B.md": { "b.png": 1 },
        };
        const files = {
            "a.png": mockFile("a.png", 10),
            "b.png": mockFile("b.png", 100),
        };

        const result = aggregateEmbeddedAttachmentBytesByNote(
            resolved,
            makeGetFile(files),
            { ...baseOpts, minTotalBytes: 50, includeBreakdown: true, breakdownLimit: 3 },
        );

        expect(result.notes).toHaveLength(1);
        expect(result.notes[0]!.path).toBe("Notes/B.md");
        expect(result.notes[0]!.top_attachments).toEqual([
            { path: "b.png", size: 100, count: 1, bytes: 100 },
        ]);
    });

    it("counts missing targets and respects folder_prefix", () => {
        const resolved = {
            "Daily/A.md": { "missing.png": 1, "ok.png": 1 },
            "Other/B.md": { "ok.png": 1 },
        };
        const files = { "ok.png": mockFile("ok.png", 42) };

        const result = aggregateEmbeddedAttachmentBytesByNote(
            resolved,
            makeGetFile(files),
            { ...baseOpts, folderPrefix: "Daily" },
        );

        expect(result.missing_targets).toBe(1);
        expect(result.notes).toHaveLength(1);
        expect(result.notes[0]!.path).toBe("Daily/A.md");
    });
});
