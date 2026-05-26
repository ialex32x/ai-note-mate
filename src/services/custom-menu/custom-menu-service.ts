/**
 * Custom menu service — loads, caches, and exposes parsed MENU.md items.
 *
 * Owned at the plugin level so both the file-menu and editor-menu
 * handlers share the same parsed view. Items are eagerly loaded on
 * plugin startup and kept in a synchronous cache so synchronous
 * menu-event callbacks can read them without awaiting.
 */

import { TFile, TFolder, normalizePath, type App, type TAbstractFile } from 'obsidian';
import type NoteAssistantPlugin from '../../main';
import { t } from '../../i18n';
import { parseMenuNote } from './menu-note-parser';
import type { CustomMenuItem, CustomMenuCategory } from './types';
import { customMenuItemMatchesTarget } from './menu-item-match';

/** Simple error description helper (same pattern as MemoryStore). */
function describeError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

/**
 * Lightweight cache entry. Keyed by file path + mtime so the parser is
 * only re-run when the file actually changed.
 */
interface CacheEntry {
	filePath: string;
	mtime: number;
	items: CustomMenuItem[];
}

export class CustomMenuService {
	private readonly plugin: NoteAssistantPlugin;
	private readonly app: App;
	private cache: CacheEntry | null = null;

	constructor(plugin: NoteAssistantPlugin) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	/** Currently configured menu note path, normalised. Empty when unset. */
	private menuPath(): string {
		const raw = this.plugin.settings.customMenuNotePath?.trim() ?? '';
		if (!raw) return '';
		return normalizePath(raw);
	}

	/**
	 * Eagerly (re)load and cache menu items. Called on plugin startup
	 * and whenever the MENU.md file is saved / renamed / deleted via
	 * Obsidian vault events.
	 *
	 * Safe to call from any context (sync or async) — errors are
	 * swallowed so a broken MENU.md never blocks startup.
	 */
	async refresh(): Promise<void> {
		try {
			const file = this.findFile();
			if (!file) {
				this.cache = null;
				return;
			}
			const mtime = file.stat.mtime;
			if (this.cache && this.cache.filePath === file.path && this.cache.mtime === mtime) {
				return;
			}
			const content = await this.plugin.app.vault.cachedRead(file);
			const parsed = parseMenuNote(content);
			this.cache = { filePath: file.path, mtime, items: parsed.items };
		} catch {
			// A broken MENU.md should never prevent the plugin from
			// loading. Leave the previous cache (or empty) intact.
		}
	}

	/**
	 * Synchronous accessor for cached menu items of a given category.
	 * Returns an empty array when the cache is cold or the file is
	 * missing.
	 *
	 * This is the hot path called inside `editor-menu` / `file-menu`
	 * handlers, which are synchronous callbacks.
	 */
	getCachedItems(category: CustomMenuCategory): CustomMenuItem[] {
		if (!this.cache) return [];
		return this.cache.items.filter(item => item.category === category);
	}

	/**
	 * Cached items for a category that apply to the given vault file or
	 * path. Non-file targets (folders, extensionless paths) yield [].
	 */
	getCachedItemsForTarget(
		category: CustomMenuCategory,
		target: TAbstractFile | string | undefined | null,
	): CustomMenuItem[] {
		return this.getCachedItems(category).filter(item =>
			customMenuItemMatchesTarget(item, target),
		);
	}

	/**
	 * Return ALL cached items (useful for settings preview).
	 */
	getAllCachedItems(): CustomMenuItem[] {
		return this.cache?.items ?? [];
	}

	/**
	 * Resolve the MENU.md {@link TFile}, or null when the path is empty
	 * or the file doesn't exist.
	 */
	findFile(): TFile | null {
		const path = this.menuPath();
		if (!path) return null;
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	/**
	 * Ensure the menu note exists, creating it (and any missing parent
	 * folders) from the default template when necessary.
	 *
	 * Refuses to create when the configured path collides with a folder.
	 */
	async ensureFile(): Promise<TFile> {
		const path = this.menuPath();
		if (!path) {
			throw new Error('Menu note path is empty.');
		}

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) return existing;
		if (existing) {
			throw new Error(`Menu note path ${path} resolves to a folder, not a file.`);
		}

		// Walk parent folders and create any missing segments.
		const parts = path.split('/');
		if (parts.length > 1) {
			const parentPath = parts.slice(0, -1).join('/');
			const parent = this.app.vault.getAbstractFileByPath(parentPath);
			if (!parent) {
				try {
					await this.app.vault.createFolder(parentPath);
				} catch (err) {
					throw new Error(`Failed to create menu note parent folder ${parentPath}: ${describeError(err)}`);
				}
			} else if (!(parent instanceof TFolder)) {
				throw new Error(`Menu note parent ${parentPath} exists but is not a folder.`);
			}
		}

		try {
			const file = await this.app.vault.create(path, t('settings.customizeMenuDefaultTemplate'));
			void this.refresh();
			return file;
		} catch (err) {
			throw new Error(`Failed to create menu note ${path}: ${describeError(err)}`);
		}
	}

	/**
	 * Invalidate the in-memory cache so the next read forces a re-parse.
	 * Call after programmatic writes to the menu note.
	 */
	invalidate(): void {
		this.cache = null;
	}
}
