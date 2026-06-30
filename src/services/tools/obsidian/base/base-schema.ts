/**
 * Obsidian Bases (`.base`) YAML helpers — parse, validate, and summarize.
 * Syntax: https://help.obsidian.md/bases
 */

import { parseYaml, stringifyYaml } from "obsidian";

export const BASE_VIEW_TYPES = ["table", "cards", "list", "map"] as const;
export type BaseViewType = (typeof BASE_VIEW_TYPES)[number];

export const GROUP_BY_DIRECTIONS = ["ASC", "DESC"] as const;

/** Built-in summary formula names recognized by Obsidian Bases (case-sensitive). */
export const DEFAULT_SUMMARY_NAMES = [
    "Average",
    "Min",
    "Max",
    "Sum",
    "Range",
    "Median",
    "Stddev",
    "Earliest",
    "Latest",
    "Checked",
    "Unchecked",
    "Empty",
    "Filled",
    "Unique",
] as const;

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
    { pattern: /\bfile\.has_property\b/, hint: "use file.hasProperty" },
    { pattern: /\bfile\.as_link\b/, hint: "use file.asLink" },
    { pattern: /\.as_file\b/, hint: "use .asFile" },
    { pattern: /\.links_to\b/, hint: "use .linksTo" },
    { pattern: /\.is_empty\b/, hint: "use .isEmpty" },
    { pattern: /\.is_type\b/, hint: "use .isType" },
    { pattern: /\.is_truthy\b/, hint: "use .isTruthy" },
    { pattern: /\.to_string\b/, hint: "use .toString" },
    { pattern: /\.to_fixed\b/, hint: "use .toFixed" },
    { pattern: /\.contains_all\b/, hint: "use .containsAll" },
    { pattern: /\.contains_any\b/, hint: "use .containsAny" },
    { pattern: /\.starts_with\b/, hint: "use .startsWith" },
    { pattern: /\.ends_with\b/, hint: "use .endsWith" },
    { pattern: /\bescape_html\b/, hint: "use escapeHTML" },
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

function normalizeView(view: Record<string, unknown>): Record<string, unknown> {
    const groupBy = view["groupBy"];
    if (typeof groupBy === "string" && groupBy.trim().length > 0) {
        return { ...view, groupBy: { property: groupBy.trim() } };
    }
    return view;
}

/** Coerce common LLM shorthand (e.g. string `groupBy`) into Obsidian-compatible shapes. */
export function normalizeBaseData(data: Record<string, unknown>): Record<string, unknown> {
    const viewsRaw = data["views"];
    if (!Array.isArray(viewsRaw)) return data;
    return {
        ...data,
        views: viewsRaw.map((v: unknown): unknown => {
            if (!v || typeof v !== "object" || Array.isArray(v)) return v;
            return normalizeView(v as Record<string, unknown>);
        }),
    };
}

function validateViewGroupBy(
    issues: BaseValidationIssue[],
    viewLabel: string,
    groupBy: unknown,
): void {
    if (groupBy === undefined) return;
    if (groupBy === null || typeof groupBy !== "object" || Array.isArray(groupBy)) {
        issues.push({
            severity: "error",
            message:
                `view "${viewLabel}": groupBy must be an object with \`property\` (and optional \`direction\`: ASC|DESC), ` +
                `e.g. \`groupBy: { property: file.folder }\`. A bare string is not valid Obsidian Bases syntax.`,
        });
        return;
    }
    const gb = groupBy as Record<string, unknown>;
    if (typeof gb["property"] !== "string" || gb["property"].length === 0) {
        issues.push({
            severity: "error",
            message: `view "${viewLabel}": groupBy.property must be a non-empty string.`,
        });
    }
    if (gb["direction"] !== undefined) {
        const dir = gb["direction"];
        if (typeof dir !== "string" || !(GROUP_BY_DIRECTIONS as readonly string[]).includes(dir)) {
            issues.push({
                severity: "error",
                message: `view "${viewLabel}": groupBy.direction must be ASC or DESC when present.`,
            });
        }
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

function getMappingKeys(value: unknown): string[] {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.keys(value);
    }
    return [];
}

/** A `formula.X` token is valid only if `X` is defined under the top-level `formulas` mapping. */
function validateFormulaReferences(
    issues: BaseValidationIssue[],
    data: Record<string, unknown>,
): void {
    const definedFormulas = new Set(getMappingKeys(data["formulas"]));
    const checkRef = (ref: string, where: string): void => {
        if (!ref.startsWith("formula.")) return;
        const name = ref.slice("formula.".length);
        if (name.length > 0 && !definedFormulas.has(name)) {
            issues.push({
                severity: "error",
                message:
                    `${where} references undefined formula '${ref}'. ` +
                    `Define '${name}' under the top-level \`formulas\` mapping, or remove the reference.`,
            });
        }
    };

    for (const key of getMappingKeys(data["properties"])) {
        checkRef(key, "properties key");
    }
    if (Array.isArray(data["views"])) {
        data["views"].forEach((v: unknown, i: number) => {
            if (!v || typeof v !== "object" || Array.isArray(v)) return;
            const view = v as Record<string, unknown>;
            const label =
                typeof view["name"] === "string" && view["name"].length > 0 ? view["name"] : `views[${i}]`;
            const order = view["order"];
            if (Array.isArray(order)) {
                for (const o of order) {
                    if (typeof o === "string") checkRef(o, `view "${label}" order`);
                }
            }
            for (const key of getMappingKeys(view["summaries"])) {
                checkRef(key, `view "${label}" summaries key`);
            }
        });
    }
}

/** View `summaries` values must be a built-in summary name or a custom one defined in top-level `summaries`. */
function validateSummaryNames(
    issues: BaseValidationIssue[],
    data: Record<string, unknown>,
): void {
    const customSummaries = new Set(getMappingKeys(data["summaries"]));
    const known = new Set<string>([...DEFAULT_SUMMARY_NAMES, ...customSummaries]);
    if (!Array.isArray(data["views"])) return;
    data["views"].forEach((v: unknown, i: number) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return;
        const view = v as Record<string, unknown>;
        const summaries = view["summaries"];
        if (summaries === undefined) return;
        const label =
            typeof view["name"] === "string" && view["name"].length > 0 ? view["name"] : `views[${i}]`;
        if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) {
            issues.push({
                severity: "error",
                message: `view "${label}": summaries must be a mapping of property -> summary name.`,
            });
            return;
        }
        for (const [prop, summaryName] of Object.entries(summaries as Record<string, unknown>)) {
            if (typeof summaryName !== "string" || !known.has(summaryName)) {
                issues.push({
                    severity: "warning",
                    message:
                        `view "${label}": summary '${String(summaryName)}' for '${prop}' is not a built-in ` +
                        `(${DEFAULT_SUMMARY_NAMES.join(", ")}) or a custom name from top-level \`summaries\`.`,
                });
            }
        }
    });
}

