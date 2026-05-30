import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: edit_lines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single line-based edit operation. Unified shape — no `op` field:
 *   - { start_line, end_line, content }
 *
 * `start_line` is 1-based inclusive; `end_line` is 1-based EXCLUSIVE.
 * The range [start_line, end_line) specifies which lines are replaced.
 *
 *   - Insert:  start_line == end_line, content != "" → content placed BEFORE
 *              that line (replace 0 lines). Use start_line = totalLines + 1
 *              to append at end of file.
 *   - Replace: end_line > start_line, content != "" → those lines are replaced.
 *   - Delete:  end_line > start_line, content == ""  → those lines are removed.
 *
 * All edits in one call refer to line numbers in the SAME pre-edit snapshot
 * of the file. The tool sorts by start position descending and applies them
 * back-to-front so earlier edits never invalidate later ones' line numbers.
 */
interface LineEdit {
    start_line: number;
    end_line: number;
    content: string;
}

/**
 * Normalise an edit into a half-open zero-based slice [from, to) on the
 * original `lines` array, plus the replacement string.
 *
 *   edit [a, b)  →  from = a-1, to = b-1
 *   (When a == b, from == to → zero-length slice = insert.)
 *
 * This unification lets overlap detection and back-to-front application
 * treat insert/replace/delete with identical logic.
 */
interface NormalisedEdit {
    /** Index into `args.edits`, used purely for error reporting. */
    index: number;
    /** Original edit, kept for the result payload. */
    raw: LineEdit;
    /** Zero-based, inclusive start of the slice to replace. */
    from: number;
    /** Zero-based, exclusive end of the slice to replace. */
    to: number;
    /** Replacement content (may be empty for deletions; insert always has content). */
    content: string;
}

function normaliseEdit(edit: unknown, index: number, totalLines: number): NormalisedEdit | string {
    if (!edit || typeof edit !== "object") {
        return `edits[${index}] must be an object.`;
    }
    const e = edit as Record<string, unknown>;

    // Accept common LLM aliases (start → start_line, end → end_line)
    const start = e["start_line"] ?? e["start"];
    const end = e["end_line"] ?? e["end"];
    const content = e["content"];

    if (typeof content !== "string") {
        return `edits[${index}]: content must be a string.`;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
        return `edits[${index}]: start_line and end_line must be integers.`;
    }
    const s = start as number;
    const en = end as number;

    if (s < 1) {
        return `edits[${index}]: start_line must be >= 1 (got ${s}).`;
    }
    if (en < s) {
        return `edits[${index}]: end_line (${en}) must be >= start_line (${s}).`;
    }
    if (en > totalLines + 1) {
        return `edits[${index}]: end_line (${en}) exceeds allowed maximum ${totalLines + 1} (file has ${totalLines} lines; use ${totalLines + 1} to insert at end).`;
    }
    // Empty insert is a no-op — reject.
    if (s === en && content === "") {
        return `edits[${index}]: start_line equals end_line with empty content — this is a no-op. Drop the edit, or provide content to insert.`;
    }

    return {
        index,
        raw: { start_line: s, end_line: en, content },
        from: s - 1,
        to: en - 1,
        content,
    };
}

/**
 * Human-readable description of a normalised edit, used in error messages so
 * the model can locate the offending edit without re-reading its own args.
 *   insert  → "insert before 8"
 *   replace → "replace 5-7"
 *   delete  → "delete 5-7"
 */
function describeEdit(ed: NormalisedEdit): string {
    const { start_line: s, end_line: e } = ed.raw;
    if (s === e) {
        return `insert before ${s}`;
    }
    const lastLine = e - 1; // end_line is exclusive, so the last replaced line is e-1
    if (ed.content === "") {
        return `delete ${s}-${lastLine}`;
    }
    return `replace ${s}-${lastLine}`;
}

/**
 * Detect overlapping/conflicting edits.
 *
 * Edits are sorted by `from` ascending; we then walk and ensure each next
 * edit starts at or after the previous one's `to`. Two edge cases on
 * zero-length (insert) slices:
 *
 *   - Two inserts AT THE SAME POSITION are ambiguous in ordering and we
 *     reject them. The model should merge them into one insert.
 *   - An insert exactly at the boundary of a replace (e.g. insert before
 *     line 5, replace [5, 7]) is allowed: `prev.to === next.from` is fine.
 */
