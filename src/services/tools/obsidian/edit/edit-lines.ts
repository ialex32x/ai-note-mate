import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: edit_lines
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single line-based edit operation.
 *
 * `start_line` and `end_line` are both 1-based INCLUSIVE.
 *
 * Three operations via the optional `op` field:
 *   - **replace** (default when `op` omitted and `content != ""`):
 *     lines in [start_line, end_line] are replaced.
 *   - **delete** (default when `op` omitted and `content == ""`):
 *     lines in [start_line, end_line] are removed.
 *   - **insert_before**: content is inserted BEFORE `start_line`.
 *     `end_line` is unused. Use `start_line = totalLines + 1` to append
 *     at end of file.
 *
 * All edits in one call refer to line numbers in the SAME pre-edit snapshot
 * of the file. The tool sorts by start position descending and applies them
 * back-to-front so earlier edits never invalidate later ones' line numbers.
 * This works for mixed replace/delete/insert_before edits — everything
 * resolves correctly in one atomic call.
 */
interface LineEdit {
    op?: "replace" | "delete" | "insert_before";
    start_line: number;
    end_line?: number;
    content: string;
}

/**
 * Normalise an edit into a half-open zero-based slice [from, to) on the
 * original `lines` array, plus the replacement string.
 *
 *   replace/delete [a, b] inclusive  →  from = a-1, to = b
 *   insert_before at line a          →  from = a-1, to = a-1  (zero-width)
 */
interface NormalisedEdit {
    /** Index into `args.edits`, used purely for error reporting. */
    index: number;
    /** Original edit, kept for the result payload. */
    raw: LineEdit;
    /** Resolved operation. */
    op: "replace" | "delete" | "insert_before";
    /** Zero-based inclusive start of the slice to modify. */
    from: number;
    /** Zero-based exclusive end of the slice to modify. For inserts this equals `from`. */
    to: number;
    /** Replacement/inserted content (empty for deletions). */
    content: string;
}

const VALID_OPS = ["replace", "delete", "insert_before"] as const;

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
    if (!Number.isInteger(start)) {
        return `edits[${index}]: start_line must be an integer.`;
    }
    const s = start as number;
    if (s < 1) {
        return `edits[${index}]: start_line must be >= 1 (got ${s}).`;
    }

    // ── Resolve op ─
    let op: "replace" | "delete" | "insert_before" | undefined;
    if (typeof e["op"] === "string") {
        const rawOp = e["op"];
        if (!(VALID_OPS as readonly string[]).includes(rawOp)) {
            return `edits[${index}]: op must be one of: ${VALID_OPS.join(", ")} (got "${rawOp}").`;
        }
        op = rawOp as "replace" | "delete" | "insert_before";
    }
    if (!op) {
        // Auto-detect: empty content → delete, non-empty → replace (backward compat)
        op = content === "" ? "delete" : "replace";
    }

    // ── insert_before ─
    if (op === "insert_before") {
        if (content === "") {
            return `edits[${index}]: insert_before requires non-empty content. Use op: "delete" to remove lines.`;
        }
        if (s > totalLines + 1) {
            return (
                `edits[${index}]: start_line (${s}) exceeds max allowed ${totalLines + 1} ` +
                `for insert_before (file has ${totalLines} lines). ` +
                `Use ${totalLines + 1} to append at end of file.`
            );
        }
        return {
            index,
            raw: { start_line: s, content, op: "insert_before" },
            op: "insert_before",
            from: s - 1,
            to: s - 1, // zero-width span — splice with deleteCount=0
            content,
        };
    }

    // ── replace / delete ─
    if (!Number.isInteger(end)) {
        return `edits[${index}]: end_line must be an integer (required for ${op}).`;
    }
    const en = end as number;
    if (en < s) {
        return `edits[${index}]: end_line (${en}) must be >= start_line (${s}).`;
    }
    if (en > totalLines) {
        return (
            `edits[${index}]: end_line (${en}) exceeds total lines (${totalLines}). ` +
            `Use op: "insert_before" with start_line ${totalLines + 1} to append content at the end.`
        );
    }

    return {
        index,
        raw: { start_line: s, end_line: en, content, op },
        op,
        from: s - 1,
        to: en, // inclusive end_line → exclusive zero-based bound is en
        content,
    };
}

/**
 * Human-readable description of a normalised edit, used in error messages so
 * the model can locate the offending edit without re-reading its own args.
 */
function describeEdit(ed: NormalisedEdit): string {
    if (ed.op === "insert_before") {
        return `insert_before ${ed.raw.start_line}`;
    }
    const { start_line: s, end_line: e } = ed.raw;
    if (ed.op === "delete") {
        return `delete ${s}-${e}`;
    }
    return `replace ${s}-${e}`;
}

/**
 * Detect overlapping/conflicting edits among replace/delete operations.
 *
 * Zero-width inserts (`from === to`) don't consume pre-edit lines and
 * therefore can never overlap with anything — they are excluded from
 * the overlap sweep.
 */
