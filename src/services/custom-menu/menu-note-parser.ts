/**
 * Parse a MENU.md file into a list of custom menu items.
 *
 * Structure (by example):
 * ```
 * # Files
 * ## Summarise this note
 * Please summarise {{filepath}}...
 * > This is a comment — it will be stripped
 *
 * ## Translate this note
 * Translate {{filepath}} to English...
 *
 * # Editor
 * ## Explain selection
 * Explain the following:
 * {{blockquote}}
 * ```
 *
 * - H1 headings map to categories ({@link FILE_CATEGORY_H1_TEXTS} /
 *   {@link EDITOR_CATEGORY_H1_TEXTS}).
 * - H2 headings become menu item labels.
 * - Body text between the H2 and the next heading (or EOF) becomes the
 *   prompt template.
 * - Blockquote lines (`> ...`) in the body are treated as user comments
 *   and stripped before the template is stored.
 *
 * The parser is fenced-code aware: headings inside triple-backtick
 * blocks do NOT open new sections / items.
 */

import {
	FILE_CATEGORY_H1_TEXTS,
	EDITOR_CATEGORY_H1_TEXTS,
} from './types';
import type { CustomMenuItem, CustomMenuCategory, ParsedMenuNote } from './types';

const HEADING_REGEX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const BLOCKQUOTE_REGEX = /^>\s?/;
const FENCE_REGEX = /^(\s*)(```+|~~~+)/;

/**
 * Parse the raw text of the MENU.md note into structured menu items.
 *
 * Idempotent and stateless. Callers may invoke on every access;
 * the service layers an mtime-keyed cache on top.
 */
export function parseMenuNote(content: string): ParsedMenuNote {
	const lines = content.split('\n');
	const items: CustomMenuItem[] = [];

	let currentCategory: CustomMenuCategory | null = null;
	let currentLabel = '';
	let bodyStart = -1;

	let inFence = false;
	let fenceMarker = '';

	const flushItem = (endLineExclusive: number) => {
		if (!currentCategory || !currentLabel) return;
		const rawBody = lines.slice(bodyStart, endLineExclusive).join('\n');
		const cleanedBody = stripBlockquotes(rawBody).trim();
		if (cleanedBody) {
			items.push({
				category: currentCategory,
				label: currentLabel,
				promptTemplate: cleanedBody,
			});
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		// Track fenced code blocks so we don't parse headings inside them.
		const fenceMatch = FENCE_REGEX.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[2]!;
			if (!inFence) {
				inFence = true;
				fenceMarker = marker[0]!;
			} else if (marker[0] === fenceMarker) {
				inFence = false;
				fenceMarker = '';
			}
			continue;
		}
		if (inFence) continue;

		const m = HEADING_REGEX.exec(line);
		if (!m) continue;

		const level = m[1]!.length;
		const headingText = m[2]!.trim();

		if (level === 1) {
			// H1 — switch category. Any previously-open item is flushed
			// before we change context.
			if (currentLabel) {
				flushItem(i);
				currentLabel = '';
				bodyStart = -1;
			}
			if (FILE_CATEGORY_H1_TEXTS.has(headingText)) {
				currentCategory = 'file-menu';
			} else if (EDITOR_CATEGORY_H1_TEXTS.has(headingText)) {
				currentCategory = 'editor-menu';
			} else {
				// Unknown H1 — stop collecting until we see a known one.
				currentCategory = null;
			}
			continue;
		}

		if (level === 2) {
			// H2 — new menu item.
			if (currentLabel) {
				flushItem(i);
			}
			currentLabel = headingText;
			bodyStart = i + 1;
			continue;
		}

		// H3+ inside an active H2 are treated as body content — do nothing.
	}

	// Flush trailing item.
	if (currentLabel) {
		flushItem(lines.length);
	}

	return { items };
}

/**
 * Strip blockquote (`> ...`) lines from a body string.
 *
 * Lines that start with `> ` or `>` (just the marker, possibly with a
 * space after it) are removed entirely. Everything else is kept
 * verbatim, including nesting / indentation.
 */
function stripBlockquotes(body: string): string {
	const lines = body.split('\n');
	const kept = lines.filter(line => {
		// A line is a blockquote if it starts with `>` optionally
		// followed by a space. The `>` marker alone (e.g. `>`) with
		// nothing after matches the regex because `\s?` matches zero
		// spaces — that's intentional: an empty blockquote line is
		// still a blockquote line.
		return !BLOCKQUOTE_REGEX.test(line);
	});
	return kept.join('\n');
}
