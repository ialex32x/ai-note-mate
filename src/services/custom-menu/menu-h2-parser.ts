/**
 * Parse H2 menu-item headings from MENU.md.
 *
 * Trailing bracket suffixes (right-to-left) may include:
 *   - `[sparkles]` — Lucide icon name
 *   - `[.png, .jpg]` — vault file extensions that may show this item
 *
 * When no extension suffix is present the item defaults to markdown
 * notes only ({@link DEFAULT_MENU_FILE_EXTENSIONS}).
 */

import { DEFAULT_MENU_FILE_EXTENSIONS } from './types';

const BRACKET_SUFFIX_REGEX = /\s+\[([^\]]+)\]\s*$/;
const ICON_NAME_REGEX = /^[\w][\w-]*$/;

export interface ParsedMenuH2 {
	/** Visible menu label with suffixes stripped. */
	label: string;
	/** Lucide icon when an icon suffix was present. */
	icon?: string;
	/** Lowercase extensions without dots (e.g. `md`, `png`). */
	fileExtensions: readonly string[];
}

/**
 * Classify bracket inner text as an icon name or an extension list.
 * Extension lists use dot-prefixed entries and/or comma separation
 * (e.g. `.png`, `.jpg, .webp`). A single bare word like `[tags]`
 * is treated as an icon, not an extension.
 */
function classifyBracketContent(content: string): 'icon' | 'extensions' | 'unknown' {
	const trimmed = content.trim();
	if (isExtensionList(trimmed)) return 'extensions';
	if (ICON_NAME_REGEX.test(trimmed)) return 'icon';
	return 'unknown';
}

function isExtensionList(content: string): boolean {
	const parts = content.split(',').map(s => s.trim()).filter(Boolean);
	if (parts.length === 0) return false;
	if (!parts.every(p => /^\.?[a-zA-Z0-9]+$/.test(p))) return false;
	if (parts.some(p => p.startsWith('.'))) return true;
	if (parts.length > 1) return true;
	return false;
}

function parseExtensionList(content: string): string[] {
	return content
		.split(',')
		.map(s => s.trim().replace(/^\./, '').toLowerCase())
		.filter(Boolean);
}

/** Strip trailing `[icon]` / `[.ext, ...]` suffixes from an H2 heading. */
export function parseMenuH2Heading(heading: string): ParsedMenuH2 {
	let rest = heading.trim();
	let icon: string | undefined;
	let fileExtensions: string[] | undefined;

	for (;;) {
		const m = BRACKET_SUFFIX_REGEX.exec(rest);
		if (!m) break;

		const inner = m[1]!.trim();
		const kind = classifyBracketContent(inner);
		if (kind === 'extensions') {
			fileExtensions = parseExtensionList(inner);
			rest = rest.slice(0, m.index).trimEnd();
			continue;
		}
		if (kind === 'icon' && icon === undefined) {
			icon = inner;
			rest = rest.slice(0, m.index).trimEnd();
			continue;
		}
		break;
	}

	return {
		label: rest,
		icon,
		fileExtensions: fileExtensions ?? DEFAULT_MENU_FILE_EXTENSIONS,
	};
}
