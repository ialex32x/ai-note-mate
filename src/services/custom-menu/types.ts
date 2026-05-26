/**
 * Types for the user-customisable right-click / file-menu feature.
 *
 * The user authors a MENU.md note in their vault (configurable in
 * Settings → Customize). The note is parsed into menu item definitions
 * grouped by category (H1 headings), and the plugin wires them into
 * Obsidian's `editor-menu` and `file-menu` events under the shared
 * "AI" submenu.
 */

/**
 * Which surface a menu entry belongs to.
 *
 * Determined by the parent H1 heading in the note (see
 * {@link CATEGORY_H1_FILE} / {@link CATEGORY_H1_EDITOR}).
 */
export type CustomMenuCategory = 'file-menu' | 'editor-menu';

/** Default file extensions when an H2 heading has no `[.ext, …]` suffix. */
export const DEFAULT_MENU_FILE_EXTENSIONS: readonly string[] = ['md'];

/** One parsed menu entry from the MENU.md note. */
export interface CustomMenuItem {
	/** Which menu surface (editor right-click vs. file right-click). */
	category: CustomMenuCategory;
	/** Menu label (the `##` heading text, with suffix brackets stripped). */
	label: string;
	/**
	 * Optional Lucide icon name extracted from a trailing `[icon]` in the
	 * H2 heading. When unset the consumer falls back to `sparkles`.
	 */
	icon?: string;
	/**
	 * Vault file extensions (without dots) for which this item is shown.
	 * Defaults to {@link DEFAULT_MENU_FILE_EXTENSIONS} when the heading
	 * omits an explicit `[.ext, …]` suffix.
	 */
	fileExtensions: readonly string[];
	/**
	 * Prompt template body. Lines between the `##` heading and the next
	 * heading (or EOF), with blockquote lines (`> ...`) stripped.
	 * May contain `{{filepath}}`, `{{selection}}`, `{{blockquote}}`
	 * placeholder variables.
	 */
	promptTemplate: string;
}

/** Parsed view of the whole MENU.md note. */
export interface ParsedMenuNote {
	/** All parsed menu items in document order. */
	items: CustomMenuItem[];
}

/** Recognised H1 heading text for the file-menu category. */
export const CATEGORY_H1_FILE = 'Files';
/** Recognised H1 heading text for the editor-menu category. */
export const CATEGORY_H1_EDITOR = 'Editor';

/** All H1 texts that map to the file-menu category. */
export const FILE_CATEGORY_H1_TEXTS: ReadonlySet<string> = new Set([
	CATEGORY_H1_FILE,
	'笔记文件',
	'筆記檔案',
	'ファイル',
	'파일',
]);

/** All H1 texts that map to the editor-menu category. */
export const EDITOR_CATEGORY_H1_TEXTS: ReadonlySet<string> = new Set([
	CATEGORY_H1_EDITOR,
	'笔记编辑器',
	'筆記編輯器',
	'エディター',
	'편집기',
]);
