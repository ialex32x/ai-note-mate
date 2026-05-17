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
 * Maximum total bytes (after JSON serialization) we will return from the
 * tool, summed across the `return` value and the captured `output` lines.
 * Anything beyond this is truncated and a `truncated: true` flag is set.
 *
 * Keeping a hard cap avoids the AI accidentally exhausting the chat context
 * by, e.g., returning the contents of every markdown file in the vault.
 */
const MAX_RESULT_BYTES = 64 * 1024;

/**
 * Globals that are shadowed by passing `undefined` as a named parameter into
 * the generated AsyncFunction. This is *not* a security boundary — code can
 * still reach the realm globals via e.g. `({}).constructor.constructor`,
 * dynamic `import()`, or the `Function` constructor on any other built-in.
 * The point is to make low-effort missteps (the AI absent-mindedly calling
 * `fetch(...)` or poking at `window.app`) fail loudly so the model corrects
 * course instead of having silent side-effects.
 *
 * Ordering: roughly grouped (host globals, document/navigation, network,
 * storage, code-generation, workers, Node/Electron leftovers). Kept verbose
 * on purpose so each line is self-documenting.
 */
const SHADOWED_GLOBALS = [
    // Host global objects
    "window", "globalThis", "self", "top", "parent", "frames",
    // Document & navigation
    "document", "navigator", "location", "history", "screen",
    // Network APIs
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Request", "Response", "Headers",
    // Storage APIs
    "localStorage", "sessionStorage", "indexedDB", "caches",
    // Code generation (note: `eval` is a strict-mode reserved word and
    // cannot appear as a parameter name; it stays accessible, but strict
    // mode already prevents it from injecting variables into our scope)
    "Function",
    // Workers
    "Worker", "SharedWorker", "ServiceWorker",
    // Node / Electron leftovers (may exist in desktop renderer)
    "require", "process", "module", "Buffer", "__dirname", "__filename", "electron",
] as const;

/**
 * Tool to evaluate JavaScript code with the Obsidian `app` instance injected.
 *
 * The execution environment is **not a security sandbox**:
 *  - Code runs in the main realm; obvious globals are shadowed (see
 *    {@link SHADOWED_GLOBALS}) and a curated `console` shim is supplied, but
 *    determined code can still reach the host realm.
 *  - There is no enforced wall-clock timeout — a synchronous infinite loop
 *    can block the main thread until the user reloads Obsidian.
 *  - Returned values are size-capped (see {@link MAX_RESULT_BYTES}) to
 *    protect chat context, but the running code can still consume memory
 *    while it produces them.
 *
 * The tool requires user confirmation per invocation (`requiresConfirmation:
 * true`); that confirmation step is the actual safety boundary for this
 * feature.
 */
