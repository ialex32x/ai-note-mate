import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: write_file
//
// Overwrite the ENTIRE body of an existing markdown file with a new,
// fully-formed replacement. Narrowly scoped so the `vault_editor`
// sub-agent can finish a wholesale rewrite (reformat / translate /
// restructure) in one atomic call without stringing together a brittle
// long `search`/`replace` pair.
//
// The main agent does NOT get this tool. Wholesale rewriting requires
// the caller to have the full new body in hand, which means it must
// have read the full old body — exactly the context-blowup this plan
// avoids. Keep `write_file` sub-agent-only (see
// `docs/vault-editor-subagent-plan.md` §8.2).
//
// Does NOT create new files. Attempting `write_file` on a non-existent
// path is refused with a pointer to `create_file`. Creation is a
// main-agent planning decision, not an editor decision.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Head + tail excerpt pair capped at ~240 chars total per side. When the
 * content is short enough to show both head and tail without overlap,
 * they are returned as-is. When it's very long, both are truncated
 * independently — callers that need a specific offset range should use
 * `replace_text` (which carries per-span excerpts with context).
 *
 * Rationale for exposing head + tail separately rather than a single
 * "preview" string:
 *  - The caller (typically `vault_editor`) summarizes what changed to
 *    the main agent via `result.sample_diff`. Head gives it "how the
 *    file now opens" (useful for verifying frontmatter / title
 *    changes); tail gives it "how the file now ends" (useful for
 *    verifying translation completeness / trailing structure).
 *  - The middle of a file after a wholesale rewrite is the least
 *    representative sample — the `vault_editor` agent picks a few
 *    middle samples of its own choosing (see its prompt §4.3).
 */
export const EXCERPT_HEAD_TAIL_CAP = 240;

export interface WriteFileExcerpts {
    head: string;
    tail: string;
    truncated: boolean;
}

export function buildHeadTailExcerpts(content: string): WriteFileExcerpts {
    if (content.length <= EXCERPT_HEAD_TAIL_CAP * 2) {
        // Short enough that head + tail would overlap or cover the full
        // content. Return the whole string as head, empty tail — the
        // caller can detect "tail empty" as "file is small, head IS the
        // whole content".
        return { head: content, tail: "", truncated: false };
    }
    return {
        head: content.substring(0, EXCERPT_HEAD_TAIL_CAP),
        tail: content.substring(content.length - EXCERPT_HEAD_TAIL_CAP),
        truncated: true,
    };
}

/**
 * Count newline-terminated lines, matching what
 * `replace-text.ts:buildLineStarts` would yield minus its sentinel.
 * Duplicated here (rather than imported) because that helper is in a
 * test-only export and we want this tool's implementation independent.
 */
export function countLines(content: string): number {
    if (content.length === 0) return 0;
    let count = 1;
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10 /* \n */) count++;
    }
    // If the file ends with a trailing newline, the last "line" is an
    // empty one that Obsidian (and most editors) don't count as a real
    // line — subtract it to match user-visible line counts.
    if (content.charCodeAt(content.length - 1) === 10) count--;
    return count;
}

