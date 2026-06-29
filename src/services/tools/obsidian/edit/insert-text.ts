import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";
import { getFrontMatterInfo } from "obsidian";
import {
	formatFindSectionError,
	resolveHeadingPathToRange,
	type HeadingNode,
} from "../heading-section";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: insert_text
//
// The single insertion tool. Supports two mutually-exclusive anchoring modes:
//
//   Text-anchored:  `anchor` (string) + `where` ("before" | "after")
//                   Finds literal text in the file and inserts content
//                   before or after the match.
//
//   Heading-anchored: `heading_path` (string[]) + `where`
//                      ("prepend_to_body" | "append_to_section" |
//                       "insert_before_section")
//                      Resolves a heading by path and inserts content
//                      at the specified structural position.
//
// Previously heading-anchored insertion lived inside `replace_text`'s
// anchor mode.  That created confusion — `replace_text`'s `anchor`
// parameter was an object {heading_path, where} while `insert_text`'s
// `anchor` was a plain string.  LLMs routinely crossed the two
// conventions (session-265).  Now there is one insertion tool with
// clearly distinct parameters for the two anchoring strategies.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

type TextWhere = "before" | "after";
type HeadingWhere = "prepend_to_body" | "append_to_section" | "insert_before_section";
type Where = TextWhere | HeadingWhere;

const ALL_WHERE_VALUES: Where[] = [
	"before",
	"after",
	"prepend_to_body",
	"append_to_section",
	"insert_before_section",
];

const TEXT_WHERE_VALUES: TextWhere[] = ["before", "after"];
const HEADING_WHERE_VALUES: HeadingWhere[] = [
	"prepend_to_body",
	"append_to_section",
	"insert_before_section",
];

// ─────────────────────────────────────────────────────────────────────
// Text-anchored insertion helpers
// ─────────────────────────────────────────────────────────────────────

function countOccurrences(text: string, anchor: string): number {
	let count = 0;
	let pos = 0;
	while ((pos = text.indexOf(anchor, pos)) !== -1) {
		count++;
		pos += anchor.length;
	}
	return count;
}

function findNthOccurrence(text: string, anchor: string, n: number): number {
	let pos = -1;
	for (let i = 0; i < n; i++) {
		pos = text.indexOf(anchor, pos + 1);
		if (pos === -1) return -1;
	}
	return pos;
}

function insertContent(
	original: string,
	anchor: string,
	where: TextWhere,
	content: string,
	occurrence: number | undefined,
): { ok: true; result: string; totalOccurrences: number } | { ok: false; error: string; totalOccurrences: number; excerpts?: string[] } {
	const totalOccurrences = countOccurrences(original, anchor);
	if (totalOccurrences === 0) {
		return {
			ok: false,
			totalOccurrences: 0,
			error: `Anchor text not found in file. Double-check the search string — it must match the file content exactly, including whitespace.`,
		};
	}

	if (totalOccurrences > 1 && occurrence === undefined) {
		const excerpts: string[] = [];
		let pos = -1;
		for (let i = 0; i < totalOccurrences; i++) {
			pos = original.indexOf(anchor, pos + 1);
			const start = Math.max(0, pos - 60);
			const end = Math.min(original.length, pos + anchor.length + 60);
			excerpts.push(`#${i + 1}: ${original.substring(start, end).replace(/\n/g, "\\n")}`);
		}
		return {
			ok: false,
			totalOccurrences,
			error:
				`Anchor appears ${totalOccurrences} times. You must specify \`occurrence\` (1..${totalOccurrences}) ` +
				`to pick which one, or tighten the anchor to make it unique. ` +
				`See \`excerpts\` below — each entry shows ~120 chars around one match.`,
			excerpts,
		};
	}

	const target = occurrence ?? 1;
	if (target > totalOccurrences) {
		return {
			ok: false,
			totalOccurrences,
			error:
				`occurrence ${target} > total_occurrences ${totalOccurrences}. ` +
				`The anchor appears only ${totalOccurrences} time(s). Retry with occurrence ≤ ${totalOccurrences}.`,
		};
	}

	const idx = findNthOccurrence(original, anchor, target);
	if (idx === -1) {
		return { ok: false, totalOccurrences, error: `Internal error: could not locate occurrence ${target}.` };
	}

	const insertOffset = where === "before" ? idx : idx + anchor.length;
	const padded = padBlockContent(original, insertOffset, content);

	const result = where === "before"
		? original.substring(0, idx) + padded + original.substring(idx)
		: original.substring(0, idx + anchor.length) + padded + original.substring(idx + anchor.length);

	return { ok: true, result, totalOccurrences };
}

