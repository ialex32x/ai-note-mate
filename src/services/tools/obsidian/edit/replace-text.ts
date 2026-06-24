import type NoteAssistantPlugin from "../../../../main";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";
import {
    findAllOccurrences,
    findAllRegexMatches,
    replaceWithGroups,
    regexHintForLiteral,
    type RegexMatch,
} from "../../../../utils/regex-utils";
import { buildSpanExcerpts } from "../../../../utils/excerpt-utils";
import {
    normaliseReplacement,
    detectSpanOverlap,
    isTagShaped,
    type NormalisedEntry,
    type Span,
    type ReplacementSummary,
} from "./replace-normaliser";

// ─────────────────────────────────────────────────────────────────────────────
// Tools: replace_text (single entry) + batch_replace_text (multi entry)
//
// Two tools sharing one core engine. The core handles any number of
// replacement entries atomically against a single file snapshot. The two
// tool wrappers differ only in schema shape:
//
//   replace_text — flat, single-entry schema. For the common case where
//     the LLM edits one location. Flattening the schema eliminates the
//     nested-array JSON complexity that causes the most validation
//     failures (see session-257 analysis).
//
//   batch_replace_text — `replacements[]` array schema. For atomic
//     multi-edit batches where all patterns MUST match the same pre-edit
//     snapshot. LLMs should use this sparingly and keep batches small
//     (≤4 entries recommended).
//
// Both tools use pattern-based find-and-replace (literal text / regex).
//
// For INSERTIONS (heading-anchored or text-anchored), use `insert_text`.
// For replacing a whole section, use `set_section` (hash-gated).
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Shared core: executed by both replace_text and batch_replace_text.
// All replacement entries are validated and applied atomically against
// a single pre-edit file snapshot.
// ─────────────────────────────────────────────────────────────────────────────

