import { stringifyYaml, getFrontMatterInfo } from "obsidian";
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
// path is refused with a pointer to `create_note`. Creation is a
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
                    "Overwrite an EXISTING markdown file atomically. " +
                    "File MUST exist (use `create_note` for new files). " +
                    "\n\n" +
                    "Pass `body` (the new markdown text, without frontmatter) and optionally `frontmatter` " +
                    "(a flat key-value object for YAML frontmatter). If `frontmatter` is omitted, the file's " +
                    "existing frontmatter (if any) is preserved — only the body is replaced. " +
                    "To remove frontmatter, pass `frontmatter: {}`." +
                    "\n\n" +
                    "Pass `expected_pre_edit_mtime` (Unix ms, from a prior read/write tool) to fail fast on " +
                    "concurrent external edits.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
                        },
                        body: {
                            type: "string",
                            description:
                                "The FULL new body of the file (without YAML frontmatter). " +
                                "This replaces the existing body verbatim.",
                        },
                        frontmatter: {
                            type: "object",
                            description:
                                "Optional YAML frontmatter as a flat key-value object, e.g. " +
                                "{\"title\":\"My Note\", \"tags\":[\"project\"]}. " +
                                "If omitted, the file's existing frontmatter is preserved unchanged. " +
                                "Pass an empty object `{}` to remove existing frontmatter.",
                        },
                        expected_pre_edit_mtime: {
                            type: "integer",
                            minimum: 0,
                            description:
                                "Optional Unix timestamp in milliseconds that the caller believes is the file's " +
                                "current `mtime` (obtainable from `read_file` / `read_section` / `get_metadata` / " +
                                "`get_file_state`, " +
                                "or chained from a prior write tool's `new_mtime`). If provided and the actual " +
                                "on-disk `mtime` differs, the call fails.",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, validate and return the size / excerpt envelope WITHOUT modifying the " +
                                "file. Does NOT return the full new content — the caller already has it.",
                        },
                    },
                    required: ["path", "body"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const body = args["body"] as string;
            const frontmatterArg = args["frontmatter"] as Record<string, unknown> | undefined;
            const dryRun = (args["dry_run"] as boolean) ?? false;
            const expectedPreEditMtime = args["expected_pre_edit_mtime"] as number | undefined;

            if (typeof body !== "string") {
                return {
                    success: false,
                    type: "text",
                    content: "`body` must be a string.",
                };
            }

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) {
                const original = fileOrErr.content as string;
                if (original.startsWith("File not found:")) {
                    return {
                        success: false,
                        type: "text",
                        content:
                            `${original} ` +
                            `\`write_file\` refuses to create new files — use \`create_note\` for that. ` +
                            `Only use \`write_file\` for wholesale rewrites of an EXISTING file.`,
                    };
                }
                return fileOrErr;
            }
            const file = fileOrErr;

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
            const fmInfo = getFrontMatterInfo(original);

            // Build final content: preserve or replace frontmatter, then append body.
            let content: string;
            if (frontmatterArg !== undefined) {
                // Explicit frontmatter provided — replace it.
                if (typeof frontmatterArg === "object" && !Array.isArray(frontmatterArg) && Object.keys(frontmatterArg).length > 0) {
                    const yaml = stringifyYaml(frontmatterArg);
                    content = `---\n${yaml}\n---\n${body}`;
                } else {
                    // Empty or invalid frontmatter → no frontmatter block.
                    content = body;
                }
            } else if (fmInfo.exists) {
                // Preserve existing frontmatter, replace only the body.
                content = original.substring(0, fmInfo.contentStart) + body;
            } else {
                content = body;
            }

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

            const newMtime = dryRun ? previousMtime : file.stat.mtime;

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_overwrite" : "overwritten",
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