/**
 * Heuristics for the most common Bases formula mistakes documented by Obsidian:
 * subtracting two dates yields a Duration, which does not support .round()/.floor()/.ceil()
 * directly and cannot be divided then rounded — access a numeric field (.days/.hours/...) first.
 */
const DURATION_MISUSE_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
    {
        // Matches rounding applied directly to a `(... - <date>)` group, e.g. `(now() - file.ctime).round(0)`.
        // Deliberately narrow (requires a date token before the close paren) to avoid flagging valid
        // number rounding such as `(file.size / 5).round(0)`.
        pattern: /-\s*(now\(\)|today\(\)|date\([^)]*\)|file\.\w*time)\s*\)\s*\.(round|floor|ceil)\s*\(/,
        hint: "Subtracting dates yields a Duration; access a numeric field first, e.g. (a - b).days.round(0).",
    },
    {
        pattern: /\/\s*86400000/,
        hint: "Dividing a Duration by 86400000 is not supported — use (a - b).days instead.",
    },
];

function validateExpressionHeuristics(issues: BaseValidationIssue[], exprStrings: string[]): void {
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
        for (const { pattern, hint } of DURATION_MISUSE_PATTERNS) {
            if (pattern.test(expr)) {
                issues.push({
                    severity: "warning",
                    message: `Possible Duration misuse — ${hint} Expression: ${expr.slice(0, 120)}`,
                });
                break;
            }
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
                const limit = view["limit"];
                if (
                    limit !== undefined &&
                    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0)
                ) {
                    issues.push({
                        severity: "error",
                        message: `${prefix}.limit must be a non-negative integer when present.`,
                    });
                }
                const viewLabel = typeof name === "string" && name.length > 0 ? name : prefix;
                validateViewGroupBy(issues, viewLabel, view["groupBy"]);
            }
        }
    }

    if (data["formulas"] !== undefined && (typeof data["formulas"] !== "object" || Array.isArray(data["formulas"]))) {
        issues.push({ severity: "error", message: "`formulas` must be a mapping when present." });
    }
    if (data["properties"] !== undefined && (typeof data["properties"] !== "object" || Array.isArray(data["properties"]))) {
        issues.push({ severity: "error", message: "`properties` must be a mapping when present." });
    }

    validateFormulaReferences(issues, data);
    validateSummaryNames(issues, data);

    const exprStrings: string[] = [];
    collectExpressionStrings(data["filters"], exprStrings);
    collectExpressionStrings(data["formulas"], exprStrings);
    if (Array.isArray(data["views"])) {
        for (const v of data["views"]) {
            if (v && typeof v === "object") {
                collectExpressionStrings((v as Record<string, unknown>)["filters"], exprStrings);
            }
        }
    }
    validateExpressionHeuristics(issues, exprStrings);

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
            ? Object.keys(formulas).sort()
            : [];

    const properties = data["properties"];
    const propertiesConfigured =
        properties && typeof properties === "object" && !Array.isArray(properties)
            ? Object.keys(properties).sort()
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

export function prepareBaseContentForWrite(
    content: string,
): { ok: true; serialized: string } | { ok: false; error: string } {
    const parsed = parseBaseContent(content);
    if (!parsed.ok) {
        return { ok: false, error: parsed.error };
    }
    const normalized = normalizeBaseData(parsed.data);
    const issues = validateBase(normalized);
    if (hasBaseErrors(issues)) {
        const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
        return {
            ok: false,
            error:
                "Base validation failed:\n" +
                messages.map((m) => `- ${m}`).join("\n") +
                "\nFix the YAML and retry, or call read_base after a successful write.",
        };
    }
    return { ok: true, serialized: serializeBase(normalized) };
}

export function prepareBaseDataForWrite(
    data: Record<string, unknown>,
): { ok: true; data: Record<string, unknown>; serialized: string } | { ok: false; error: string } {
    const normalized = normalizeBaseData(data);
    const issues = validateBase(normalized);
    if (hasBaseErrors(issues)) {
        const messages = issues.filter((i) => i.severity === "error").map((i) => i.message);
        return {
            ok: false,
            error: "Base validation failed:\n" + messages.map((m) => `- ${m}`).join("\n"),
        };
    }
    return { ok: true, data: normalized, serialized: serializeBase(normalized) };
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
