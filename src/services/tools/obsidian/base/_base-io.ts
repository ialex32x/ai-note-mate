import type { App } from "obsidian";
import type { ToolCallResult } from "../../../chat-stream";
import { isFailure, requireFile } from "../_shared";
import {
    hasBaseErrors,
    parseBaseContent,
    summarizeBase,
    validateBase,
    type BaseValidationIssue,
} from "./base-schema";

export function requireBaseExtension(path: string): { ok: true } | { ok: false; message: string } {
    if (!path.toLowerCase().endsWith(".base")) {
        return {
            ok: false,
            message: `Path '${path}' must have a .base extension. Use create_base / write_base for Bases files.`,
        };
    }
    return { ok: true };
}

export async function loadBaseFromVault(
    app: App,
    path: string,
): Promise<
    | { ok: true; content: string; mtime: number }
    | { ok: false; result: ToolCallResult }
> {
    const extErr = requireBaseExtension(path);
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

export function inspectBaseContent(content: string): {
    parse_ok: boolean;
    validation_issues: BaseValidationIssue[];
    summary: ReturnType<typeof summarizeBase>;
} {
    const parsed = parseBaseContent(content);
    if (!parsed.ok) {
        return {
            parse_ok: false,
            validation_issues: [{ severity: "error", message: parsed.error }],
            summary: summarizeBase({ views: [] }),
        };
    }
    const issues = validateBase(parsed.data);
    return {
        parse_ok: !hasBaseErrors(issues),
        validation_issues: issues,
        summary: summarizeBase(parsed.data),
    };
}