function detectOverlap(edits: NormalisedEdit[]): string | null {
    const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        // Two inserts at the same anchor: ambiguous order, reject.
        if (prev.from === prev.to && cur.from === cur.to && prev.from === cur.from) {
            return (
                `edits[${prev.index}] (${describeEdit(prev)}) and ` +
                `edits[${cur.index}] (${describeEdit(cur)}) ` +
                `both insert at the same position; merge them into a single insert.`
            );
        }
        if (cur.from < prev.to) {
            return (
                `edits[${prev.index}] (${describeEdit(prev)}) and ` +
                `edits[${cur.index}] (${describeEdit(cur)}) overlap. ` +
                `All edits must reference disjoint ranges of the original file.`
            );
        }
    }
    return null;
}

/** Number of context lines to include on each side of an affected region. */
const AFFECTED_CONTEXT_LINES = 3;

/**
 * Per-edit entry inside an `AffectedRegion`. `input_index` lets the model map
 * the entry back to the corresponding item in its `edits` argument array,
 * since merging may reorder edits relative to input order.
 */
interface AffectedRegionEdit {
    /** Index of this edit in the caller's `edits` array. */
    input_index: number;
    /** Derived kind — "insert", "replace", or "delete" (computed, NOT an input field). */
    op: "insert" | "replace" | "delete";
    /**
     * 1-based inclusive line range in the post-edit file covering exactly
     * this edit's new content. `null` when the edit produced no post-edit
     * lines (e.g. a pure deletion); the surrounding `snippet` still shows
     * the deletion site via context lines.
     */
    new_range: [number, number] | null;
}

/**
 * A contiguous slice of the post-edit file that covers one or more edits and
 * their context windows. Adjacent or overlapping per-edit windows (within
 * ±AFFECTED_CONTEXT_LINES) are merged into a single region so that callers
 * never see duplicated content across regions.
 */
interface AffectedRegion {
    /** Snippet of the post-edit file covering all member edits ± context. */
    snippet: string;
    /** 1-based inclusive line range covered by `snippet`. `[0, 0]` if file is empty. */
    snippet_range: [number, number];
    /** All edits whose context windows fall inside this region, in post-edit order. */
    edits: AffectedRegionEdit[];
}

/**
 * Per-edit window in post-edit coordinates, used as input to region merging.
 * `winFrom` / `winToExcl` are zero-based half-open and already clamped to
 * file bounds; `newFrom` / `newToExcl` mark the edit's own new content slice
 * (without context padding).
 */
interface EditWindow {
    ed: NormalisedEdit;
    winFrom: number;
    winToExcl: number;
    newFrom: number;
    newToExcl: number;
}

/**
 * Merge per-edit windows whose snippet ranges touch or overlap into one
 * contiguous region per group, then materialise the snippet text from the
 * post-edit `workingLines`.
 *
 * Touching windows (`next.winFrom === prev.winToExcl`) are merged too: there
 * is zero gap of context between them, so emitting two regions would just
 * duplicate the boundary semantics without adding context.
 */
function buildAffectedRegions(windows: EditWindow[], workingLines: string[]): AffectedRegion[] {
    if (windows.length === 0) return [];

    // Sort by post-edit position so the merge sweep is monotonic.
    const sorted = [...windows].sort(
        (a, b) => a.winFrom - b.winFrom || a.winToExcl - b.winToExcl
    );

    const regions: AffectedRegion[] = [];
    let groupFrom = sorted[0]!.winFrom;
    let groupToExcl = sorted[0]!.winToExcl;
    let groupMembers: EditWindow[] = [sorted[0]!];

    const flush = () => {
        const snippetLines = workingLines.slice(groupFrom, groupToExcl);
        const snippetRange: [number, number] =
            snippetLines.length > 0
                ? [groupFrom + 1, groupFrom + snippetLines.length]
                : [0, 0];
        // Member edits are already in post-edit order from the outer sort.
        const edits: AffectedRegionEdit[] = groupMembers.map((w) => ({
            input_index: w.ed.index,
            op: w.ed.to === w.ed.from
                ? "insert"
                : w.ed.content === ""
                ? "delete"
                : "replace",
            new_range:
                w.newToExcl > w.newFrom ? [w.newFrom + 1, w.newToExcl] : null,
        }));
        regions.push({
            snippet: snippetLines.join("\n"),
            snippet_range: snippetRange,
            edits,
        });
    };

    for (let i = 1; i < sorted.length; i++) {
        const w = sorted[i]!;
        // Touching (`<=`) windows are merged: the boundary line would otherwise
        // appear in both regions' snippets.
        if (w.winFrom <= groupToExcl) {
            groupToExcl = Math.max(groupToExcl, w.winToExcl);
            groupMembers.push(w);
        } else {
            flush();
            groupFrom = w.winFrom;
            groupToExcl = w.winToExcl;
            groupMembers = [w];
        }
    }
    flush();

    return regions;
}