// ─────────────────────────────────────────────────────────────────────
// Heading-anchored insertion
// ─────────────────────────────────────────────────────────────────────

function insertAtHeading(
	original: string,
	headings: HeadingNode[],
	headingPath: string[],
	where: HeadingWhere,
	content: string,
): { ok: true; result: string } | { ok: false; error: string } {
	const lines = original.split("\n");
	const totalLines = lines.length;

	const resolved = resolveHeadingPathToRange(headings, headingPath, totalLines, true);
	if (!resolved.ok) {
		return { ok: false, error: formatFindSectionError(resolved.error, headingPath) };
	}

	const { start_line, end_line } = resolved.section;
	// start_line is 1-based inclusive, end_line is 1-based exclusive past-section

	switch (where) {
		case "insert_before_section": {
			// Insert just before the heading line.
			const headingIdx = start_line - 1; // 0-based
			const before = headingIdx > 0 ? lines.slice(0, headingIdx).join("\n") + "\n" : "";
			const after = lines.slice(headingIdx).join("\n");
			return { ok: true, result: before + content + "\n" + after };
		}

		case "prepend_to_body": {
			// Insert immediately after the heading line.
			const afterHeading = start_line; // 0-based, first line of body
			const before = lines.slice(0, afterHeading).join("\n") + "\n";
			const after = afterHeading < totalLines ? lines.slice(afterHeading).join("\n") : "";
			return { ok: true, result: before + content + (after ? "\n" + after : "") };
		}

		case "append_to_section": {
			// Insert at the end of the section body, before the next heading.
			const before = lines.slice(0, end_line).join("\n");
			const after = end_line < totalLines ? "\n" + lines.slice(end_line).join("\n") : "";
			return { ok: true, result: before + "\n" + content + after };
		}
	}
}

// ─────────────────────────────────────────────────────────────────────
// Padding helper (shared)
// ─────────────────────────────────────────────────────────────────────

/**
 * When `text` is block-level content (contains newlines), add leading /
 * trailing `\n` so it docks cleanly between `host[offset-1]` (the char
 * immediately before the insertion point) and `host[offset]` (the char
 * immediately after).  Single-line text is returned unchanged.
 */
