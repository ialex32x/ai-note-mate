/**
 * Obsidian Bases (`.base`) YAML helpers — parse, validate, and summarize.
 * Syntax: https://help.obsidian.md/bases
 */

import { parseYaml, stringifyYaml } from "obsidian";

export const BASE_VIEW_TYPES = ["table", "cards", "list", "map"] as const;
export type BaseViewType = (typeof BASE_VIEW_TYPES)[number];

export interface BaseValidationIssue {
    severity: "error" | "warning";
    message: string;
}

export interface BaseViewSummary {
    name: string;
    type: string;
    limit: number | null;
    order: string[];
}

export interface BaseSummary {
    view_count: number;
    views: BaseViewSummary[];
    formula_names: string[];
    properties_configured: string[];
    has_global_filters: boolean;
}

/** Obsidian 1.9+ camelCase renames — warn when legacy snake_case appears in expressions. */
const DEPRECATED_BASE_FUNCTIONS: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /\bfile\.has_tag\b/, hint: "use file.hasTag" },
    { pattern: /\bfile\.in_folder\b/, hint: "use file.inFolder" },
    { pattern: /\bfile\.has_link\b/, hint: "use file.hasLink" },
    { pattern: /\bfile\.has_tag\(/, hint: "use file.hasTag(" },
    { pattern: /\bfile\.in_folder\(/, hint: "use file.inFolder(" },
    { pattern: /\bfile\.has_link\(/, hint: "use file.hasLink(" },
];

export function parseBaseContent(
    content: string,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
        return { ok: true, data: { views: [] } };
    }
    try {
        const parsed: unknown = parseYaml(trimmed);
        if (parsed === null || parsed === undefined) {
            return { ok: true, data: { views: [] } };
        }
        if (typeof parsed !== "object" || Array.isArray(parsed)) {
            return { ok: false, error: "Base root must be a YAML mapping (object), not an array or scalar." };
        }
        return { ok: true, data: parsed as Record<string, unknown> };
    } catch (err) {
        return {
            ok: false,
            error: `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}

function collectExpressionStrings(value: unknown, out: string[]): void {
    if (typeof value === "string") {
        out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectExpressionStrings(item, out);
        return;
    }
    if (value && typeof value === "object") {
        for (const v of Object.values(value as Record<string, unknown>)) {
            collectExpressionStrings(v, out);
        }
    }
}

export function validateBase(data: Record<string, unknown>): BaseValidationIssue[] {
    const issues: BaseValidationIssue[] = [];

    if (data["views"] !== undefined) {
        const views = data["views"];
        if (!Array.isArray(views)) {
            issues.push({ severity: "error", message: "`views` must be an array when present." });
        } else {
            for (let i = 0; i < views.length; i++) {
                const v: unknown = views[i];
                const prefix = `views[${i}]`;
                if (!v || typeof v !== "object" || Array.isArray(v)) {
                    issues.push({ severity: "error", message: `${prefix} must be an object.` });
                    continue;
                }
                const view = v as Record<string, unknown>;
                const type = view["type"];
                const name = view["name"];
                if (typeof type !== "string" || !(BASE_VIEW_TYPES as readonly string[]).includes(type)) {
                    issues.push({
                        severity: "error",
                        message: `${prefix}.type must be one of: ${BASE_VIEW_TYPES.join(", ")}.`,
                    });
                }
                if (typeof name !== "string" || name.length === 0) {
                    issues.push({ severity: "error", message: `${prefix}.name must be a non-empty string.` });
                }
                const order = view["order"];
                if (order !== undefined && !Array.isArray(order)) {
                    issues.push({ severity: "error", message: `${prefix}.order must be an array when present.` });
                }
            }
        }
    }

    if (data["formulas"] !== undefined && (typeof data["formulas"] !== "object" || Array.isArray(data["formulas"]))) {
        issues.push({ severity: "error", message: "`formulas` must be a mapping when present." });
    }
    if (data["properties"] !== undefined && (typeof data["properties"] !== "object" || Array.isArray(data["properties"]))) {
        issues.push({ severity: "error", message: "`properties` must be a mapping when present." });
    }

    const exprStrings: string[] = [];
    collectExpressionStrings(data["filters"], exprStrings);
    collectExpressionStrings(data["formulas"], exprStrings);
    collectExpressionStrings(data["summaries"], exprStrings);
    if (Array.isArray(data["views"])) {
        for (const v of data["views"]) {
            if (v && typeof v === "object") {
                collectExpressionStrings((v as Record<string, unknown>)["filters"], exprStrings);
            }
        }
    }

    for (const expr of exprStrings) {
        for (const { pattern, hint } of DEPRECATED_BASE_FUNCTIONS) {
            if (pattern.test(expr)) {
                issues.push({
                    severity: "warning",
                    message: `Expression contains deprecated snake_case function — ${hint}: ${expr.slice(0, 120)}`,
                });
                break;
            }
        }
    }

    return issues;
}

export function hasBaseErrors(issues: BaseValidationIssue[]): boolean {
    return issues.some((i) => i.severity === "error");
}

export function summarizeBase(data: Record<string, unknown>): BaseSummary {
    const viewsRaw = Array.isArray(data["views"]) ? data["views"] : [];
    const views: BaseViewSummary[] = [];
    for (const v of viewsRaw) {
        if (!v || typeof v !== "object" || Array.isArray(v)) continue;
        const view = v as Record<string, unknown>;
        const orderRaw = view["order"];
        views.push({
            name: typeof view["name"] === "string" ? view["name"] : "",
            type: typeof view["type"] === "string" ? view["type"] : "",
            limit: typeof view["limit"] === "number" ? view["limit"] : null,
            order: Array.isArray(orderRaw)
                ? orderRaw.filter((o): o is string => typeof o === "string")
                : [],
        });
    }

    const formulas = data["formulas"];
    const formulaNames =
        formulas && typeof formulas === "object" && !Array.isArray(formulas)
            ? Object.keys(formulas as Record<string, unknown>).sort()
            : [];

    const properties = data["properties"];
    const propertiesConfigured =
        properties && typeof properties === "object" && !Array.isArray(properties)
            ? Object.keys(properties as Record<string, unknown>).sort()
            : [];

    const hasGlobalFilters = data["filters"] !== undefined && data["filters"] !== null;

    return {
        view_count: views.length,
        views,
        formula_names: formulaNames,
        properties_configured: propertiesConfigured,
        has_global_filters: hasGlobalFilters,
    };
}

export function serializeBase(data: Record<string, unknown>): string {
    return stringifyYaml(data);
}

export function findViewIndexByName(data: Record<string, unknown>, name: string): number {
    const views = data["views"];
    if (!Array.isArray(views)) return -1;
    for (let i = 0; i < views.length; i++) {
        const v: unknown = views[i];
        if (v && typeof v === "object" && !Array.isArray(v) && (v as Record<string, unknown>)["name"] === name) {
            return i;
        }
    }
    return -1;
}

export function addBaseView(
    data: Record<string, unknown>,
    view: Record<string, unknown>,
): Record<string, unknown> | string {
    const name = view["name"];
    if (typeof name !== "string" || name.length === 0) {
        return "view.name must be a non-empty string.";
    }
    const type = view["type"];
    if (typeof type !== "string" || !(BASE_VIEW_TYPES as readonly string[]).includes(type)) {
        return `view.type must be one of: ${BASE_VIEW_TYPES.join(", ")}.`;
    }
    if (findViewIndexByName(data, name) >= 0) {
        return `View '${name}' already exists. Use update_base_view_order or update_base_filters to modify it.`;
    }
    const viewsRaw = data["views"];
    const views: unknown[] = Array.isArray(viewsRaw) ? (viewsRaw as unknown[]).slice() : [];
    views.push({ ...view });
    return { ...data, views };
}

export function updateBaseFilters(
    data: Record<string, unknown>,
    scope: "global" | "view",
    filters: unknown,
    viewName?: string,
): Record<string, unknown> | string {
    if (scope === "global") {
        if (filters === null) {
            const next = { ...data };
            delete next["filters"];
            return next;
        }
        if (filters === undefined) {
            return "`filters` must be provided (use null to remove global filters).";
        }
        return { ...data, filters };
    }
    if (typeof viewName !== "string" || viewName.length === 0) {
        return "view_name is required when scope is 'view'.";
    }
    const idx = findViewIndexByName(data, viewName);
    if (idx < 0) {
        return `View '${viewName}' not found. Call read_base to list views, or add_base_view to create it.`;
    }
    const views = [...(data["views"] as unknown[])];
    const current = views[idx];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
        return `views[${idx}] is not an object.`;
    }
    const updated = { ...(current as Record<string, unknown>) };
    if (filters === null) {
        delete updated["filters"];
    } else if (filters === undefined) {
        return "`filters` must be provided (use null to remove view filters).";
    } else {
        updated["filters"] = filters;
    }
    views[idx] = updated;
    return { ...data, views };
}

export function updateBaseViewOrder(
    data: Record<string, unknown>,
    viewName: string,
    order: string[],
): Record<string, unknown> | string {
    if (!Array.isArray(order) || order.length === 0) {
        return "`order` must be a non-empty array of property names.";
    }
    if (order.some((o) => typeof o !== "string" || o.length === 0)) {
        return "Each entry in `order` must be a non-empty string.";
    }
    const idx = findViewIndexByName(data, viewName);
    if (idx < 0) {
        return `View '${viewName}' not found. Call read_base to list views.`;
    }
    const views = [...(data["views"] as unknown[])];
    const current = views[idx];
    if (!current || typeof current !== "object" || Array.isArray(current)) {
        return `views[${idx}] is not an object.`;
    }
    views[idx] = { ...(current as Record<string, unknown>), order: [...order] };
    return { ...data, views };
}
