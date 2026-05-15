/**
 * AI Edit History runner — performs a single rewrite request end-to-end.
 *
 * Flow (see plan §5):
 * 1. Mark task `running`.
 * 2. Resolve the active provider (validates API key indirectly).
 * 3. Stream `system + user` messages through `provider.createStream`.
 * 4. Accumulate output into `task.rewrittenText` (throttled UI updates).
 * 5. On stream completion, locate the originating editor:
 *    - if the file is gone or the captured range no longer matches the
 *      original selection, mark the task `stale` (no write-back).
 *    - otherwise, perform a single `editor.replaceRange` and mark `applied`.
 * 6. Cancellation → `cancelled`; any other error → `failed`.
 *
 * The runner deliberately does NOT touch the editor mid-stream (see plan §0
 * decision record), to keep the operation atomic and mobile-friendly.
 */

import { MarkdownView, Notice, TFile } from "obsidian";
import type { Editor, EditorPosition } from "obsidian";
import type NoteAssistantPlugin from "../main";
import { createProviderForActiveProfile } from "../utils/provider-factory";
import type { ChatMessageParam } from "../services/llm-provider";
import { t } from "../i18n";
import type { EditHistoryStore } from "./edit-history-store";
import type { EditTask } from "./edit-history-types";
import { REWRITE_PROMPTS } from "./rewrite-prompts";

/** Throttle window (ms) for streaming UI updates. */
const STREAM_UPDATE_THROTTLE_MS = 80;

/**
 * Run a single edit task. Resolves when the task has reached a terminal
 * state. Never throws — all errors flow into the task's `error` field.
 *
 * Cross-session lock check: AI Edit rewrite operates at editor level
 * (not via the vault gateway), so it does not participate in the
 * checkpoint model. But it must still RESPECT active checkpoints —
 * otherwise a user could rewrite a file that another session has
 * pending modifications on, producing surprising state. The check
 * runs once up-front; if the file is held by ANY session (including
 * the user's own AI sessions), the task moves straight to `failed`
 * with a clear diagnostic.
 */
export async function runEditTask(
    plugin: NoteAssistantPlugin,
    store: EditHistoryStore,
    task: EditTask,
    signal: AbortSignal,
): Promise<void> {
    // Refuse early if the target file is currently locked by any AI
    // session's pending checkpoint. The rewrite path has no session
    // affiliation of its own, so any holder is "other".
    if (task.filePath) {
        const holder = plugin.fileLockManager?.getHolder(task.filePath);
        if (holder) {
            const reason = t("editHistory.notice.lockConflict");
            store.update(task.id, { status: "failed", error: reason });
            notifyFailure(reason);
            return;
        }
    }

    store.update(task.id, { status: "running" });

    let pending = "";
    let lastFlush = 0;
    const flush = (force = false) => {
        const now = Date.now();
        if (!force && now - lastFlush < STREAM_UPDATE_THROTTLE_MS) return;
        if (!pending) return;
        lastFlush = now;
        const current = store.get(task.id);
        if (!current) return;
        store.update(task.id, { rewrittenText: current.rewrittenText + pending });
        pending = "";
    };

    try {
        const { provider } = createProviderForActiveProfile(plugin);

        const messages: ChatMessageParam[] = [
            { role: "system", content: REWRITE_PROMPTS[task.action] },
            { role: "user", content: task.originalText },
        ];

        for await (const chunk of provider.createStream(messages, undefined, signal)) {
            if (signal.aborted) break;
            if (chunk.content) {
                pending += chunk.content;
                flush(false);
            }
        }
        flush(true);

        if (signal.aborted) {
            store.update(task.id, { status: "cancelled" });
            return;
        }

        // ── Write back ───────────────────────────────────────────────────
        const finalTask = store.get(task.id);
        const rewritten = finalTask?.rewrittenText ?? "";
        if (!rewritten) {
            const reason = t("editHistory.notice.emptyResponse");
            store.update(task.id, { status: "failed", error: reason });
            notifyFailure(reason);
            return;
        }

        const writeResult = applyRewriteToEditor(plugin, task, rewritten);
        if (writeResult === "ok") {
            store.update(task.id, { status: "applied" });
        } else {
            store.update(task.id, { status: "stale" });
            new Notice(t("editHistory.notice.stale"));
        }
    } catch (err) {
        if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
            store.update(task.id, { status: "cancelled" });
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        store.update(task.id, { status: "failed", error: message });
        notifyFailure(message);
    }
}

/**
 * Surface a rewrite failure to the user as a transient Notice so the
 * cause is visible immediately, without having to open the AI Edit
 * History view and expand the failed row. The Notice runs slightly
 * longer than the default so longer provider messages remain readable.
 */
function notifyFailure(reason: string): void {
    const text = reason && reason.trim()
        ? t("editHistory.notice.failed", { 0: reason })
        : t("editHistory.status.failed");
    new Notice(text, 8000);
}

type WriteResult = "ok" | "stale";

/**
 * Locate the original editor and replace the captured range with `rewritten`.
 * Returns `"stale"` if either the file or the exact original text can no
 * longer be found at the captured coordinates.
 */
function applyRewriteToEditor(
    plugin: NoteAssistantPlugin,
    task: EditTask,
    rewritten: string,
): WriteResult {
    const editor = findEditorForPath(plugin, task.filePath);
    if (!editor) return "stale";

    const from: EditorPosition = { line: task.fromLine, ch: task.fromCh };
    const to: EditorPosition = { line: task.toLine, ch: task.toCh };

    let current: string;
    try {
        current = editor.getRange(from, to);
    } catch {
        return "stale";
    }

    if (current !== task.originalText) {
        return "stale";
    }

    try {
        editor.replaceRange(rewritten, from, to);
        return "ok";
    } catch {
        return "stale";
    }
}

/**
 * Look up the markdown editor that currently holds the file at `filePath`.
 *
 * Returns `null` for unsaved drafts (empty path) where there is no stable
 * way to re-find the originating leaf — in that case the task ends as
 * `stale` and the user can copy the rewritten text manually.
 */
function findEditorForPath(plugin: NoteAssistantPlugin, filePath: string): Editor | null {
    if (!filePath) return null;
    const file = plugin.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return null;

    const leaves = plugin.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file?.path === filePath) {
            return view.editor;
        }
    }
    return null;
}
