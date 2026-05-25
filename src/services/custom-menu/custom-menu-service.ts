/**
 * Custom menu service — loads, caches, and exposes parsed MENU.md items.
 *
 * Owned at the plugin level so both the file-menu and editor-menu
 * handlers share the same parsed view. Items are eagerly loaded on
 * plugin startup and kept in a synchronous cache so synchronous
 * menu-event callbacks can read them without awaiting.
 */

import { TFile } from 'obsidian';
import type NoteAssistantPlugin from '../../main';
import { parseMenuNote } from './menu-note-parser';
import type { CustomMenuItem, CustomMenuCategory } from './types';

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
	private cache: CacheEntry | null = null;

	constructor(plugin: NoteAssistantPlugin) {
		this.plugin = plugin;
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
		const path = this.plugin.settings.customMenuNotePath.trim();
		if (!path) return null;
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	/**
	 * Invalidate the in-memory cache so the next read forces a re-parse.
	 * Call after programmatic writes to the menu note.
	 */
	invalidate(): void {
		this.cache = null;
	}
}
