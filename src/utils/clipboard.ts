/**
 * Write text to the system clipboard with a consistent UX:
 *
 * - Shows a short confirmation Notice (`view.copied`) on success by default.
 * - Logs failures to the console so they're visible during development, but
 *   never throws — clipboard writes fail in locked-down environments and we
 *   don't want a copy button to tear down the surrounding UI.
 *
 * Call sites that want to render their own feedback (e.g. swap a button's
 * icon to a checkmark) should pass `{ showNotice: false }` so the Notice
 * doesn't compete with that inline cue.
 */

import { Notice } from "obsidian";
import { t } from "../i18n";

export interface CopyToClipboardOptions {
    /**
     * Whether to show a "Copied to clipboard" Notice on success.
     * Default: `true`. Set to `false` when the call site provides its own
     * visual feedback (e.g. icon swap, button label change).
     */
    showNotice?: boolean;
    /**
     * Console log level to use when `writeText` rejects.
     * Default: `'error'`. A handful of call sites historically used `'warn'`
     * (the failure is expected in some contexts); keep that option available.
     */
    logLevel?: "error" | "warn" | "none";
}

/**
 * Best-effort copy to the system clipboard. Returns `true` on success and
 * `false` if the write was rejected (e.g. no clipboard permission, no
 * secure context). Never throws.
 */
export async function copyToClipboard(
    text: string,
    options: CopyToClipboardOptions = {}
): Promise<boolean> {
    const { showNotice = true, logLevel = "error" } = options;
    try {
        await navigator.clipboard.writeText(text);
        if (showNotice) {
            new Notice(t("view.copied"));
        }
        return true;
    } catch (err) {
        if (logLevel === "error") {
            console.error("Failed to copy to clipboard:", err);
        } else if (logLevel === "warn") {
            console.warn("Failed to copy to clipboard:", err);
        }
        return false;
    }
}
