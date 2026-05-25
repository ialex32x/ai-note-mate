/**
 * Replace template variables in custom menu prompt templates with
 * concrete values from the current file / editor context.
 *
 * Supported variables:
 *   {{filepath}}   — file path with filename (e.g. "Input/Test Note.md")
 *   {{selection}}  — selection range (e.g. "(Ln 29 - Ln 40)")
 *   {{blockquote}} — selection content as a markdown blockquote
 */

import type { Editor } from 'obsidian';

/**
 * Context passed to the replacer. All fields are optional — the replacer
 * substitutes what it can and leaves unresolvable variables as-is (they
 * become a visible hint to the user that something is missing).
 */
export interface MenuVariableContext {
	/** Full vault-relative path of the target file. */
	readonly filePath?: string;
	/** The editor instance (needed for selection / cursor info). */
	readonly editor?: Editor;
}

/**
 * Replace `{{filepath}}`, `{{selection}}`, and `{{blockquote}}` in
 * the template with live values from the context.
 *
 * Unresolved variables are left in the output so the user can see what
 * the template expected.
 */
export function replaceMenuVariables(
	template: string,
	ctx: MenuVariableContext,
): string {
	let result = template;

	// {{filepath}} → [[filePath]] (Obsidian wiki-link format)
	result = result.replace(
		/\{\{filepath\}\}/g,
		ctx.filePath ? `[[${ctx.filePath}]]` : '{{filepath}}',
	);

	// {{selection}} — range description from the editor's selection.
	result = result.replace(
		/\{\{selection\}\}/g,
		buildSelectionRange(ctx.editor),
	);

	// {{blockquote}} — quoted preview of the selected text.
	result = result.replace(
		/\{\{blockquote\}\}/g,
		buildBlockquote(ctx.editor),
	);

	return result;
}

/**
 * Build a "(Ln X - Ln Y)" or "(Ln X, Col Y)" range description from the
 * editor's current selection / cursor. Returns the variable placeholder
 * itself when the editor is absent.
 */
function buildSelectionRange(editor?: Editor): string {
	if (!editor) return '{{selection}}';

	const from = editor.getCursor('from');
	const to = editor.getCursor('to');
	const hasSelection = from.line !== to.line || from.ch !== to.ch;

	const lnA = from.line + 1;
	const lnB = to.line + 1;
	const lenFromLine = editor.getLine(from.line).length;
	const lenToLine = editor.getLine(to.line).length;

	if (!hasSelection) {
		return `(Ln ${lnA}, Col ${from.ch + 1})`;
	}

	if (
		// end-of-A → start-of-B, B is the line right after A
		to.line === from.line + 1 && from.ch === lenFromLine && to.ch === 0
	) {
		return `(Ln ${lnB})`;
	}

	if (
		// whole single line: start-of-A → end-of-A
		from.line === to.line && from.ch === 0 && to.ch === lenToLine
	) {
		return `(Ln ${lnA})`;
	}

	if (
		// whole multi-line span: start-of-A → end-of-B
		from.line < to.line && from.ch === 0 && to.ch === lenToLine
	) {
		return `(Ln ${lnA} - Ln ${lnB})`;
	}

	return `(Ln ${lnA}, Col ${from.ch + 1} - Ln ${lnB}, Col ${to.ch + 1})`;
}

/**
 * Build a markdown blockquote from the editor's selected text. Returns
 * the variable placeholder when there is no editor or no selection.
 *
 * The output is a series of `> ...` lines, one per line of the
 * selection. Long selections are truncated to
 * {@link BLOCKQUOTE_CODEPOINT_LIMIT} code points.
 */
function buildBlockquote(editor?: Editor): string {
	if (!editor) return '{{blockquote}}';

	const selection = editor.getSelection();
	if (!selection || !selection.trim()) return '{{blockquote}}';

	const codepoints = Array.from(selection);
	let body: string;
	if (codepoints.length > BLOCKQUOTE_CODEPOINT_LIMIT) {
		body = codepoints.slice(0, BLOCKQUOTE_CODEPOINT_LIMIT).join('');
		const omitted = codepoints.length - BLOCKQUOTE_CODEPOINT_LIMIT;
		body += `... (+${omitted} ${omitted === 1 ? 'char' : 'chars'} omitted)`;
	} else {
		body = selection;
	}

	// Strip leading/trailing newlines so the blockquote doesn't start
	// or end with an empty `> ` line.
	body = body.replace(/^\n+/, '').replace(/\n+$/, '');

	return body.split('\n').map(line => `> ${line}`).join('\n');
}

/** Maximum Unicode code points carried in the blockquote preview. */
const BLOCKQUOTE_CODEPOINT_LIMIT = 100;