function padBlockContent(host: string, offset: number, text: string): string {
	if (!text.includes("\n")) return text;

	let out = text;
	if (offset > 0 && host.charCodeAt(offset - 1) !== 10) {
		if (out.charCodeAt(0) !== 10) {
			out = "\n" + out;
		}
	}
	if (offset < host.length && host.charCodeAt(offset) !== 10) {
		if (out.charCodeAt(out.length - 1) !== 10) {
			out = out + "\n";
		}
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────
// Where resolution
// ─────────────────────────────────────────────────────────────────────

function resolveWhere(args: Record<string, unknown>): { ok: true; where: Where } | { ok: false; error: string } {
	const canonical = args["where"];
	if (typeof canonical === "string" && (ALL_WHERE_VALUES as string[]).includes(canonical)) {
		return { ok: true, where: canonical as Where };
	}

	// Boolean aliases (before / after) — only map to text mode values.
	const before = args["before"];
	const after = args["after"];
	const hasBefore = typeof before === "boolean";
	const hasAfter = typeof after === "boolean";

	if (hasBefore && hasAfter) {
		if (before === after) {
			const val = before ? "true" : "false";
			return {
				ok: false,
				error:
					`Conflicting direction flags: both \`before\` and \`after\` are ${val}. ` +
					`Use \`where: "before"\` or \`where: "after"\` to disambiguate.`,
			};
		}
		return { ok: true, where: before ? "before" : "after" };
	}

	if (hasBefore) {
		return { ok: true, where: before ? "before" : "after" };
	}
	if (hasAfter) {
		return { ok: true, where: after ? "after" : "before" };
	}

	return {
		ok: false,
		error:
			`Missing or unrecognised insertion direction. ` +
			`Use \`where\` with one of: ${ALL_WHERE_VALUES.map((v) => JSON.stringify(v)).join(", ")}. ` +
			`For text-anchored insertion, also accepts \`before\` / \`after\` boolean aliases.`,
	};
}

// ─────────────────────────────────────────────────────────────────────
// Excerpt helper
// ─────────────────────────────────────────────────────────────────────

function buildHeadingExcerpt(
	original: string,
	headingPath: string[],
	where: HeadingWhere,
	startLine: number,
	endLine: number,
): { before: string; after: string } {
	const lines = original.split("\n");
	const ctx = 3; // lines of surrounding context

	const beforeStart = Math.max(0, startLine - 1 - ctx);
	const beforeEnd = Math.min(lines.length, endLine + ctx);
	const before = lines.slice(beforeStart, beforeEnd).join("\n");

	// For after, the content is inserted, so we can't easily compute
	// the post-edit excerpt without the result. Return meaningful context.
	return { before, after: `[content inserted ${where} heading "${headingPath.join(" > ")}"]` };
}

// ─────────────────────────────────────────────────────────────────────
// Tool definition
// ─────────────────────────────────────────────────────────────────────

export function vaultInsertText(plugin: NoteAssistantPlugin): RegisteredTool {
	return {
		ondemand: true,

		schema: {
			type: "function",
			function: {
				name: "insert_text",
				description:
					"Insert content into a file at a position defined by an anchor. Pick ONE mode:\n\n" +
					"**Text-anchored** (`anchor` + `where:\"before\"|\"after\"`): finds literal text, inserts adjacent. " +
					"**Heading-anchored** (`heading_path` + `where:\"prepend_to_body\"|\"append_to_section\"|\"insert_before_section\"`): " +
					"inserts at structural position relative to a heading.\n\n" +
					"For REPLACING, use `replace_text` or `set_section` (hash-gated). For start/end of file, use `prepend_file`/`append_file`.\n\n" +
					"If `anchor` matches multiple times without `occurrence`, the call is refused with `total_occurrences` + `excerpts`. " +
					"Retry with `occurrence:N` (1-based).",
				parameters: {
					type: "object",
					properties: {
						path: {
							type: "string",
							description: "Vault-relative path to the file, e.g. 'Notes/MyNote.md'.",
						},
						anchor: {
							type: "string",
							description:
								"[text-anchored mode] Literal text to find in the file. " +
								"Must match the file content exactly (whitespace, punctuation). " +
								"Mutually exclusive with `heading_path`.",
						},
						heading_path: {
							type: "array",
							items: { type: "string" },
							minItems: 1,
							description:
								"[heading-anchored mode] Heading titles, outermost → innermost, " +
								"that the target heading's ancestor chain must END WITH. " +
								"A short tail (even a single leaf title) is accepted IF it is unique. " +
								"Mutually exclusive with `anchor`.",
						},
						where: {
							type: "string",
							enum: [...ALL_WHERE_VALUES],
							description:
								"Where to insert relative to the anchor. " +
								"With `anchor` (text mode): \"before\" | \"after\". " +
								"With `heading_path` (heading mode): \"prepend_to_body\" | " +
								"\"append_to_section\" | \"insert_before_section\".",
						},
						content: {
							type: "string",
							description:
								"The text to insert. For multi-line block content " +
								"(paragraphs, tables, lists), the tool automatically adds " +
								"`\\n` padding — you do NOT need to wrap content in extra newlines. " +
								"Single-line content is inserted exactly as-is for inline use.",
						},
						occurrence: {
							type: "number",
							description:
								"[text-anchored mode only] Which occurrence of `anchor` to target " +
								"(1-based). Default 1 (first match). Ignored in heading mode.",
						},
					},
					required: ["path", "where", "content"],
				},
			},
		},
		capabilities: ["write_file"] as ToolCapability[],
		exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
			const path = args["path"] as string;
			const content = args["content"] as string;
			const rawAnchor = args["anchor"];
			const rawHeadingPath = args["heading_path"];
			const occurrence = typeof args["occurrence"] === "number" ? args["occurrence"] : undefined;

			// ── Validate mutual exclusivity ──
			const hasAnchor = rawAnchor !== undefined;
			const hasHeadingPath = rawHeadingPath !== undefined;

			if (!hasAnchor && !hasHeadingPath) {
				return {
					success: false,
					type: "text",
					content:
						"Must provide exactly one of `anchor` (text-anchored mode) or " +
						"`heading_path` (heading-anchored mode).",
				};
			}
			if (hasAnchor && hasHeadingPath) {
				return {
					success: false,
					type: "text",
					content:
						"`anchor` and `heading_path` are mutually exclusive. " +
						"Use `anchor` for text-anchored insertion, or `heading_path` for heading-anchored insertion.",
				};
			}

			// ── Resolve where ──
			const whereRes = resolveWhere(args);
			if (!whereRes.ok) {
				return { success: false, type: "text", content: whereRes.error };
			}
			const where = whereRes.where;

			// ── Validate where vs mode ──
			if (hasAnchor && (HEADING_WHERE_VALUES as string[]).includes(where)) {
				return {
					success: false,
					type: "text",
					content:
						`\`where: "${where}"\` is a heading-anchored mode but you provided \`anchor\` (text-anchored). ` +
						`Use \`heading_path\` instead of \`anchor\`, or switch \`where\` to "before" or "after".`,
				};
			}
			if (hasHeadingPath && (TEXT_WHERE_VALUES as string[]).includes(where)) {
				return {
					success: false,
					type: "text",
					content:
						`\`where: "${where}"\` is a text-anchored mode but you provided \`heading_path\` (heading-anchored). ` +
						`Use \`anchor\` (a literal string) instead of \`heading_path\`, or switch \`where\` ` +
						`to "prepend_to_body", "append_to_section", or "insert_before_section".`,
				};
			}

			// ── Validate heading_path shape ──
			if (hasHeadingPath) {
				if (!Array.isArray(rawHeadingPath) || rawHeadingPath.length === 0) {
					return {
						success: false,
						type: "text",
						content:
							"`heading_path` must be a non-empty array of heading title strings " +
							`(e.g. ["Chapter 2", "Background"]).`,
					};
				}
				for (let i = 0; i < rawHeadingPath.length; i++) {
					if (typeof rawHeadingPath[i] !== "string") {
						return {
							success: false,
							type: "text",
							content: `heading_path[${i}] must be a string.`,
						};
					}
				}
			}

			// ── Read file ──
			const fileErr = requireFile(plugin.app, path);
			if (isFailure(fileErr)) return fileErr;

            const file = plugin.app.vault.getAbstractFileByPath(path)!;
            const rawOriginal = await plugin.app.vault.read(file as import("obsidian").TFile);
            const original = rawOriginal.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

            // ── Frontmatter protection (text-anchored mode only) ──
            // For text-anchored insertion, restrict anchor search to the body
            // to prevent accidental insertion into YAML frontmatter.
            const fmInfo = getFrontMatterInfo(original);
            const frontmatterBlock = fmInfo.exists
                ? original.substring(0, fmInfo.contentStart)
                : "";
            const bodyOnly = fmInfo.exists
                ? original.substring(fmInfo.contentStart)
                : original;

            // ── Execute ──
            if (hasHeadingPath) {
				// Heading-anchored insertion
				const headingPath = rawHeadingPath as string[];
				const cache = plugin.app.metadataCache.getFileCache(file as import("obsidian").TFile);
				const headings: HeadingNode[] = (cache?.headings ?? []).map((h) => ({
					level: h.level,
					heading: h.heading,
					line: h.position.start.line,
				}));

				const res = insertAtHeading(original, headings, headingPath, where as HeadingWhere, content);
				if (!res.ok) {
					return { success: false, type: "text", content: res.error };
				}

				const lockErr = await runVaultMutation(plugin, chatStream, {
					kind: "modify",
					path,
					toolName: "insert_text",
					perform: async () => {
						await plugin.app.vault.modify(file as import("obsidian").TFile, res.result);
					},
				});
				if (lockErr) return lockErr;

				// Resolve for excerpt
				const resolved = resolveHeadingPathToRange(headings, headingPath, original.split("\n").length, true);
				const { start_line, end_line } = resolved.ok ? resolved.section : { start_line: 1, end_line: 1 };
				const { before } = buildHeadingExcerpt(original, headingPath, where as HeadingWhere, start_line, end_line);

				return {
					success: true,
					type: "object",
					content: {
						action: "text_inserted",
						path,
						mode: "heading",
						heading_path: headingPath,
						where,
						before_excerpt: before,
						after_excerpt: `[content inserted via heading-anchored ${where}]`,
					},
				};
			}

            // Text-anchored insertion (existing path)
            const anchor = rawAnchor as string;
            const res = insertContent(bodyOnly, anchor, where as TextWhere, content, occurrence);
            if (!res.ok) {
                // If anchor was not found in body, check if it exists in frontmatter
                // to give a helpful error.
                if (res.totalOccurrences === 0 && fmInfo.exists) {
                    const fmOnly = original.substring(0, fmInfo.contentStart);
                    if (fmOnly.includes(anchor)) {
                        const fullMsg = res.error +
                            ` The anchor text was found inside the YAML frontmatter block, which ` +
                            `\`insert_text\` does not modify. Use \`batch_set_frontmatter\` / \`batch_unset_frontmatter\` ` +
                            `to edit frontmatter.`;
                        return {
                            success: false,
                            type: "text",
                            content: fullMsg,
                        };
                    }
                }
                return {
                    success: false,
                    type: "object",
                    content: {
                        error: res.error,
                        total_occurrences: res.totalOccurrences,
                        ...(res.excerpts ? { excerpts: res.excerpts } : {}),
                    },
                };
            }

            // Reassemble: prepend frontmatter to the body with the insertion.
            const finalResult = frontmatterBlock + res.result;

            const lockErr = await runVaultMutation(plugin, chatStream, {
                kind: "modify",
                path,
                toolName: "insert_text",
                perform: async () => {
                    await plugin.app.vault.modify(file as import("obsidian").TFile, finalResult);
                },
            });
            if (lockErr) return lockErr;

            const targetOccurrence = occurrence ?? 1;
            const anchorIdx = findNthOccurrence(bodyOnly, anchor, targetOccurrence);
            const excerptStart = Math.max(0, anchorIdx - 60);
            const excerptEnd = Math.min(bodyOnly.length, anchorIdx + anchor.length + 60);
            const beforeExcerpt = bodyOnly.substring(excerptStart, excerptEnd);

            const resultAnchorIdx = findNthOccurrence(res.result, anchor, targetOccurrence);
            const resultExcerptStart = Math.max(0, resultAnchorIdx - 60);
            const resultExcerptEnd = Math.min(res.result.length, resultAnchorIdx + anchor.length + 60 + content.length);
            const afterExcerpt = res.result.substring(resultExcerptStart, resultExcerptEnd);

            return {
                success: true,
                type: "object",
                content: {
                    action: "text_inserted",
                    path,
                    mode: "text",
                    where,
                    anchor,
                    occurrence: targetOccurrence,
                    total_occurrences: res.totalOccurrences,
                    before_excerpt: beforeExcerpt,
                    after_excerpt: afterExcerpt,
                },
            };
		},
		requiresConfirmation: true,
	};
}