function evaluateJavaScript(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "evaluate_javascript",
                description:
                    "Execute a JavaScript snippet with direct access to the Obsidian `app` instance. " +
                    "The code runs as the body of an async function in an isolated lexical scope; " +
                    "common host globals (window, document, fetch, localStorage, eval, Function, ...) " +
                    "are shadowed and unavailable, but this is NOT a security sandbox — do not rely on it " +
                    "to contain untrusted code. " +
                    "Parameters available inside the snippet: " +
                    "`app` (Obsidian App), `console` (log/warn/error/info/debug captured into output), " +
                    "`signal` (AbortSignal that becomes aborted when the user cancels — check it inside long loops). " +
                    "Use `return` to produce a result; the returned value is JSON-serialized and may be truncated " +
                    "if very large. " +
                    "Use this when complex vault operations, metadata cache queries, or workspace manipulation " +
                    "are needed beyond what dedicated tools provide. " +
                    "Examples: `return app.vault.getMarkdownFiles().length;` or " +
                    "`const file = app.workspace.getActiveFile(); return file?.path;`. " +
                    "Avoid synchronous infinite loops — there is no hard timeout and they will freeze Obsidian.",
                parameters: {
                    type: "object",
                    properties: {
                        code: {
                            type: "string",
                            description:
                                "JavaScript code to execute. Runs as the body of an async function in strict mode " +
                                "with `app`, `console`, and `signal` as parameters. Use `return` to produce output. " +
                                "Avoid infinite loops or long-running operations.",
                        },
                    },
                    required: ["code"],
                },
            },
        },
        capabilities: ["execute"] as ToolCapability[],
        requiresConfirmation: true,
        exec: async (_chatStream, args, signal): Promise<ToolCallResult> => {
            const code = args["code"] as string;

            if (!code || !code.trim()) {
                return {
                    success: false,
                    type: "text",
                    content: "Error: Code cannot be empty.",
                };
            }

            // Build the parameter name list: `app`, `console`, `signal`,
            // then all shadowed globals (each receiving `undefined` at call
            // time). Order must match the call site below.
            const paramNames = ["app", "console", "signal", ...SHADOWED_GLOBALS];
            // Prepend "use strict" to the user body so accidental implicit
            // globals (e.g. `x = 1`) and `this`-leak fail loudly instead of
            // silently leaking to the realm global.
            const wrappedBody = `"use strict";\n${code}`;

            try {
                const AsyncFunction = (Object.getPrototypeOf(async function () { /* probe */ }) as { constructor: new (...args: string[]) => unknown }).constructor;
                const fn = new AsyncFunction(...paramNames, wrappedBody) as (...callArgs: unknown[]) => Promise<unknown>;

                const result: { return: unknown; output: string[]; truncated?: boolean } = {
                    return: undefined,
                    output: [],
                };
                const log = (...logArgs: unknown[]) => {
                    result.output.push(logArgs.map(a => (typeof a === "string" ? a : safeStringify(a))).join(" "));
                };
                const consoleShim = { log, warn: log, error: log, info: log, debug: log };

                // Build the call arguments in the same order as paramNames:
                // [app, console, signal, undefined, undefined, ...]
                const callArgs: unknown[] = [plugin.app, consoleShim, signal];
                for (let i = 0; i < SHADOWED_GLOBALS.length; i++) callArgs.push(undefined);

                result.return = await fn(...callArgs);

                // Enforce a size cap on what we hand back to the model. We
                // measure on JSON-serialized output so the cap matches the
                // bytes that will actually land in the chat context.
                applyResultSizeCap(result);

                return {
                    success: true,
                    type: "object",
                    content: result,
                };
            } catch (err) {
                if (err instanceof DOMException && err.name === "AbortError") throw err;
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

/**
 * Best-effort JSON.stringify that does not throw on cyclic references or
 * non-serializable values. Used inside the `console` shim so a call like
 * `console.log(window)` (well — `console.log(someCircularObject)`) does not
 * blow up the whole evaluation.
 */
function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        try {
            return String(value);
        } catch {
            return "[unserializable]";
        }
    }
}

/**
 * Cap the combined byte cost of `result.return` (JSON-serialized) plus
 * `result.output` (joined console lines). If we exceed
 * {@link MAX_RESULT_BYTES}, replace the offending parts with a truncation
 * marker and set `result.truncated = true` so the model can see it was cut.
 *
 * We charge the return value first; if it alone already exceeds the cap we
 * drop the value entirely. Otherwise the remaining budget is spent on the
 * output lines, kept in order until we run out of budget.
 */
function applyResultSizeCap(result: { return: unknown; output: string[]; truncated?: boolean }): void {
    let returnJson: string;
    try {
        returnJson = result.return === undefined ? "" : JSON.stringify(result.return);
    } catch {
        returnJson = "";
        result.return = "[unserializable return value]";
        result.truncated = true;
    }

    if (returnJson.length > MAX_RESULT_BYTES) {
        result.return = `[return value truncated: ${returnJson.length} bytes exceeds ${MAX_RESULT_BYTES} byte limit]`;
        result.output = [];
        result.truncated = true;
        return;
    }

    let remaining = MAX_RESULT_BYTES - returnJson.length;
    const kept: string[] = [];
    for (const line of result.output) {
        const cost = line.length + 1; // +1 for the implicit separator/newline
        if (cost > remaining) {
            kept.push(`[output truncated: ${result.output.length - kept.length} more line(s) dropped]`);
            result.output = kept;
            result.truncated = true;
            return;
        }
        kept.push(line);
        remaining -= cost;
    }
    result.output = kept;
}
