import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: replace_text
//
// Single-file, multi-replacement literal text editor. Each item in
// `replacements` is matched against the SAME pre-edit snapshot of the file,
// overlap is detected up-front, and all spans are rewritten back-to-front in
// one atomic write — mirroring the `edit_lines` design so the model only has
// to learn one editing pattern.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shape of one entry in the `replacements` array (documentation only — the
 * tool receives these as raw JSON and validates each field manually in
 * {@link normaliseReplacement}). Semantics:
 *   - `search` is matched literally (no regex). Empty strings are rejected.
 *   - `replace` is the replacement string; "" means "delete the match".
 *   - `replace_all` toggles between "first occurrence only" (default) and
 *     "every occurrence in the file".
 *   - `expected_count` is an optional assertion on how many occurrences the
 *     model expects to see in the pre-edit file. Mismatch → the whole call
 *     fails before anything is written. This is the cheapest way to catch
 *     "I thought this term appeared once but it's everywhere" mistakes.
 *   - `force` per-item: lifts the tag-token guard for THIS replacement only.
 */

/** A single concrete span scheduled to be rewritten in the file. */
interface Span {
    /** Index into `replacements`, used for error messages and the result payload. */
    repIndex: number;
    /** Inclusive start offset in the pre-edit content. */
    from: number;
    /** Exclusive end offset in the pre-edit content. */
    to: number;
    /** Replacement string for this span. */
    replace: string;
}

/** Per-replacement summary returned to the caller. */
interface ReplacementSummary {
    index: number;
    search: string;
    replace: string;
    occurrences_found: number;
    occurrences_replaced: number;
    replace_all: boolean;
}

/** Soft guard: same shape as the pre-array version — see description below. */
const TAG_TOKEN_RE = /^#[\p{L}\p{N}_][\p{L}\p{N}_\-/]*$/u;

function isTagShaped(s: string): boolean {
    return TAG_TOKEN_RE.test(s.trim());
}

/**
 * Validate one raw replacement entry into a normalised form, or return an
 * error string for the caller to surface. Validation is intentionally strict
 * (typeof checks on every field) because the LLM emits these as JSON and
 * silent coercion has historically caused real-world miscalls.
 */
function normaliseReplacement(
    raw: unknown,
    index: number,
): { search: string; replace: string; replaceAll: boolean; expectedCount: number | null; force: boolean } | string {
    if (!raw || typeof raw !== "object") {
        return `replacements[${index}] must be an object.`;
    }
    const r = raw as Record<string, unknown>;

    const search = r["search"];
    const replace = r["replace"];
    if (typeof search !== "string") {
        return `replacements[${index}].search must be a string.`;
    }
    if (search === "") {
        return `replacements[${index}].search must not be empty.`;
    }
    if (typeof replace !== "string") {
        return `replacements[${index}].replace must be a string.`;
    }

    const replaceAllRaw = r["replace_all"];
    if (replaceAllRaw !== undefined && typeof replaceAllRaw !== "boolean") {
        return `replacements[${index}].replace_all must be a boolean if provided.`;
    }
    const replaceAll = replaceAllRaw ?? false;

    const expectedRaw = r["expected_count"];
    let expectedCount: number | null = null;
    if (expectedRaw !== undefined && expectedRaw !== null) {
        if (!Number.isInteger(expectedRaw) || (expectedRaw as number) < 0) {
            return `replacements[${index}].expected_count must be a non-negative integer if provided.`;
        }
        expectedCount = expectedRaw as number;
    }

    const forceRaw = r["force"];
    if (forceRaw !== undefined && typeof forceRaw !== "boolean") {
        return `replacements[${index}].force must be a boolean if provided.`;
    }
    const force = forceRaw ?? false;

    return { search, replace, replaceAll, expectedCount, force };
}

/**
 * Find every literal occurrence of `needle` in `haystack`. Standard
 * non-overlapping scan: after a hit we advance by `needle.length`, so
 * `findAll("aaaa", "aa")` returns positions [0, 2], not [0, 1, 2].
 */
function findAllOccurrences(haystack: string, needle: string): number[] {
    const out: number[] = [];
    let from = 0;
    while (true) {
        const idx = haystack.indexOf(needle, from);
        if (idx < 0) break;
        out.push(idx);
        from = idx + needle.length;
    }
    return out;
}

