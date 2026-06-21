import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, parseBodyHash, requireFile, sha256Hex } from "../_shared";
import { runVaultMutation } from "../../../vault";
import {
    formatFindSectionError,
    normalizeHeadingPathArg,
    resolveHeadingPathToRange,
    type HeadingNode,
} from "../heading-section";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: set_section
//
// Replace the body (or the entire heading+body) of a section, gated by a
// content-hash read-modify-write contract.  The LLM MUST have first read
// the section via `read_section` (which returns a `body_hash`); it then
// passes that hash as `expected_body_hash` here.  If the body changed
// between read and write (concurrent edit, or another tool in the same
// batch), the call fails with zero writes and returns the *current* body
// so the LLM can reconcile.
//
// This is the **only** way to destructively replace a full section or
// section body.  `replace_text` / `batch_replace_text` no longer carry
// `replace_body` / `replace_section` as anchor `where` modes — they were
// the root cause of session-260 (LLM replaced a body without knowing
// what subsections/dividers lived inside it).
// ─────────────────────────────────────────────────────────────────────────────

const WHERE_VALUES = ["replace_body", "replace_section"] as const;
type Where = typeof WHERE_VALUES[number];

export function vaultSetSection(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "set_section",
                description:
                    "Replace a section's body (or the entire section including its heading) " +
                    "with new content. **You MUST first call `read_section` on the same heading " +
                    "and pass its `body_hash` as `expected_body_hash`.** " +
                    "The call will FAIL with zero write if the on-disk body has changed since " +
                    "your read — no data is lost on mismatch. " +
                    "\n\n" +
                    "`where`: `replace_body` (body only, heading line stays) or " +
                    "`replace_section` (heading line + body). " +
                    "\n\n" +
                    "⚠️ `replace_section` deletes the heading line — your `content` must " +
                    "include the replacement heading. `replace_body` keeps the heading and " +
                    "replaces everything below it. Both modes replace the ENTIRE region — any " +
                    "subsections, dividers (---), or trailing content will be lost unless you " +
                    "include them in `content`. For additions, prefer `append_to_section` or " +
                    "`prepend_to_body` via `replace_text` anchor mode.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description: "Vault-relative path to the markdown file.",
                        },
                        heading_path: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Heading titles, outermost → innermost. Same semantics as " +
                                "`read_section`'s `heading_path`.",
                        },
                        where: {
                            type: "string",
                            enum: [...WHERE_VALUES],
                            description:
                                "replace_body: replace the body (below heading line). " +
                                "replace_section: replace heading line + body.",
                        },
                        content: {
                            type: "string",
                            description:
                                "The new section text. For `replace_section` this MUST include " +
                                "the replacement heading line. Use \"\" to delete the body/section.",
                        },
                        expected_body_hash: {
                            type: "string",
                            description:
                                "REQUIRED. The `body_hash` value returned by a prior `read_section` " +
                                "call on the same `heading_path`. Form: `\"sha256:<64 hex chars>\"`. " +
                                "If the current on-disk body hash differs (concurrent edit / stale " +
                                "read), the call fails before any write.",
                        },
                    },
                    required: ["path", "heading_path", "where", "content", "expected_body_hash"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const where = args["where"] as Where;
            const content = args["content"] as string;
            const expectedBodyHashRaw = args["expected_body_hash"] as string | undefined;

            const parsedHash = parseBodyHash(expectedBodyHashRaw);
            if (!parsedHash) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`expected_body_hash\` must be a valid sha256:... hash from a prior ` +
                        `\`read_section\` call. Got: ${JSON.stringify(expectedBodyHashRaw)}. ` +
                        `Call \`read_section\` first to obtain a fresh hash.`,
                };
            }

            if (!WHERE_VALUES.includes(where)) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `\`where\` must be one of: ${WHERE_VALUES.map((w) => JSON.stringify(w)).join(", ")}.`,
                };
            }

            const headingPathResult = normalizeHeadingPathArg(args, { required: true });
            if (!headingPathResult.ok) {
                return {
                    success: false,
                    type: "text",
                    content: headingPathResult.message,
                };
            }
            const headingPath = headingPathResult.value!;

            const fileOrErr = requireFile(plugin.app, path);
            if (isFailure(fileOrErr)) return fileOrErr;
            const file = fileOrErr;
            if (file.extension.toLowerCase() !== "md") {
                return {
                    success: false,
                    type: "text",
                    content: `set_section only operates on markdown files (.md); '${path}' has extension '.${file.extension}'.`,
                };
            }

            const cache = plugin.app.metadataCache.getFileCache(file);
            const headings: HeadingNode[] = (cache?.headings ?? []).map((h) => ({
                level: h.level,
                heading: h.heading,
                line: h.position.start.line,
            }));

            const rawOriginal = await plugin.app.vault.read(file);
            // Normalise line endings.
            const original = rawOriginal.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const lines = original.split("\n");
            const totalLines = lines.length;

            const resolved = resolveHeadingPathToRange(
                headings,
                headingPath,
                totalLines,
                true, // include_subsections — matches read_section default
                "first",
            );
            if (!resolved.ok) {
                return {
                    success: false,
                    type: "text",
                    content: formatFindSectionError(resolved.error, headingPath),
                };
            }

            const { start_line, end_line } = resolved.section;
            // body-only = everything after the heading line (same span read_section hashes)
            const bodyText = lines.slice(start_line, end_line).join("\n");
            const actualBodyHash = await sha256Hex(bodyText);

            if (actualBodyHash !== parsedHash) {
                // Hash mismatch — return the current body so the LLM can reconcile.
                return {
                    success: false,
                    type: "object",
                    content: {
                        action: "set_section_blocked",
                        reason: "body_hash mismatch",
                        path,
                        heading_path: headingPath,
                        where,
                        expected_body_hash: expectedBodyHashRaw,
                        actual_body_hash: `sha256:${actualBodyHash}`,
                        current_body: bodyText,
                        message:
                            `Body hash mismatch: the section body changed between your ` +
                            `read_section and this set_section call. The current body is ` +
                            `returned above — re-read it, reconcile your changes, and ` +
                            `retry with the updated hash. No data was written.`,
                    },
                };
            }

            // Hash matched → apply the replacement.
            let working: string;
            if (where === "replace_body") {
                // Keep heading line, replace everything after it.
                const headingLineIdx = start_line - 1; // 0-based index of heading line
                const before = lines.slice(0, headingLineIdx + 1).join("\n");
                const after = end_line < totalLines ? "\n" + lines.slice(end_line).join("\n") : "";
                working = before + (content.length > 0 ? "\n" + content : "") + after;
            } else {
                // replace_section: heading line + body.
                const before = start_line > 1 ? lines.slice(0, start_line - 1).join("\n") + "\n" : "";
                const after = end_line < totalLines ? lines.slice(end_line).join("\n") : "";
                working = before + content + (after.length > 0 && !after.startsWith("\n") && content.length > 0 ? "\n" : "") + after;
            }

            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "modify",
                path,
                toolName: "set_section",
                perform: async () => { await plugin.app.vault.modify(file, working); },
            });
            if (lockErr) return lockErr;

            return {
                success: true,
                type: "object",
                content: {
                    action: "section_set",
                    path,
                    heading_path: headingPath,
                    where,
                    new_body_hash: `sha256:${await sha256Hex(where === "replace_body" ? content : content.includes("\n") ? content.substring(content.indexOf("\n") + 1) : "")}`,
                    message:
                        `Section body replaced successfully (${where}). ` +
                        `The next set_section on this section must use the returned new_body_hash.`,
                },
            };
        },
        requiresConfirmation: true,
    };
}