export function vaultEditLines(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "edit_lines",
                description:
                    "Apply one or more atomic line-based edits to a file via `edits[]`. Each edit uses a " +
                    "1-based half-open range `[start_line, end_line)` — i.e. lines from `start_line` up to " +
                    "but NOT including `end_line` are replaced with `content`. " +
                    "\n\n" +
                    "Three operations via one shape (no `op` field needed): " +
                    "- **Insert**: `start_line == end_line`, non-empty `content` → content placed BEFORE that line. " +
                    "Use `start_line = end_line = totalLines + 1` to append at end of file. " +
                    "- **Replace**: `end_line > start_line`, non-empty `content` → those lines replaced. " +
                    "- **Delete**: `end_line > start_line`, `content: \"\"` → those lines removed. " +
                    "\n\n" +
                    "All edits' line numbers refer to the PRE-EDIT file; the tool applies them back-to-front " +
                    "so earlier edits never shift later ones. Edits must reference disjoint ranges; " +
                    "overlapping edits are rejected. If validation fails, nothing is written (atomic). " +
                    "Set `dry_run` to preview. " +
                    "\n\n" +
                    "Lines are 1-based and split by `\\n`; a trailing newline produces a final empty line " +
                    "that DOES count toward the total. Run `read_file` first to verify line numbers — do " +
                    "not guess. " +
                    "\n\n" +
                    "RETURN: `affected_regions` lists post-edit snippets (±3 lines of context, adjacent " +
                    "windows merged) with each contained edit's `input_index` (back-reference into your " +
                    "`edits` array) and `new_range` (1-based post-edit range, null for pure deletions) — " +
                    "use this to verify without re-reading. Response also echoes `previous_mtime` / " +
                    "`new_mtime` for chaining into the next tool's `expected_pre_edit_mtime`.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        edits: {
                            type: "array",
                            minItems: 1,
                            description:
                                "List of edits to apply atomically. Each edit's line numbers refer to the " +
                                "file BEFORE any edit is applied. Edits must not overlap.",
                            items: {
                                type: "object",
                                properties: {
                                    start_line: {
                                        type: "number",
                                        description:
                                            "1-based INCLUSIVE start of the range to replace. " +
                                            "When equal to end_line, zero lines are replaced (insert). " +
                                            "Field name is `start_line` (with underscore). " +
                                            "LLM aliases `start` also accepted.",
                                    },
                                    end_line: {
                                        type: "number",
                                        description:
                                            "1-based EXCLUSIVE end of the range to replace. " +
                                            "Lines from start_line up to but NOT including end_line " +
                                            "are replaced. When equal to start_line, zero lines are " +
                                            "replaced (insert at that position). To append at end of " +
                                            "file, set both to totalLines + 1. " +
                                            "Field name is `end_line` (with underscore). " +
                                            "LLM aliases `end` also accepted.",
                                    },
                                    content: {
                                        type: "string",
                                        description:
                                            "Replacement / insertion content. May be more or fewer " +
                                            "lines than the original range. Pass '' (empty string) to " +
                                            "delete the range (only valid when end_line > start_line). " +
                                            "Do NOT append a trailing '\\n' unless you intend an extra " +
                                            "empty line — 'X\\n' becomes two lines ['X', ''].",
                                    },
                                },
                                required: ["start_line", "end_line", "content"],
                            },
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and preview the result without modifying the file. " +
                                "Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Optional Unix ms; the file's expected current `mtime`. If actual on-disk " +
                                "`mtime` differs, the call fails (concurrent-edit guard). Chain from a prior " +
                                "read tool's `mtime` or another write tool's `new_mtime`.",
                        },
                    },
                    required: ["path", "edits"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawEdits = args["edits"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
                return { success: false, type: "text", content: "`edits` must be a non-empty array." };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            const previousMtime = file.stat.mtime;
            if (
                expectedPreEditMtime !== undefined
                && expectedPreEditMtime !== previousMtime
            ) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`expected_pre_edit_mtime\` mismatch: caller believes file mtime is ${expectedPreEditMtime}, ` +
                        `but actual mtime is ${previousMtime}. This usually means the file was modified ` +
                        `between your read and this write. Re-read the file (its envelope reports the new mtime) ` +
                        `and retry with the updated content.`,
                };
            }

            const original = await plugin.app.vault.read(file);
            const lines = original.split("\n");
            const totalLines = lines.length;

            // Validate every edit against the SAME pre-edit snapshot.
            const normalised: NormalisedEdit[] = [];
            for (let i = 0; i < rawEdits.length; i++) {
                const result = normaliseEdit(rawEdits[i], i, totalLines);
                if (typeof result === "string") {
                    return { success: false, type: "text", content: result };
                }
                normalised.push(result);
            }

            const overlapErr = detectOverlap(normalised);
            if (overlapErr) {
                return { success: false, type: "text", content: overlapErr };
            }

            // Apply back-to-front so each splice doesn't shift earlier indices.
            const sortedDesc = [...normalised].sort((a, b) => b.from - a.from || b.to - a.to);
            const working = lines.slice();
            for (const ed of sortedDesc) {
                const replacementLines = ed.content === "" && ed.from < ed.to
                    ? [] // pure deletion of a range
                    : ed.content.split("\n");
                working.splice(ed.from, ed.to - ed.from, ...replacementLines);
            }

            const resultContent = working.join("\n");
            const newTotalLines = working.length;

            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "edit_lines",
                    perform: async () => { await plugin.app.vault.modify(file, resultContent); },
                });
                if (lockErr) return lockErr;
            }

            const newMtime = dryRun ? previousMtime : file.stat.mtime;

            // ── Build per-edit summaries and post-edit affected regions ────────
            //
            // Translate each edit's pre-edit slice [from, to) into post-edit
            // coordinates by accumulating length deltas of all edits that lie
            // strictly earlier in the file. Sorting ascending by `from` makes
            // the running offset trivially correct, since detectOverlap has
            // already ensured disjointness (modulo zero-length boundaries).
            const sortedAsc = [...normalised].sort((a, b) => a.from - b.from || a.to - b.to);
            const totalNew = working.length;
            const editWindows: EditWindow[] = [];
            let cumulativeDelta = 0;
            for (const ed of sortedAsc) {
                const newLineCount =
                    ed.content === "" && ed.from < ed.to ? 0 : ed.content.split("\n").length;
                const oldLineCount = ed.to - ed.from;
                const newFrom = ed.from + cumulativeDelta;
                const newToExcl = newFrom + newLineCount;
                // Clamp the context window to file bounds so two edits near the
                // same edge don't produce overlapping out-of-bounds windows.
                const winFrom = Math.max(0, newFrom - AFFECTED_CONTEXT_LINES);
                const winToExcl = Math.min(totalNew, newToExcl + AFFECTED_CONTEXT_LINES);
                editWindows.push({ ed, winFrom, winToExcl, newFrom, newToExcl });
                cumulativeDelta += newLineCount - oldLineCount;
            }

            // Summarise applied edits in input order for clarity.
            const applied = normalised.map((ed) => {
                const replaced = ed.to - ed.from;
                const inserted = ed.content === "" ? 0 : ed.content.split("\n").length;
                const kind: "insert" | "replace" | "delete" =
                    replaced === 0 ? "insert" :
                    ed.content === "" ? "delete" : "replace";
                return {
                    kind,
                    start_line: ed.raw.start_line,
                    end_line: ed.raw.end_line,
                    replaced_lines_count: replaced,
                    new_lines_count: inserted,
                };
            });

            // Affected regions, with adjacent/overlapping snippet windows merged.
            // Order is by post-edit position (ascending), not input order.
            const affectedRegions = buildAffectedRegions(editWindows, working);

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_lines_edit" : "lines_edited",
                    path,
                    edits_applied: applied,
                    previous_total_lines: totalLines,
                    new_total_lines: newTotalLines,
                    previous_mtime: previousMtime,
                    new_mtime: newMtime,
                    dry_run: dryRun,
                    affected_regions: affectedRegions,
                    ...(dryRun ? { preview: resultContent } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}