/**
 * Detect overlapping spans across replacements. Two spans from DIFFERENT
 * replacement entries that touch the same byte range are an ambiguous spec
 * and we reject the whole call — letting "first wins" silently win is the
 * exact class of bug that makes batch editors dangerous.
 *
 * Spans from the SAME replacement cannot overlap by construction
 * (findAllOccurrences already advances past each hit), so we only need to
 * check across pairs.
 */
function detectSpanOverlap(spans: Span[]): string | null {
    const sorted = [...spans].sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (cur.from < prev.to) {
            return (
                `replacements[${prev.repIndex}] and replacements[${cur.repIndex}] match overlapping ` +
                `text ranges in the file (offsets ${prev.from}-${prev.to} vs ${cur.from}-${cur.to}). ` +
                `Make the search strings disjoint, or merge the two replacements into one.`
            );
        }
    }
    return null;
}

export function vaultReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "replace_text",
                description:
                    "Apply one or more literal find-and-replace edits to a single file in one atomic operation. " +
                    "Each entry in `replacements` searches the file's ORIGINAL content (before any edit in this call is applied), " +
                    "so the order of entries does not matter and earlier replacements never invalidate later ones. " +
                    "\n\n" +
                    "IMPORTANT: When you need multiple text replacements in the same file, you MUST submit them ALL " +
                    "in a single call via the `replacements` array. Do NOT split them across multiple calls — " +
                    "after the first call the file content has shifted and your second call's `search` may either " +
                    "miss its target or match unintended text. " +
                    "\n\n" +
                    "All matched ranges across replacements must be disjoint; overlapping matches are rejected and " +
                    "nothing is written. Set `dry_run` to true to preview without modifying the file. " +
                    "\n\n" +
                    "WHEN TO USE WHICH TOOL: " +
                    "Prefer `edit_file_tags` for tag add/remove/set on specific notes, and `rename_tag` for " +
                    "vault-wide tag rename — text-level edits cannot reliably tell '#X' from '#XYZ' and may " +
                    "corrupt YAML frontmatter. " +
                    "Prefer `edit_lines` when you know the exact line range to rewrite, insert, or delete. " +
                    "Use `replace_text` for unstructured literal edits (typos, term renames, deleting a specific phrase). " +
                    "\n\n" +
                    "TAG GUARD: when a `search` looks like a single tag token (e.g. '#foo'), this tool refuses " +
                    "that entry by default because raw text replace can partial-match (e.g. '#foo' inside '#foobar') " +
                    "and corrupt frontmatter. Set that entry's `force=true` if you really intend a raw text replace " +
                    "(running with `dry_run=true` first is recommended).",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        replacements: {
                            type: "array",
                            minItems: 1,
                            description:
                                "List of literal find-and-replace edits to apply atomically. Each entry's `search` " +
                                "is matched against the file's original content (before any edit in this call). " +
                                "Matched ranges across all entries must be disjoint.",
                            items: {
                                type: "object",
                                properties: {
                                    search: {
                                        type: "string",
                                        description: "Exact text to search for. Must not be empty. No regex.",
                                    },
                                    replace: {
                                        type: "string",
                                        description:
                                            "Replacement text. Use empty string to delete the matched text.",
                                    },
                                    replace_all: {
                                        type: "boolean",
                                        description:
                                            "If true, replace every occurrence of `search` in the file. " +
                                            "Defaults to false (replace the first occurrence only).",
                                    },
                                    expected_count: {
                                        type: "integer",
                                        minimum: 0,
                                        description:
                                            "Optional assertion: the number of occurrences of `search` you expect " +
                                            "to find in the pre-edit file. If the actual count differs, the whole " +
                                            "call fails before any write. Use this when you want to be certain a " +
                                            "term appears exactly N times (typically 1).",
                                    },
                                    force: {
                                        type: "boolean",
                                        description:
                                            "If true, bypass the tag-shape safety guard for this entry only. " +
                                            "Defaults to false. Use only when you have verified the impact " +
                                            "(e.g. via a `dry_run=true` call first).",
                                    },
                                },
                                required: ["search", "replace"],
                            },
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and preview the result without modifying the file. " +
                                "Defaults to false.",
                        },
                    },
                    required: ["path", "replacements"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const rawReplacements = args["replacements"];
            const dryRun = (args["dry_run"] as boolean) ?? false;

            if (!Array.isArray(rawReplacements) || rawReplacements.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content: "`replacements` must be a non-empty array.",
                };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;

            // Validate every entry up-front so we never partially apply.
            const normalised: ReturnType<typeof normaliseReplacement>[] = [];
            for (let i = 0; i < rawReplacements.length; i++) {
                const result = normaliseReplacement(rawReplacements[i], i);
                if (typeof result === "string") {
                    return { success: false, type: "text", content: result };
                }
                normalised.push(result);
            }

            // Tag-shape soft guard, applied per entry. Each entry can be
            // individually overridden with `force: true`. We surface ALL
            // refusals in one message so the model can fix them together
            // rather than discovering them one round-trip at a time.
            const tagRefusals: string[] = [];
            for (let i = 0; i < normalised.length; i++) {
                const n = normalised[i] as Exclude<typeof normalised[number], string>;
                if (!n.force && isTagShaped(n.search)) {
                    tagRefusals.push(
                        `replacements[${i}].search='${n.search.trim()}' looks like a tag token`,
                    );
                }
            }
            if (tagRefusals.length > 0) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Refusing to use replace_text on tag-shaped text: ${tagRefusals.join("; ")}. ` +
                        `Tags may appear in YAML frontmatter or as inline #tag, and text replacement ` +
                        `can partial-match (e.g. '#foo' inside '#foobar') or corrupt frontmatter. ` +
                        `Prefer edit_file_tags (per-file) or rename_tag (vault-wide). ` +
                        `If you really intend a raw text replace, retry the offending entries with force=true ` +
                        `(running with dry_run=true first is recommended).`,
                };
            }

            const original = await plugin.app.vault.read(file);

            // For each replacement, locate every occurrence in the ORIGINAL
            // content, validate `expected_count`, and stage the spans to
            // rewrite. Spans from different replacements may legally coexist
            // as long as they don't overlap (checked next).
            const spans: Span[] = [];
            const summaries: ReplacementSummary[] = [];

            for (let i = 0; i < normalised.length; i++) {
                const n = normalised[i] as Exclude<typeof normalised[number], string>;
                const positions = findAllOccurrences(original, n.search);

                if (n.expectedCount !== null && positions.length !== n.expectedCount) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `replacements[${i}]: expected ${n.expectedCount} occurrence(s) of ` +
                            `${JSON.stringify(n.search)} but found ${positions.length}. ` +
                            `No changes were written. Re-read the file or relax expected_count and retry.`,
                    };
                }

                if (positions.length === 0) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `replacements[${i}]: search text not found in file. ` +
                            `No changes were written. Verify the exact text (whitespace, newlines, casing) ` +
                            `with read_file or grep, then retry.`,
                    };
                }

                const targetPositions = n.replaceAll ? positions : [positions[0]!];
                for (const start of targetPositions) {
                    spans.push({
                        repIndex: i,
                        from: start,
                        to: start + n.search.length,
                        replace: n.replace,
                    });
                }

                summaries.push({
                    index: i,
                    search: n.search,
                    replace: n.replace,
                    occurrences_found: positions.length,
                    occurrences_replaced: targetPositions.length,
                    replace_all: n.replaceAll,
                });
            }

            const overlapErr = detectSpanOverlap(spans);
            if (overlapErr) {
                return { success: false, type: "text", content: overlapErr };
            }

            // Apply spans back-to-front so earlier offsets stay valid as we
            // splice. Sorting descending by `from` is sufficient because
            // detectSpanOverlap has already guaranteed disjointness.
            const sortedDesc = [...spans].sort((a, b) => b.from - a.from || b.to - a.to);
            let working = original;
            for (const span of sortedDesc) {
                working = working.substring(0, span.from) + span.replace + working.substring(span.to);
            }

            if (!dryRun) {
                await plugin.app.vault.modify(file, working);
            }

            const totalReplaced = summaries.reduce((s, r) => s + r.occurrences_replaced, 0);

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_text_replace" : "text_replaced",
                    path,
                    replacements: summaries,
                    total_replacements: totalReplaced,
                    dry_run: dryRun,
                    ...(dryRun ? { preview: working } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}
