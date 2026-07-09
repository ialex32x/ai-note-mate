/**
 * Centralised debug-logging utility.
 *
 * This is the single module in the project that is allowed to call
 * `console.*` directly — every other file should use this abstraction
 * instead. The `debug()` and `info()` methods are gated by
 * `settings.debugEnabled` so verbose diagnostic output stays off by
 * default and does not clutter the developer console for end users.
 */

// ─────────────────────────────────────────────
// Module-level debug-enablement getter
// ─────────────────────────────────────────────

type DebugGetter = () => boolean;

let _debugGetter: DebugGetter | null = null;

/**
 * Register a function that returns the current value of
 * {@link NoteAssistantPluginSettings.debugEnabled}.
 *
 * Called once from {@link NoteAssistantPlugin.onload} after settings are
 * loaded. Subsequent calls replace the previous getter (last-write-wins).
 */
export function setDebugEnabledGetter(getter: DebugGetter): void {
	_debugGetter = getter;
}

/** Resolve the current debug-enabled flag. */
function isDebugEnabled(): boolean {
	return _debugGetter?.() ?? false;
}

// ─────────────────────────────────────────────
// Logger type & factory
// ─────────────────────────────────────────────

export interface ScopedLogger {
	/** Debug-level diagnostic message. Emitted only when debug mode is on. */
	debug(...args: unknown[]): void;
	/** Informational message. Emitted only when debug mode is on. */
	info(...args: unknown[]): void;
	/** Warning message. Always emitted. */
	warn(...args: unknown[]): void;
	/** Error message. Always emitted. */
	error(...args: unknown[]): void;
}

/**
 * Create a logger instance that prefixes every message with `[prefix]`.
 *
 * @example
 * const log = logger("[openai-provider]");
 * log.debug("Fetching models from", baseUrl);
 * log.warn("Retry 2: timeout");
 */
export function logger(prefix: string): ScopedLogger {
	return {
		debug(...args: unknown[]): void {
			if (isDebugEnabled()) {
				console.debug(prefix, ...args);
			}
		},
		info(...args: unknown[]): void {
			if (isDebugEnabled()) {
				console.debug(prefix, ...args);
			}
		},
		warn(...args: unknown[]): void {
			console.warn(prefix, ...args);
		},
		error(...args: unknown[]): void {
			console.error(prefix, ...args);
		},
	};
}

// ─────────────────────────────────────────────
// Shared retry-logger helper
// ─────────────────────────────────────────────

/**
 * Return a callback suitable for `fetchWithRetry`'s `onRetry` option.
 *
 * Produces messages like `[openai-provider] createStream retry 1: timeout`.
 *
 * @param tag  - Module identifier, e.g. `"[openai-provider]"`.
 * @param ctx  - Operation name, e.g. `"createStream"`, `"listModels"`.
 * @returns A function `(err: unknown, attempt: number) => void`.
 */
export function retryLogger(tag: string, ctx: string): (err: unknown, attempt: number) => void {
	return (err: unknown, n: number) => {
		console.warn(`${tag} ${ctx} retry ${n}: ${err instanceof Error ? err.message : String(err)}`);
	};
}
