import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";
import {
    addBaseView,
    hasBaseErrors,
    parseBaseContent,
    serializeBase,
    updateBaseFilters,
    updateBaseViewOrder,
    validateBase,
} from "./base-schema";
import { inspectBaseContent, requireBaseExtension } from "./_base-io";

async function applyBaseMutation(
    plugin: NoteAssistantPlugin,
    chatStream: Parameters<RegisteredTool["exec"]>[0],
    opts: {
        path: string;
        toolName: string;
        dryRun: boolean;
        expectedPreEditMtime?: number;
        mutate: (data: Record<string, unknown>) => Record<string, unknown> | string;
        action: string;
        dryRunAction: string;
        extra?: Record<string, unknown>;
    },
): Promise<ToolCallResult> {
    const baseExt = requireBaseExtension(opts.path);
    if (!baseExt.ok) {
        return { success: false, type: "text", content: baseExt.message };
    }

    const fileOrErr = requireFile(plugin.app, opts.path);
    if (isFailure(fileOrErr)) return fileOrErr;
    const file = fileOrErr;

    const previousMtime = file.stat.mtime;
    if (opts.expectedPreEditMtime !== undefined && opts.expectedPreEditMtime !== previousMtime) {
        return {
            success: false,
            type: "text",
            content:
                `\`expected_pre_edit_mtime\` mismatch: expected ${opts.expectedPreEditMtime}, actual ${previousMtime}.`,
        };
    }

    const content = await plugin.app.vault.read(file);
    const parsed = parseBaseContent(content);
    if (!parsed.ok) {
        return { success: false, type: "text", content: parsed.error };
    }

    const mutated = opts.mutate(parsed.data);
    if (typeof mutated === "string") {
        return { success: false, type: "text", content: mutated };
    }

    const issues = validateBase(mutated);
    if (hasBaseErrors(issues)) {
        const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
        return {
            success: false,
            type: "text",
            content: "Base validation failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
        };
    }

    const serialized = serializeBase(mutated);
    if (!opts.dryRun) {
        const lockErr = await runVaultMutation(plugin, chatStream, {
            kind: "modify",
            path: opts.path,
            toolName: opts.toolName,
            perform: async () => {
                await plugin.app.vault.modify(file, serialized);
            },
        });
        if (lockErr) return lockErr;
    }

    const inspection = inspectBaseContent(serialized);
    return {
        success: true,
        type: "object",
        content: {
            action: opts.dryRun ? opts.dryRunAction : opts.action,
            path: opts.path,
            previous_mtime: previousMtime,
            new_mtime: opts.dryRun ? previousMtime : file.stat.mtime,
            dry_run: opts.dryRun,
            parse_ok: inspection.parse_ok,
            validation_issues: inspection.validation_issues,
            ...inspection.summary,
            ...opts.extra,
        },
    };
}

export function vaultAddBaseView(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "add_base_view",
                description:
                    "Append a new view to an existing `.base` file. Requires `type` (table|cards|list|map) and " +
                    "`name` (must be unique). Optional: `order`, `limit`, `filters`, `groupBy`, `summaries`. " +
                    "Validated before writing. Use `read_base` first to inspect existing views.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .base file.",
                        },
                        view: {
                            type: "object",
                            description:
                                "View definition. Required: `type`, `name`. Optional: `order` (string[]), `limit` (number), " +
                                "`filters` (object or expression), `groupBy`, `summaries`.",
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "view"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const rawView = args["view"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (!rawView || typeof rawView !== "object" || Array.isArray(rawView)) {
                return { success: false, type: "text", content: "`view` must be an object." };
            }

            const viewName = (rawView as Record<string, unknown>)["name"];
            return applyBaseMutation(plugin, chatStream, {
                path,
                toolName: "add_base_view",
                dryRun,
                expectedPreEditMtime,
                mutate: (data) => addBaseView(data, rawView as Record<string, unknown>),
                action: "base_view_added",
                dryRunAction: "dry_run_add_base_view",
                extra: { added_view_name: typeof viewName === "string" ? viewName : null },
            });
        },
        requiresConfirmation: true,
    };
}

export function vaultUpdateBaseFilters(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "update_base_filters",
                description:
                    "Replace filters on an existing `.base` file — either global (`scope: global`) or on a " +
                    "specific view (`scope: view` + `view_name`). `filters` may be a filter expression string, " +
                    "or an and/or/not object per Bases syntax. Does NOT execute filters; static validation only.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .base file.",
                        },
                        scope: {
                            type: "string",
                            enum: ["global", "view"],
                            description: "'global' replaces root-level `filters`; 'view' replaces a view's `filters`.",
                        },
                        view_name: {
                            type: "string",
                            description: "Required when scope is 'view': the target view's `name`.",
                        },
                        filters: {
                            description:
                                "New filters value — a string expression or nested and/or/not object. " +
                                "Pass null to remove filters (global or view-level).",
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "scope", "filters"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const scope = args["scope"] as string;
            const viewName = args["view_name"] as string | undefined;
            const filters = args["filters"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (scope !== "global" && scope !== "view") {
                return { success: false, type: "text", content: "`scope` must be 'global' or 'view'." };
            }

            return applyBaseMutation(plugin, chatStream, {
                path,
                toolName: "update_base_filters",
                dryRun,
                expectedPreEditMtime,
                mutate: (data) => updateBaseFilters(data, scope, filters, viewName),
                action: "base_filters_updated",
                dryRunAction: "dry_run_update_base_filters",
                extra: { scope, view_name: viewName ?? null },
            });
        },
        requiresConfirmation: true,
    };
}

export function vaultUpdateBaseViewOrder(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "update_base_view_order",
                description:
                    "Replace the `order` column list on a named view in an existing `.base` file. " +
                    "Use property names like 'file.name', 'file.mtime', 'note.status', 'formula.my_formula'.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to an existing .base file.",
                        },
                        view_name: {
                            type: "string",
                            description: "Name of the view to update (must already exist).",
                        },
                        order: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description: "New column order as an array of property names.",
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, validate without writing. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail if on-disk mtime differs.",
                        },
                    },
                    required: ["path", "view_name", "order"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal) => {
            const path = args["path"] as string;
            const viewName = args["view_name"] as string;
            const rawOrder = args["order"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (!Array.isArray(rawOrder) || rawOrder.length === 0) {
                return { success: false, type: "text", content: "`order` must be a non-empty array." };
            }
            const order = rawOrder.filter((o): o is string => typeof o === "string" && o.length > 0);
            if (order.length === 0) {
                return { success: false, type: "text", content: "`order` must contain non-empty strings." };
            }

            return applyBaseMutation(plugin, chatStream, {
                path,
                toolName: "update_base_view_order",
                dryRun,
                expectedPreEditMtime,
                mutate: (data) => updateBaseViewOrder(data, viewName, order),
                action: "base_view_order_updated",
                dryRunAction: "dry_run_update_base_view_order",
                extra: { view_name: viewName, order },
            });
        },
        requiresConfirmation: true,
    };
}
