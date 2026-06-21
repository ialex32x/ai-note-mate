import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: insert_text
//
// Insert content at a text-anchored position: find the first occurrence of
// `anchor` in the file body, then insert `content` either before or after
// that anchor.  This replaces the "insert-by-replacing" pattern that
// `replace_text` forced on the LLM (pattern: "X", replacement: "X\n\nnew")
// with a clean insert-first API.
//
// Designed to complement `replace_text`:
//   - `replace_text` → modify / delete existing content (search + anchor modes)
//   - `insert_text`  → add new content at a text-anchored position
//   - `append_file`  → add to end of file
//   - `prepend_file` → add to beginning (frontmatter-aware)
// ─────────────────────────────────────────────────────────────────────────────

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
	where: "before" | "after",
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

	// Ambiguous: multiple matches, no occurrence specified → refuse and return excerpts.
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

	// Auto-pad multi-line content with newlines so block-level inserts
	// (tables, paragraphs, sections) don't fuse with adjacent content.
	// Single-line content (no \n) is left untouched — inline insertions
	// like appending a word in a sentence must remain precise.
	const padded = padBlockContent(original, insertOffset, content);

	const result = where === "before"
		? original.substring(0, idx) + padded + original.substring(idx)
		: original.substring(0, idx + anchor.length) + padded + original.substring(idx + anchor.length);

	return { ok: true, result, totalOccurrences };
}

/**
 * When `text` is block-level content (contains newlines), add leading /
 * trailing `\n` so it docks cleanly between `host[offset-1]` (the char
 * immediately before the insertion point) and `host[offset]` (the char
 * immediately after).  Single-line text is returned unchanged.
 *
 * Mirrors `padForGap` / `padForInsertion` in replace-text.ts's anchor
 * mode — the same philosophy applied to text-anchored insertion.
 */
function padBlockContent(host: string, offset: number, text: string): string {
	// Inline insertion: no newlines → never pad.
	if (!text.includes("\n")) return text;

	let out = text;
	// Leading: need a separator when there IS a preceding char and it
	// isn't already a newline, and our text doesn't start with one.
	if (offset > 0 && host.charCodeAt(offset - 1) !== 10) {
		if (out.charCodeAt(0) !== 10) {
			out = "\n" + out;
		}
	}
	// Trailing: need a separator when there IS a following char and it
	// isn't already a newline, and our text doesn't end with one.
	if (offset < host.length && host.charCodeAt(offset) !== 10) {
		if (out.charCodeAt(out.length - 1) !== 10) {
			out = out + "\n";
		}
	}
	return out;
}

/**
 * Resolve the insertion direction from LLM arguments.
 *
 * LLMs sometimes use `before: true` / `after: false` instead of the canonical
 * `where: "before"` / `where: "after"`. This helper normalises those patterns:
 *
 *   - Canonical `where: "before" | "after"` wins when present and valid.
 *   - Otherwise, boolean `before` / `after` are translated:
 *       `before: true`  → "before"
 *       `before: false` → "after"
 *       `after: true`   → "after"
 *       `after: false`  → "before"
 *   - Contradictory combinations (`before: true && after: true`, or
 *     `before: false && after: false`) produce a descriptive error.
 *   - When no direction is specified at all, a missing-argument error is returned.
 *
 * @returns `{ ok: true, where }` or `{ ok: false, error }`.
 */
function resolveWhere(args: Record<string, unknown>): { ok: true; where: "before" | "after" } | { ok: false; error: string } {
	const canonical = args["where"];
	if (canonical === "before" || canonical === "after") {
		return { ok: true, where: canonical };
	}

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
		// before=true, after=false → "before"; before=false, after=true → "after"
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
			`Missing insertion direction. Use \`where: "before"\` or \`where: "after"\` ` +
			`to specify where to insert relative to the anchor.`,
	};
}

