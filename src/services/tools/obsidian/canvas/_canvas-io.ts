import type { App } from "obsidian";
import type { ToolCallResult } from "../../../chat-stream";
import { isFailure, requireFile } from "../_shared";
import {
    hasCanvasErrors,
    parseCanvasContent,
    summarizeCanvas,
    validateCanvas,
    type CanvasValidationIssue,
} from "./canvas-schema";

export function requireCanvasExtension(path: string): { ok: true } | { ok: false; message: string } {
    if (!path.toLowerCase().endsWith(".canvas")) {
        return {
            ok: false,
            message: `Path '${path}' must have a .canvas extension. Use create_canvas / write_canvas for canvas files.`,
        };
    }
    return { ok: true };
}

export async function loadCanvasFromVault(
    app: App,
    path: string,
): Promise<
    | { ok: true; content: string; mtime: number }
    | { ok: false; result: ToolCallResult }
> {
    const extErr = requireCanvasExtension(path);
    if (!extErr.ok) {
        return { ok: false, result: { success: false, type: "text", content: extErr.message } };
    }
    const fileOrErr = requireFile(app, path);
    if (isFailure(fileOrErr)) {
        return { ok: false, result: fileOrErr };
    }
    const content = await app.vault.read(fileOrErr);
    return { ok: true, content, mtime: fileOrErr.stat.mtime };
}

export function inspectCanvasContent(
    content: string,
    resolvePath?: (vaultRelativePath: string) => boolean,
    includeNodeIds?: boolean,
    includeEdgeIds?: boolean,
): {
    valid: boolean;
    validation_issues: CanvasValidationIssue[];
    summary: ReturnType<typeof summarizeCanvas>;
} {
    const opts = { includeNodeIds, includeEdgeIds };
    const parsed = parseCanvasContent(content);
    if (!parsed.ok) {
        return {
            valid: false,
            validation_issues: [{ severity: "error", message: parsed.error }],
            summary: summarizeCanvas({ nodes: [], edges: [] }, opts),
        };
    }
    const issues = validateCanvas(parsed.data, resolvePath);
    return {
        valid: !hasCanvasErrors(issues),
        validation_issues: issues,
        summary: summarizeCanvas(parsed.data, opts),
    };
}

export function makePathResolver(app: App): (p: string) => boolean {
    return (p: string) => app.vault.getAbstractFileByPath(p) !== null;
}
