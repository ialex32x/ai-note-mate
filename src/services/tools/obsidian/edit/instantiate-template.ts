import { TAbstractFile, TFile, TFolder, moment } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { ensureParentFolder, requireFileExtension, isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: instantiate_template
//
// Reads a template file, replaces variables deterministically (no LLM
// involved in the substitution step), and writes the result to the
// target path. This is the preferred way for the LLM to create notes
// from templates — it completely eliminates the "LLM missed a variable"
// / "LLM hallucinated extra content" failure modes that plague the
// manual read-template → replace-in-head → create_file path.
//
// Supported built-in variables (resolved deterministically):
//   {{date}}              → current date in ISO format (YYYY-MM-DD)
//   {{date:FORMAT}}       → current date formatted with moment format string
//   {{time}}              → current time (HH:mm)
//   {{time:FORMAT}}       → current time formatted with moment format string
//   {{title}}             → target path's basename without extension
//   {{filename}}          → target path's basename with extension
//   {{yesterday}}         → yesterday's date in ISO format
//   {{tomorrow}}          → tomorrow's date in ISO format
//   {{custom_key}}        → resolved from the optional `variables` map
//
// All date/time values derive from a single `date` parameter (defaults
// to "now"), so {{date}} and {{time}} on the same call are internally
// consistent.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────
// Variable resolution helpers
// ─────────────────────────────────────────────

const DATE_VAR = /^\{\{date\}\}$/;
const DATE_FORMAT_VAR = /^\{\{date:(.+)\}\}$/;
const TIME_VAR = /^\{\{time\}\}$/;
const TIME_FORMAT_VAR = /^\{\{time:(.+)\}\}$/;
const TITLE_VAR = /^\{\{title\}\}$/;
const FILENAME_VAR = /^\{\{filename\}\}$/;
const YESTERDAY_VAR = /^\{\{yesterday\}\}$/;
const TOMORROW_VAR = /^\{\{tomorrow\}\}$/;
const CUSTOM_VAR = /^\{\{([^{}]+)\}\}$/;

/**
 * Extract the basename (last path segment) without extension.
 * Examples:
 *   "Journal/2025-05-25.md" → "2025-05-25"
 *   "Notes/Meeting Notes.md" → "Meeting Notes"
 *   "readme.md" → "readme"
 */
function extractTitle(path: string): string {
    const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const filename = lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
    const dotIdx = filename.lastIndexOf(".");
    return dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
}

/**
 * Extract the basename with extension.
 * Examples:
 *   "Journal/2025-05-25.md" → "2025-05-25.md"
 *   "Notes/Meeting Notes.md" → "Meeting Notes.md"
 */
function extractFilename(path: string): string {
    const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    return lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
}

/**
 * Resolve a single template variable against the given context.
 * Returns the replacement string, or `null` if the token is not a
 * recognised variable (caller should leave it as-is).
 */
function resolveVariable(
    token: string,
    now: moment.Moment,
    targetPath: string,
    customVars: Record<string, string>,
): string | null {
    // Built-in dates
    if (DATE_VAR.test(token)) return now.format("YYYY-MM-DD");

    const dateFmtMatch = token.match(DATE_FORMAT_VAR);
    if (dateFmtMatch) {
        try {
            return now.format(dateFmtMatch[1]);
        } catch {
            // Invalid format string — leave as-is so the user sees the
            // un-replaced token and can fix the template.
            return null;
        }
    }

    if (TIME_VAR.test(token)) return now.format("HH:mm");

    const timeFmtMatch = token.match(TIME_FORMAT_VAR);
    if (timeFmtMatch) {
        try {
            return now.format(timeFmtMatch[1]);
        } catch {
            return null;
        }
    }

    if (YESTERDAY_VAR.test(token)) return now.clone().subtract(1, "day").format("YYYY-MM-DD");

    if (TOMORROW_VAR.test(token)) return now.clone().add(1, "day").format("YYYY-MM-DD");

    // Title / filename from target path
    if (TITLE_VAR.test(token)) return extractTitle(targetPath);
    if (FILENAME_VAR.test(token)) return extractFilename(targetPath);

    // Custom variables
    const customMatch = token.match(CUSTOM_VAR);
    if (customMatch?.[1]) {
        const key = customMatch[1].trim();
        const value = customVars[key];
        if (value !== undefined) return value;
        // Unknown custom variable: treat as unrecognised, leave as-is.
        return null;
    }

    // Not a recognised variable pattern at all — leave as-is.
    return null;
}

/**
 * Process the full template body, replacing every `{{...}}` token.
 *
 * Strategy: single-pass scan using a regex that matches any `{{...}}`
 * occurrence. For each match, attempt resolution; if the token is not
 * recognised, leave it unchanged in the output. This means the model
 * can use any `{{var}}` syntax and unresolvable tokens stay visible as
 * a signal that the user should fix the template.
 */
function processTemplate(
    template: string,
    now: moment.Moment,
    targetPath: string,
    customVars: Record<string, string>,
): { result: string; unresolved: string[] } {
    const unresolved: string[] = [];
    // Match any `{{...}}` token. The content between braces must not
    // itself contain braces (no nesting).
    const TOKEN_RE = /\{\{[^{}]+\}\}/g;

    const result = template.replace(TOKEN_RE, (match) => {
        const resolution = resolveVariable(match, now, targetPath, customVars);
        if (resolution !== null) return resolution;
        unresolved.push(match);
        return match;
    });

    return { result, unresolved };
}

// ─────────────────────────────────────────────
// Schema constants
// ─────────────────────────────────────────────

const SCHEMA_DESCRIPTION =
    "Create a new file by instantiating a template. Reads the template file, " +
    "replaces `{{variable}}` placeholders deterministically (NOT via the LLM), " +
    "and writes the result to the target path. " +
    "Supports built-in date/time variables ({{date}}, {{date:FORMAT}}, {{time}}, " +
    "{{time:FORMAT}}, {{yesterday}}, {{tomorrow}}) as well as path-derived variables " +
    "({{title}}, {{filename}}) and arbitrary custom variables passed via the " +
    "`variables` map. " +
    "This is the PREFERRED way to create a note from a template — the variable " +
    "replacement is guaranteed correct and complete, whereas manually doing " +
    "read_file + create_file risks missed or malformed substitutions.";

// ─────────────────────────────────────────────
// Public factory
// ─────────────────────────────────────────────

export function vaultInstantiateTemplate(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "instantiate_template",
                description: SCHEMA_DESCRIPTION,
                parameters: {
                    type: "object",
                    properties: {
                        template_path: {
                            type: "string",
                            description:
                                "Vault-relative path to the template file, e.g. " +
                                "'Templates/Daily Note.md'. The file must exist.",
                        },
                        target_path: {
                            type: "string",
                            description:
                                "Vault-relative path for the output file, e.g. " +
                                "'Journal/2025-05-25.md'. Must NOT already exist. " +
                                "File extension is required and will not be inferred — " +
                                "use '.md' for markdown notes.",
                        },
                        variables: {
                            type: "object",
                            description:
                                "Optional map of custom variable name → value pairs. " +
                                "When a `{{key}}` appears in the template, it is replaced " +
                                "with the corresponding value. Omit this parameter if no " +
                                "custom variables are needed. " +
                                "Example: {\"project_name\": \"My Project\", \"client\": \"Acme\"}",
                        },
                        date: {
                            type: "string",
                            description:
                                "Optional ISO-8601 date string (YYYY-MM-DD) used as the " +
                                "reference date for {{date}}, {{yesterday}}, {{tomorrow}}, " +
                                "and date-formatted variables. Defaults to today's date. " +
                                "Use this to create a note for a specific date, e.g. " +
                                "\"2025-05-25\".",
                        },
                    },
                    required: ["template_path", "target_path"],
                },
            },
        },
        capabilities: ["create_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const templatePath = args["template_path"] as string;
            const targetPath = args["target_path"] as string;
            const customVars = (args["variables"] as Record<string, string> | undefined) ?? {};
            const dateStr = args["date"] as string | undefined;

            // ── Validate target_path extension ─────────────────────
            const extErr = requireFileExtension(targetPath);
            if (extErr) return extErr;

            // ── Resolve template file ──────────────────────────────
            const templateFileOrErr = requireFile(plugin.app, templatePath);
            if (isFailure(templateFileOrErr)) {
                const original = templateFileOrErr.content as string;
                if (original.startsWith("File not found:")) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `${original} The template file must exist before it can be instantiated. ` +
                            `Check the path and try again.`,
                    };
                }
                return templateFileOrErr;
            }
            const templateFile = templateFileOrErr;

            // ── Check target does NOT already exist ────────────────
            const existing: TAbstractFile | null =
                plugin.app.vault.getAbstractFileByPath(targetPath);
            if (existing instanceof TFile) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `File already exists: ${targetPath}. ` +
                        `\`instantiate_template\` creates NEW files only — it does not overwrite. ` +
                        `To modify an existing file, use \`replace_text\`, \`insert_text\`, or ` +
                        `delegate to the \`vault_editor\` sub-agent.`,
                };
            }
            if (existing instanceof TFolder) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Path already exists as a folder: ${targetPath}. ` +
                        `Pick a different path or rename the folder first.`,
                };
            }

            // ── Read template body ─────────────────────────────────
            const templateBody = await plugin.app.vault.read(templateFile);

            // ── Resolve reference date ─────────────────────────────
            let now: moment.Moment;
            if (dateStr) {
                // Validate that the provided string is a real date
                const parsed = moment(dateStr, "YYYY-MM-DD", true);
                if (!parsed.isValid()) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `Invalid date "${dateStr}". Expected ISO-8601 format YYYY-MM-DD, ` +
                            `e.g. "2025-05-25". Got "${dateStr}" which is not a valid date.`,
                    };
                }
                now = parsed;
            } else {
                now = moment();
            }

            // ── Process template variables ─────────────────────────
            const { result: content, unresolved } = processTemplate(
                templateBody,
                now,
                targetPath,
                customVars,
            );

            // ── Write output file ──────────────────────────────────
            const parentErr = await ensureParentFolder(plugin.app, targetPath);
            if (parentErr) return parentErr;
            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "create",
                path: targetPath,
                toolName: "instantiate_template",
                perform: async () => {
                    await plugin.app.vault.create(targetPath, content);
                },
            });
            if (lockErr) return lockErr;

            // ── Build result ───────────────────────────────────────
            const resultPayload: Record<string, unknown> = {
                action: "created",
                template_path: templatePath,
                path: targetPath,
                reference_date: now.format("YYYY-MM-DD"),
                variable_count: Object.keys(customVars).length,
                unresolved_tokens: unresolved,
            };

            return {
                success: true,
                type: "object",
                content: resultPayload,
            };
        },
        requiresConfirmation: true,
    };
}