export function vaultInsertText(plugin: NoteAssistantPlugin): RegisteredTool {
	return {
		ondemand: true,

		schema: {
			type: "function",
			function: {
				name: "insert_text",
				description:
					"Insert content at a position anchored by existing text in the file. " +
					"Finds the first occurrence of `anchor` (literal substring match) " +
					"and inserts `content` before or after it. " +
					"The anchor text is NOT modified or removed — only new content is added. " +
					"\n\n" +
					"Use this when you want to ADD new paragraphs, list items, sections, or any " +
					"other content relative to existing text — without reconstructing the anchor " +
					"as part of a replacement. " +
					"For heading-anchored insertion (`prepend_to_body`, `append_to_section`, " +
					"`insert_before_section`), use `replace_text` with its anchor mode instead. " +
					"\n\n" +
					"If `anchor` matches exactly ONE location, insertion proceeds immediately. " +
					"If it matches MULTIPLE times AND you did not pass `occurrence`, the call is REFUSED " +
					"with `total_occurrences` + per-match `excerpts` so you can identify the correct spot. " +
					"Then retry with `occurrence: N` (1-based) to target a specific match, or tighten " +
					"the anchor text to make it unique in the file.",
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
								"Literal text to find in the file. Matches the file content exactly — " +
								"include surrounding whitespace and punctuation as it appears in the file. " +
								"The first occurrence is used by default.",
						},
						where: {
							type: "string",
							enum: ["before", "after"],
							description:
								'Where to insert relative to the anchor: "before" inserts content immediately ' +
								'before the anchor text; "after" inserts immediately after it.',
						},
					content: {
						type: "string",
						description:
							"The text to insert. For multi-line block content (paragraphs, " +
							"tables, lists), the tool automatically adds `\\n` padding so the " +
							"insertion cleanly separates from adjacent text — you do NOT need " +
							"to wrap content in extra newlines. Single-line content is inserted " +
							"exactly as-is for inline use.",
					},
						occurrence: {
							type: "number",
							description:
								"Which occurrence of `anchor` to target (1-based). Default 1 (first match). " +
								"Use this when a previous call reported `total_occurrences > 1` and the " +
								"insertion landed at the wrong spot. Must be ≤ total_occurrences.",
						},
					},
					required: ["path", "anchor", "where", "content"],
				},
			},
		},
		capabilities: ["write_file"] as ToolCapability[],
		exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
			const path = args["path"] as string;
			const anchor = args["anchor"] as string;
			const content = args["content"] as string;
			const occurrence = typeof args["occurrence"] === "number" ? args["occurrence"] : undefined;

			const whereRes = resolveWhere(args);
			if (!whereRes.ok) {
				return { success: false, type: "text", content: whereRes.error };
			}
			const where = whereRes.where;

			const fileErr = requireFile(plugin.app, path);
			if (isFailure(fileErr)) return fileErr;

			const file = plugin.app.vault.getAbstractFileByPath(path)!;
			const rawOriginal = await plugin.app.vault.read(file as import("obsidian").TFile);
			// Normalise line endings to avoid \r\n vs \n encoding confusion.
			const original = rawOriginal.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

			const res = insertContent(original, anchor, where, content, occurrence);
			if (!res.ok) {
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

			const lockErr = await runVaultMutation(plugin, chatStream, {
				kind: "modify",
				path,
				toolName: "insert_text",
				perform: async () => {
					await plugin.app.vault.modify(file as import("obsidian").TFile, res.result);
				},
			});
			if (lockErr) return lockErr;

			// Build before/after excerpts around the targeted occurrence for verification.
			const targetOccurrence = occurrence ?? 1;
			const anchorIdx = findNthOccurrence(original, anchor, targetOccurrence);
			const excerptStart = Math.max(0, anchorIdx - 60);
			const excerptEnd = Math.min(original.length, anchorIdx + anchor.length + 60);
			const beforeExcerpt = original.substring(excerptStart, excerptEnd);

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