async function executeReplaceTextCore(
    plugin: NoteAssistantPlugin,
    chatStream: ChatStream,
    path: string,
    replacements: unknown[],
    dryRun: boolean,
    expectedPreEditMtime: number | undefined,
    _signal: AbortSignal | undefined,
    toolName: string, // "replace_text" or "batch_replace_text" for mutation lock
): Promise<ToolCallResult> {
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

    // Validate every entry up-front so we never partially apply.
    // Collect ALL validation errors instead of failing on the first.
    const normalised: NormalisedEntry[] = [];
    const validationErrors: string[] = [];
    for (let i = 0; i < replacements.length; i++) {
        const result = normaliseReplacement(replacements[i], i);
        if (typeof result === "string") {
            validationErrors.push(result);
        } else {
            normalised.push(result);
        }
    }
    if (validationErrors.length > 0) {
        return {
            success: false,
            type: "text",
            content: validationErrors.join("\n"),
        };
    }

    // Tag-shape soft guard.
    const tagRefusals: string[] = [];
    for (let i = 0; i < normalised.length; i++) {
        const n = normalised[i]!;
        if (n.kind === "search" && !n.force && isTagShaped(n.pattern)) {
            tagRefusals.push(
                `replacements[${i}].pattern='${n.pattern.trim()}' looks like a tag token`,
            );
        }
    }
    if (tagRefusals.length > 0) {
        return {
            success: false,
            type: "text",
            content:
                `Refusing to use ${toolName} on tag-shaped text: ${tagRefusals.join("; ")}. ` +
                `Tags may appear in YAML frontmatter or as inline #tag, and text replacement ` +
                `can partial-match (e.g. '#foo' inside '#foobar') or corrupt frontmatter. ` +
                `Prefer add_files_tags / remove_files_tags / set_files_tags (accepts one or more paths) or rename_tag (vault-wide). ` +
                `If you really intend a raw text replace, retry the offending entries with force=true ` +
                `(running with dry_run=true first is recommended).`,
        };
    }

    const rawOriginal = await plugin.app.vault.read(file);
    // Normalise all line endings to \n so that pattern matching is
    // immune to \r\n vs \n vs \r encoding confusion.  Without this,
    // the LLM spirals: it sends \n → fails → tries \\n → fails →
    // tries \r\n — ten calls to fix one missing blank line (see
    // session-261 "数据漏斗总览" saga).  Actual line-ending choice
    // is meaningless for Markdown and Obsidian normalises on save.
    const original = rawOriginal.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const spans: Span[] = [];
    const summaries: ReplacementSummary[] = [];
    const summaryUniqueSpanIdx: Array<number | null> = [];

    for (let i = 0; i < normalised.length; i++) {
        const n = normalised[i]!;

        const regexMatches = n.useRegex ? findAllRegexMatches(original, n.pattern) : null;
        // Normalise pattern line endings for literal search so that
        // \r\n, \r, and \n all match the normalised \n in the file.
        const literalPattern = n.useRegex ? n.pattern : n.pattern.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const positions: Array<{ start: number; end: number; match?: RegexMatch }> =
            regexMatches
                ? regexMatches.map((m) => ({ start: m.start, end: m.end, match: m }))
                : findAllOccurrences(original, literalPattern).map((pos) => ({ start: pos, end: pos + literalPattern.length }));

        // Check "not found" FIRST — the hint for regex-looking
        // patterns is more actionable than just the count mismatch.
        if (positions.length === 0) {
            const hint = n.useRegex ? "" : regexHintForLiteral(n.pattern);
            return {
                success: false,
                type: "text",
                content:
                    `replacements[${i}]: ${n.useRegex ? "regex" : "pattern text"} not found in file. ` +
                    `${n.useRegex ? "" : hint}` +
                    (n.useRegex ? "" :
                        ` ⚠️ If you reconstructed this pattern from memory, ` +
                        `the exact byte sequence (whitespace, punctuation, table-cell boundaries) likely differs ` +
                        `from what's in the file. Re-read the file or use read_section to get the verbatim text. `) +
                    `No changes were written. Verify the exact text ` +
                    `(whitespace, newlines, casing) with read_file or grep, then retry.`,
            };
        }

        // Determine safe mode: both params unset → exactly 1 match expected.
        const isSafeMode = n.occurrenceOffset === undefined && n.maxReplacements === undefined;

        if (isSafeMode) {
            if (positions.length > 1) {
                // Safe mode violation: more than 1 match. Tell LLM exactly
                // how many and give copy-paste retry examples.
                const pos = positions[0]!;
                const ctxStart = Math.max(0, pos.start - 40);
                const ctxEnd = Math.min(original.length, pos.end + 40);
                const ctx = JSON.stringify(original.slice(ctxStart, ctxEnd));
                return {
                    success: false,
                    type: "text",
                    content:
                        `replacements[${i}]: pattern ${JSON.stringify(n.pattern)} matched ${positions.length} times (safe mode expects exactly 1). ` +
                        `No changes were written.\n\n` +
                        `Context around first match: ${ctx}.\n\n` +
                        `To retry, choose one of:\n` +
                        `- Replace only the first:       "max_replacements": 1\n` +
                        `- Replace all ${positions.length}:        "occurrence_offset": 0\n` +
                        `- Replace all except the first: "occurrence_offset": 1\n` +
                        `- Replace a specific range:      "occurrence_offset": <skip>, "max_replacements": <count>`,
                };
            }
        }

        // Apply occurrence_offset and max_replacements to select target positions.
        const offset = n.occurrenceOffset ?? 0;
        if (offset >= positions.length) {
            return {
                success: false,
                type: "text",
                content:
                    `replacements[${i}]: occurrence_offset=${offset} skips all ${positions.length} match(es). ` +
                    `The largest valid offset is ${positions.length - 1}. ` +
                    `No changes were written.`,
            };
        }
        const available = positions.slice(offset);
        const targetPositions = n.maxReplacements !== undefined
            ? available.slice(0, n.maxReplacements)
            : available;

        const firstSpanIdx = spans.length;
        for (const hit of targetPositions) {
            const effectiveReplacement =
                hit.match
                    ? replaceWithGroups(n.replacement, original, hit.match)
                    : n.replacement;
            spans.push({
                repIndex: i,
                from: hit.start,
                to: hit.end,
                replacement: effectiveReplacement,
            });
        }

        summaries.push({
            index: i,
            mode: "search",
            pattern: n.pattern,
            replacement: n.replacement,
            occurrences_found: positions.length,
            occurrences_replaced: targetPositions.length,
            replace_all: n.occurrenceOffset === 0 && n.maxReplacements === undefined,
        });
        summaryUniqueSpanIdx.push(targetPositions.length === 1 ? firstSpanIdx : null);
    }

    const overlapErr = detectSpanOverlap(spans);
    if (overlapErr) {
        return { success: false, type: "text", content: overlapErr };
    }

    // Apply spans back-to-front.
    const sortedDesc = [...spans].sort((a, b) => b.from - a.from || b.to - a.to);
    let working = original;
    for (const span of sortedDesc) {
        working = working.substring(0, span.from) + span.replacement + working.substring(span.to);
    }

    // Compute post-edit offsets for excerpt generation.
    const spanPostEdit: Array<{ newFrom: number; newTo: number }> = [];
    for (let k = 0; k < spans.length; k++) {
        spanPostEdit.push({ newFrom: 0, newTo: 0 });
    }
    const sortedAsc = spans
        .map((s, idx) => ({ s, idx }))
        .sort((a, b) => a.s.from - b.s.from || a.s.to - b.s.to);
    let cumulativeDelta = 0;
    for (const { s, idx } of sortedAsc) {
        const newFrom = s.from + cumulativeDelta;
        const newTo = newFrom + s.replacement.length;
        spanPostEdit[idx] = { newFrom, newTo };
        cumulativeDelta += s.replacement.length - (s.to - s.from);
    }

    // Fill before/after excerpts.
    for (let i = 0; i < summaries.length; i++) {
        const uniq = summaryUniqueSpanIdx[i];
        if (uniq === null || uniq === undefined) continue;
        const summary = summaries[i]!;
        const span = spans[uniq]!;
        const post = spanPostEdit[uniq]!;
        const ex = buildSpanExcerpts(original, working, span.from, span.to, post.newFrom, post.newTo);
        summary.before_excerpt = ex.before;
        summary.after_excerpt = ex.after;
        if (ex.truncated) {
            summary.excerpt_truncated = true;
        }
    }

    if (!dryRun) {
        const lockErr = await runVaultMutation(plugin, chatStream, {
            kind: "modify",
            path,
            toolName,
            perform: async () => { await plugin.app.vault.modify(file, working); },
        });
        if (lockErr) return lockErr;
    }

    const totalReplaced = summaries.reduce((s, r) => s + r.occurrences_replaced, 0);
    const newMtime = dryRun ? previousMtime : file.stat.mtime;

    return {
        success: true,
        type: "object",
        content: {
            action: dryRun ? "dry_run_text_replace" : "text_replaced",
            path,
            replacements: summaries,
            total_replacements: totalReplaced,
            dry_run: dryRun,
            previous_mtime: previousMtime,
            new_mtime: newMtime,
            ...(dryRun ? { preview: working } : {}),
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: replace_text (single entry, flat schema)
//
// Single find-and-replace edit on one file. The schema is intentionally
// flat (no nested `replacements[]` array) because LLMs are far less
// likely to make JSON errors on flat objects versus nested arrays.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "replace_text",
                description:
                    "Apply a single find-and-replace edit to a file using pattern matching " +
                    "(literal text or JavaScript regex). " +
                    "\n\n" +
                    "Use this for MODIFYING or DELETING existing content: typo fixes, term renames, " +
                    "deleting a phrase, restructuring inline text. " +
                    "\n\n" +
                    "For INSERTING new content at a heading boundary, use `insert_text` with " +
                    "`heading_path`. For inserting relative to literal text, use `insert_text` " +
                    "with `anchor`. For replacing a whole section, use `set_section` (hash-gated). " +
                    "\n\n" +
                    "⚠️ IMPORTANT: For multiple atomic edits to the SAME file that must all match the " +
                    "pre-edit snapshot, use `batch_replace_text` instead — it accepts a `replacements[]` " +
                    "array and applies all entries atomically. Using multiple `replace_text` calls in sequence " +
                    "will cause later calls to operate on already-modified content, likely missing their target. " +
                    "\n\n" +
                    "Tag-shape guard: a `pattern` value that looks like a single tag token (e.g. `#foo`) is " +
                    "refused by default — raw text replacement cannot tell `#foo` from `#foobar` and risks " +
                    "frontmatter corruption. Set `force=true` only if a literal text replace is genuinely " +
                    "intended (run with `dry_run=true` first). " +
                    "\n\n" +
                    "Pass `expected_pre_edit_mtime` to fail fast on concurrent external edits.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        pattern: {
                            type: "string",
                            description:
                                "Text to find. Must match the file's exact text byte-for-byte " +
                                "(whitespace, punctuation, table pipes). If you are reconstructing the pattern " +
                                "from memory after a prior failure, prefer re-reading the file first — memory-" +
                                "reconstructed patterns often differ on whitespace or adjacent table columns. " +
                                "Set `use_regex: true` to use JavaScript regex syntax (no // delimiters, " +
                                "e.g. `\"foo\\\\s+bar\"`). Must not be empty. Required unless `old` alias is used.",
                        },
                        replacement: {
                            type: "string",
                            description:
                                "REQUIRED. Text to substitute in. Always include this field — use \"\" " +
                                "(empty string) to delete the matched text.",
                        },
                        occurrence_offset: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Skip the first N matches before starting replacement. " +
                                "Defaults to 0 when `max_replacements` is set. " +
                                "When neither this nor `max_replacements` is set, the tool enters " +
                                "SAFE MODE: exactly 1 match is expected; 0 or >1 matches causes " +
                                "a failure with diagnostic information (match count + retry examples).",
                        },
                        max_replacements: {
                            type: "integer",
                            minimum: 1,
                            description:
                                "Maximum number of matches to replace (≥1). " +
                                "When set, `occurrence_offset` defaults to 0. " +
                                "When neither this nor `occurrence_offset` is set, the tool enters " +
                                "SAFE MODE: exactly 1 match is expected. " +
                                "To replace ALL matches, set `occurrence_offset: 0` without this.",
                        },
                        force: {
                            type: "boolean",
                            description:
                                "If true, bypass the tag-shape safety guard. Defaults to false.",
                        },
                        use_regex: {
                            type: "boolean",
                            description:
                                "If true, `pattern` is interpreted as a JavaScript regex " +
                                "(literal syntax, no // delimiters). The regex runs with `g`, `m`, and `u` flags. " +
                                "In regex mode, `replacement` supports `$1`–`$99`, `$&`, `` $` ``, `$'`, `$$`.",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and preview without modifying the file. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Optional Unix ms; the file's expected current `mtime`. Chain from a prior " +
                                "read tool's `mtime` or another write tool's `new_mtime`.",
                        },
                    },
                    required: ["path", "replacement"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            // Build a single entry from the flat args.
            // Include `old`/`new` aliases so the normaliseReplacement
            // fallback (many coding agents use old/new by convention) still
            // works in single-entry mode.
            const entry: Record<string, unknown> = {};
            if (args["pattern"] !== undefined) entry["pattern"] = args["pattern"];
            if (args["old"] !== undefined) entry["old"] = args["old"];
            if (args["new"] !== undefined) entry["new"] = args["new"];
            entry["replacement"] = args["replacement"];
            if (args["occurrence_offset"] !== undefined) entry["occurrence_offset"] = args["occurrence_offset"];
            if (args["max_replacements"] !== undefined) entry["max_replacements"] = args["max_replacements"];
            if (args["force"] !== undefined) entry["force"] = args["force"];
            if (args["use_regex"] !== undefined) entry["use_regex"] = args["use_regex"];

            return executeReplaceTextCore(
                plugin,
                chatStream,
                path,
                [entry],
                dryRun,
                expectedPreEditMtime,
                _signal,
                "replace_text",
            );
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: batch_replace_text (multi entry, `replacements[]` array)
//
// Atomic batch of edits against a single file snapshot. Use when multiple
// edits to the same file must all see the same pre-edit content AND you
// don't want intermediate states visible. Keep batches small (≤4 entries
// recommended) — LLMs are less accurate with large nested JSON arrays.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultBatchReplaceText(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "batch_replace_text",
                description:
                    "Apply multiple atomic edits to a single file via `replacements[]`. " +
                    "Each entry uses `pattern` (literal find-and-replace or regex). " +
                    "All entries match the SAME pre-edit snapshot; matched ranges across entries must be " +
                    "disjoint. Overlapping matches are rejected and nothing is written. " +
                    "\n\n" +
                    "⚠️ Use this tool ONLY when you need multiple atomic edits to the same file. For single " +
                    "edits, prefer `replace_text` — its flat schema is less error-prone. Keep batches small " +
                    "(≤4 entries recommended) to reduce JSON generation errors. " +
                    "\n\n" +
                    "For insertions at heading boundaries, use `insert_text` with `heading_path`. " +
                    "For replacing a whole section, use `set_section`. " +
                    "\n\n" +
                    "Tag-shape guard: a `pattern` that looks like a tag token (e.g. `#foo`) is refused by " +
                    "default. Set `force=true` on that entry if literal text replace is intended. " +
                    "\n\n" +
                    "Pass `expected_pre_edit_mtime` to fail fast on concurrent external edits.",
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
                                "List of edits to apply atomically. Each entry must provide `pattern` " +
                                "(literal text or regex). All entries match the file's pre-edit content; " +
                                "matched ranges across entries must be disjoint. " +
                                "Recommended max: 4 entries per batch.",
                            items: {
                                type: "object",
                                properties: {
                                    pattern: {
                                        type: "string",
                                        description:
                                            "Text to find. Must match the file's exact text byte-for-byte " +
                                            "(whitespace, punctuation, table pipes). If you are reconstructing the pattern " +
                                            "from memory after a prior failure, prefer re-reading the file first — memory-" +
                                            "reconstructed patterns often differ on whitespace or adjacent table columns. " +
                                            "Set `use_regex: true` to use JavaScript regex syntax (no // delimiters, " +
                                            "e.g. `\"foo\\\\s+bar\"`). Must not be empty.",
                                    },
                                    replacement: {
                                        type: "string",
                                        description:
                                            "REQUIRED. Text to substitute in. Use \"\" to delete.",
                                    },
                                    occurrence_offset: {
                                        type: "integer",
                                        minimum: 0,
                                        description:
                                            "Skip the first N matches before starting replacement. " +
                                            "Defaults to 0 when `max_replacements` is set. " +
                                            "When neither this nor `max_replacements` is set, the tool enters " +
                                            "SAFE MODE: exactly 1 match is expected; 0 or >1 matches fails.",
                                    },
                                    max_replacements: {
                                        type: "integer",
                                        minimum: 1,
                                        description:
                                            "Maximum number of matches to replace (≥1). " +
                                            "When set, `occurrence_offset` defaults to 0. " +
                                            "When neither this nor `occurrence_offset` is set, the tool enters " +
                                            "SAFE MODE. To replace ALL matches, set `occurrence_offset: 0`.",
                                    },
                                    force: {
                                        type: "boolean",
                                        description: "Bypass tag-shape guard. Defaults to false.",
                                    },
                                    use_regex: {
                                        type: "boolean",
                                        description:
                                            "Interpret `pattern` as a JavaScript regex.",
                                    },
                                },
                                required: ["replacement"],
                            },
                        },
                        dry_run: {
                            type: "boolean",
                            description: "If true, preview without modifying. Defaults to false.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description: "Optional Unix ms; fail fast on concurrent external edits.",
                        },
                    },
                    required: ["path", "replacements"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            let rawReplacements = args["replacements"];
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            // Handle double-serialised JSON string.
            let replacements: unknown[];
            if (typeof rawReplacements === "string") {
                try {
                    const parsed = JSON.parse(rawReplacements) as unknown;
                    if (!Array.isArray(parsed)) {
                        return {
                            success: false,
                            type: "text",
                            content:
                                "`replacements` arrived as a JSON string but did not parse as an array. " +
                                "Pass a non-empty array of replacement objects.",
                        };
                    }
                    replacements = parsed;
                } catch {
                    return {
                        success: false,
                        type: "text",
                        content:
                            "`replacements` must be a non-empty array, but received a string that is not valid JSON.",
                    };
                }
            } else {
                replacements = rawReplacements as unknown[];
            }

            if (!Array.isArray(replacements) || replacements.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content: "`replacements` must be a non-empty array.",
                };
            }

            return executeReplaceTextCore(
                plugin,
                chatStream,
                path,
                replacements,
                dryRun,
                expectedPreEditMtime,
                _signal,
                "batch_replace_text",
            );
        },
        requiresConfirmation: true,
    };
}

