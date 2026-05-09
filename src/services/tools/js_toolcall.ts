import type NoteAssistantPlugin from "../../main";
import type { RegisteredTool, ToolCallResult } from "../chat-stream";
import type { ToolCapability } from "../llm-provider";

/**
 * Create JavaScript execution tools collection
 * @param plugin Plugin instance
 * @returns Array of registered tools
 */
export function createJavaScriptTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    if (!plugin.settings.builtinJavaScriptEnabled) return [];
    
    return [
        evaluateJavaScript(plugin),
    ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: evaluate_javascript
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tool to evaluate JavaScript code in a sandboxed environment.
 * The `app` instance (from plugin.app) is injected as a parameter,
 * allowing the AI to interact with the Obsidian API programmatically.
 */
function evaluateJavaScript(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "evaluate_javascript",
                description:
                    "Execute a JavaScript code snippet in a sandboxed environment with access to the Obsidian `app` instance. " +
                    "The code runs as an async function body with `app` available as a parameter (the Obsidian App object). " +
                    "Use `return` to produce a result. The returned value will be serialized as JSON. " +
                    "Use this when you need to perform complex vault operations, query metadata cache, " +
                    "manipulate the workspace, or do anything that requires direct Obsidian API access " +
                    "beyond what other tools provide. " +
                    "Examples: `return app.vault.getMarkdownFiles().length;` or " +
                    "`const file = app.workspace.getActiveFile(); return file?.path;`",
                parameters: {
                    type: "object",
                    properties: {
                        code: {
                            type: "string",
                            description:
                                "JavaScript code to execute. Runs as the body of an async function " +
                                "with `app` (Obsidian App instance) as a parameter. " +
                                "Use `return` to produce output. " +
                                "Avoid infinite loops or long-running operations.",
                        },
                    },
                    required: ["code"],
                },
            },
        },
        capabilities: ["execute"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const code = args["code"] as string;

            if (!code || !code.trim()) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Code cannot be empty.",
                };
            }

            try {
                // Create a sandboxed async function with `app` as the only parameter
                // Using AsyncFunction constructor to support await expressions
                const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
                const fn = new AsyncFunction("app", "console", code) as (app: unknown, console: unknown) => Promise<unknown>;

                const result: { return: unknown, output: string[] } = {
                    return: undefined as unknown,
                    output: [],
                };
                const log = (...args: unknown[]) => {
                    result.output.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
                };
                result.return = await fn(plugin.app, { log, warn: log, error: log, info: log, debug: log, });
                return {
                    success: true,
                    type: "object",
                    content: result,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : undefined;
                return {
                    success: false,
                    type: "text",
                    content: `JavaScript execution error: ${msg}${stack ? `\n\nStack trace:\n${stack}` : ""}`,
                };
            }
        },
    };
}