function detectOverlap(edits: NormalisedEdit[]): string | null {
    // Only ranged edits (replace/delete) can overlap.
    const ranged = edits.filter((e) => e.from < e.to);
    const sorted = [...ranged].sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (cur.from < prev.to) {
            return (
                `edits[${prev.index}] (${describeEdit(prev)}) and ` +
                `edits[${cur.index}] (${describeEdit(cur)}) overlap. ` +
                `All ranged edits must reference disjoint ranges of the original file.`
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
    /** Resolved operation — "replace", "delete", or "insert_before". */
    op: "replace" | "delete" | "insert_before";
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
        const edits: AffectedRegionEdit[] = groupMembers.map((w) => ({
            input_index: w.ed.index,
            op: w.ed.op,
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
                    "Apply one or more atomic line-based edits to a file via `edits[]`. Each edit uses " +
                    "1-based physical line numbers in a closed range `[start_line, end_line]` — both bounds inclusive. " +
                    "Leading blank lines count; an empty first line IS line 1. " +
                    "\n\n" +
                    "Three operations via the optional `op` field: " +
                    "- **replace** (default when `op` omitted and `content != \"\"`): non-empty `content` → lines in [start_line, end_line] are replaced. " +
                    "- **delete** (default when `op` omitted and `content == \"\"`): `content: \"\"` → lines in [start_line, end_line] are removed. " +
                    "- **insert_before**: content is inserted BEFORE `start_line`. `end_line` is unused. " +
                    "Use `start_line = totalLines + 1` to append at end of file. " +
                    "\n\n" +
                    "You can mix all three operations in a single `edits` array — inserts, replaces, and " +
                    "deletions coexist in one atomic call. All edits' line numbers refer to the PRE-EDIT file; " +
                    "the tool applies them back-to-front so earlier edits never shift later ones. " +
                    "Ranged edits (replace/delete) must reference disjoint ranges; overlapping ranges are rejected. " +
                    "Zero-width inserts don't conflict with anything. If validation fails, nothing is written (atomic). " +
                    "Set `dry_run` to preview. " +
                    "\n\n" +
                    "Lines are 1-based physical lines split by `\\n`; leading blank lines count, and a trailing newline produces a final empty line " +
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
                                "file BEFORE any edit is applied. Ranged edits (replace/delete) must not overlap. " +
                                "Insert edits (op: insert_before) are zero-width and never conflict.",
                            items: {
                                type: "object",
                                properties: {
                                    op: {
                                        type: "string",
                                        enum: ["replace", "delete", "insert_before"],
                                        description:
                                            "Operation type. Omit to auto-detect: non-empty `content` → replace, " +
                                            "empty `content` → delete. Use \"insert_before\" to insert content " +
                                            "before `start_line` (no `end_line` needed).",
                                    },
                                    start_line: {
                                        type: "number",
                                        description:
                                            "1-based INCLUSIVE physical line number. " +
                                            "For replace/delete: start of the range to modify. " +
                                            "For insert_before: insert content BEFORE this line. " +
                                            "Use `totalLines + 1` to append at end of file. " +
                                            "Leading blank lines count; an empty first line is line 1. " +
                                            "Field name is `start_line` (with underscore). " +
                                            "LLM aliases `start` also accepted.",
                                    },
                                    end_line: {
                                        type: "number",
                                        description:
                                            "1-based INCLUSIVE physical end of the range. " +
                                            "Required for replace/delete, UNUSED for insert_before. " +
                                            "The range is [start_line, end_line] — both bounds inclusive. " +
                                            "Must be >= start_line (for replace/delete). " +
                                            "Field name is `end_line` (with underscore). " +
                                            "LLM aliases `end` also accepted.",
                                    },
                                    content: {
                                        type: "string",
                                        description:
                                            "For replace/insert_before: the new content. May be more or fewer lines " +
                                            "than the original range. For delete: pass '' (empty string). " +
                                            "Do NOT append a trailing '\\n' unless you intend an extra " +
                                            "empty line — 'X\\n' becomes two lines ['X', '']. " +
                                            "For insert_before, content must be non-empty.",
                                    },
                                },
                                required: ["start_line", "content"],
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
            // Accept both `edits` (array, canonical) and `edit` (single object, common LLM slip).
            let rawEdits = args["edits"];
            if (!rawEdits && args["edit"] && typeof args["edit"] === "object" && !Array.isArray(args["edit"])) {
                rawEdits = [args["edit"]];
            }
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
            // Zero-width inserts (from === to) splice with deleteCount=0 → pure insertion.
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
            // already ensured disjointness for ranged edits, and zero-width
            // inserts always stay correct.
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
                return {
                    kind: ed.op,
                    start_line: ed.raw.start_line,
                    ...(ed.op !== "insert_before" ? { end_line: ed.raw.end_line } : {}),
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