export function vaultWriteFile(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "write_file",
                description:
                    "Overwrite the ENTIRE content of an existing markdown file in one atomic operation. " +
                    "Use this when you have produced a fully rewritten body (e.g. after reformatting, " +
                    "translating, or restructuring the note). This is the ONLY tool that performs " +
                    "wholesale overwrite of an existing file — `create_file` strictly creates new files " +
                    "and refuses when the path already exists. " +
                    "\n\n" +
                    "For SURGICAL multi-region edits (a few typo fixes, heading renames, a couple of " +
                    "paragraphs to rewrite), prefer `replace_text` — it batches multiple locators into " +
                    "one atomic call and is far less error-prone than assembling the whole new body. " +
                    "For line-level insert / replace / delete, use `edit_lines`. " +
                    "\n\n" +
                    "The file MUST exist; this tool refuses to create new files. Use `create_file` for that. " +
                    "\n\n" +
                    "OPTIONAL SAFETY CHECK: pass `expected_pre_edit_mtime` with the file's `mtime` " +
                    "(Unix ms timestamp) as observed by the caller — `read_file`, `read_section`, " +
                    "and `get_file_state` all return `mtime` in their envelopes, and prior write " +
                    "tools return `new_mtime` you can chain. If provided and the actual on-disk " +
                    "`mtime` differs, the call fails — this catches the case where the file was " +
                    "modified between the caller's read and this write. Use the file's `mtime` " +
                    "rather than its size: character count and on-disk byte count can legitimately " +
                    "differ (CRLF normalization, multi-byte UTF-8, BOM stripping) and would yield " +
                    "false-positive race errors. Recommended whenever you have the info.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        content: {
                            type: "string",
                            description:
                                "The FULL new content of the file. This replaces the existing content " +
                                "verbatim (no implicit newline added / stripped).",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Optional Unix timestamp in milliseconds that the caller believes is the file's " +
                                "current `mtime` (obtainable from `read_file` / `read_section` / `get_file_state`, " +
                                "or chained from a prior write tool's `new_mtime`). If provided and the actual " +
                                "on-disk `mtime` differs, the call fails — use this to guard against concurrent " +
                                "external modifications.",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and return the size / excerpt envelope WITHOUT modifying the " +
                                "file. Does NOT return the full new content — the caller already has it.",
                        },
                    },
                    required: ["path", "content"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const content = args["content"] as string;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (typeof content !== "string") {
                return {
                    success: false,
                    type: "text",
                    content: "`content` must be a string.",
                };
            }

            // File existence is mandatory. The tool description already
            // says so, but we refuse loudly rather than silently creating
            // a file — creation is a main-agent planning decision.
            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) {
                // Re-wrap the generic "File not found" message with a
                // pointer to `create_file` so the model learns the right
                // next action instead of retrying `write_file`.
                const original = fileOrErr.content as string;
                if (original.startsWith("File not found:")) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `${original} ` +
                            `\`write_file\` refuses to create new files — use \`create_file\` for that. ` +
                            `Only use \`write_file\` for wholesale rewrites of an EXISTING file.`,
                    };
                }
                return fileOrErr;
            }
            const file = fileOrErr;

            // mtime is the race-detection signal. Snapshot BEFORE reading
            // the body so the value we report and compare against is the
            // pre-mutation one even if Obsidian were to refresh stat in
            // the middle (it doesn't today, but we don't want this to be
            // a latent issue if that ever changes).
            const previousMtime = file.stat.mtime;

            if (
                expectedPreEditMtime !== undefined &&
                expectedPreEditMtime !== previousMtime
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
            const previousSize = original.length;
            const previousLineCount = countLines(original);

            const newSize = content.length;
            const newLineCount = countLines(content);
            const beforeExcerpts = buildHeadTailExcerpts(original);
            const afterExcerpts = buildHeadTailExcerpts(content);
            const excerptTruncated = beforeExcerpts.truncated || afterExcerpts.truncated;

            if (!dryRun) {
                const lockErr = await runVaultMutation(plugin, chatStream, {
                    kind: "modify",
                    path,
                    toolName: "write_file",
                    perform: async () => { await plugin.app.vault.modify(file, content); },
                });
                if (lockErr) return lockErr;
            }

            // After modify(), Obsidian updates `file.stat` in place. For
            // dry_run we keep the same value as `previous_mtime` so the
            // chained value the caller may pass into a follow-up call is
            // still accurate.
            const newMtime = dryRun ? previousMtime : file.stat.mtime;

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_file_overwrite" : "file_overwritten",
                    path,
                    previous_size: previousSize,
                    new_size: newSize,
                    previous_line_count: previousLineCount,
                    new_line_count: newLineCount,
                    previous_mtime: previousMtime,
                    new_mtime: newMtime,
                    dry_run: dryRun,
                    before_excerpt_head: beforeExcerpts.head,
                    before_excerpt_tail: beforeExcerpts.tail,
                    after_excerpt_head: afterExcerpts.head,
                    after_excerpt_tail: afterExcerpts.tail,
                    excerpt_truncated: excerptTruncated,
                },
            };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test exports — pure helpers reused by `test/write-file.test.ts`.
// See the same rationale in `replace-text.ts`: we keep the I/O-bound
// `exec` closure untested here and cover the pure helpers directly,
// sidestepping the Obsidian mock surface.
// ─────────────────────────────────────────────────────────────────────────────

export const __TEST_ONLY__ = {
    buildHeadTailExcerpts,
    countLines,
    EXCERPT_HEAD_TAIL_CAP,
};
