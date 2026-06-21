import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import {
    formatBodyHash,
    isFailure,
    isMediaFile,
    isNonMediaBinaryFile,
    requireFile,
    sha256Hex,
} from "../_shared";
import {
    formatFindSectionError,
    normalizeHeadingPathArg,
    resolveHeadingPathToRange,
    type HeadingNode,
} from "../heading-section";
import { parseHeadingsFromLines } from "../../../../utils/parse-headings";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: read_section
//
// Drill into ONE section of a markdown file by heading path, instead of
// fetching the whole file. Designed as the natural follow-up to
// `get_metadata`: once the model knows a file's outline, it can pull just
// the section it needs without dragging the rest of the file into context.
//
// Registered on BOTH the main agent and the vault-inspector sub-agent.
// The main agent needs it as the read-modify-write partner of
// `set_section` (body_hash contract); the vault-inspector uses it during
// digest workflows. Unlike `read_file`, `read_section` is a targeted
// drill-down — it fetches one section, not the whole file, so it does
// not re-encourage "read full file in main thread" patterns.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultReadSection(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "read_section",
                description:
                    "Read a single section of a markdown file by heading_path. " +
                    "Use this AFTER get_metadata has revealed the heading outline " +
                    "to drill into a specific heading instead of pulling the whole file. " +
                    "Returns a `body_hash` you should chain into `set_section` if you intend " +
                    "to rewrite this section — `set_section` refuses to write if the body has " +
                    "changed since you read it. " +
                    "The section spans from the matched heading line up to (but not including) " +
                    "the next heading at the same OR shallower level — i.e. nested subsections " +
                    "are included by default. Set include_subsections=false to stop at the very " +
                    "next heading of any level. Matching is exact (case-sensitive, trimmed). " +
                    "If the heading_path is not found the tool returns an error with diagnostics. " +
                    "If ambiguous (multiple headings share the same tail), the tool returns the first " +
                    "match with an 'ambiguity_note' so you can refine the heading_path if needed. " +
                    "Returned `start_line` / `end_line` are 1-based physical line numbers; leading blank lines count.",
                parameters: {
                    type: "object",
                    properties: {
                        path: {
                            type: "string",
                            description:
                                "Vault-relative path to a markdown file, e.g. 'Notes/MyNote.md'.",
                        },
                        heading_path: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Parameter name is heading_path (not heading or section). Heading titles, " +
                                "ordered outermost → innermost, that the target heading's ancestor chain " +
                                "must END WITH. The full chain ['Chapter 2', 'Background'] and the shorter " +
                                "tail ['Background'] both resolve to the same heading IF that tail is unique " +
                                "in the file; if ambiguous, the first match is returned with an 'ambiguity_note'. " +
                                "Intermediate ancestors must NOT be skipped (['Chapter 1', 'Background'] " +
                                "is rejected when 'Background' actually sits under 'Chapter 1 > Body').",
                        },
                        include_subsections: {
                            type: "boolean",
                            description:
                                "If true (default), nested subsections are included until a sibling " +
                                "or shallower heading. If false, the section ends at the next heading " +
                                "of any level.",
                        },
                    },
                    required: ["path", "heading_path"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const path = args["path"] as string;
            const includeSubsections = (args["include_subsections"] as boolean | undefined) ?? true;

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

            // Refuse non-markdown / binary files: heading paths only make sense
            // for markdown, and silently text-decoding e.g. a PDF or a docx
            // would feed garbage to the model.
            if (isMediaFile(file) || isNonMediaBinaryFile(file)) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `read_section only supports markdown / plain-text files; '${path}' has extension '.${file.extension}'. ` +
                        `Use read_file (multimodal channel) for media or get_metadata for structural inspection.`,
                };
            }
            if (file.extension.toLowerCase() !== "md") {
                return {
                    success: false,
                    type: "text",
                    content:
                        `read_section only operates on markdown files (.md); '${path}' has extension '.${file.extension}'. ` +
                        `Use read_file with start_line/end_line for non-markdown text files.`,
                };
            }

            // Read file content first — we may need to parse headings ourselves
            // if the metadata cache hasn't indexed this file yet.
            const content = await plugin.app.vault.read(file);
            const lines = content.split("\n");
            const totalLines = lines.length;

            const cache = plugin.app.metadataCache.getFileCache(file);
            const cachedHeadings: HeadingNode[] = (cache?.headings ?? []).map((h) => ({
                level: h.level,
                heading: h.heading,
                line: h.position.start.line,
            }));

            // Fallback: when the metadata cache is stale / not yet populated,
            // parse ATX headings directly from the file content we already have.
            // Without this, any file not yet indexed by Obsidian would always
            // fail with "no headings indexed for this file".
            const headings: HeadingNode[] = cachedHeadings.length > 0
                ? cachedHeadings
                : parseHeadingsFromLines(lines);

            const resolved = resolveHeadingPathToRange(
                headings,
                headingPath,
                totalLines,
                includeSubsections,
                "first",
            );
            if (!resolved.ok) {
                return {
                    success: false,
                    type: "text",
                    content: formatFindSectionError(resolved.error, headingPath),
                };
            }

            const { start_line, end_line, level, heading, ambiguous, ambiguous_match_count, case_insensitive_match } = resolved.section;
            // full section = heading line + body
            const sliced = lines.slice(start_line - 1, end_line).join("\n");
            // body-only = everything after the heading line (for the hash contract with set_section)
            const bodyText = lines.slice(start_line, end_line).join("\n");

            const bodyHash = await sha256Hex(bodyText);

            const resultContent: Record<string, unknown> = {
                path,
                heading_path: headingPath,
                matched_heading: heading,
                level,
                start_line,
                end_line,
                total_lines: totalLines,
                include_subsections: includeSubsections,
                content: sliced,
                body_hash: formatBodyHash(bodyHash),
                mtime: file.stat.mtime,
            };

            if (case_insensitive_match) {
                resultContent.case_insensitive_match = true;
            }

            if (ambiguous) {
                resultContent.ambiguity_note =
                    `heading_path ${headingPath.map((s) => JSON.stringify(s)).join(" > ")} ` +
                    `is ambiguous (${ambiguous_match_count} matches). ` +
                    `Returned the first match at line ${start_line}. ` +
                    `Prepend more ancestors to disambiguate if this is not the intended section.`;
            }

            return {
                success: true,
                type: "object",
                content: resultContent,
            };
        },
    };
}


