/**
 * Decide whether a parsed custom menu item applies to a vault file.
 */

import { TAbstractFile, TFile } from 'obsidian';
import type { CustomMenuItem } from './types';

/** Resolve a lowercase extension (`md`, `png`, …) from a path or file. */
export function resolveVaultFileExtension(
	target: TAbstractFile | string | undefined | null,
): string | null {
	if (target == null) return null;

	if (typeof target === 'string') {
		const path = target.trim();
		if (!path) return null;
		const base = path.split('/').pop() ?? '';
		const dot = base.lastIndexOf('.');
		if (dot <= 0 || dot === base.length - 1) return null;
		return base.slice(dot + 1).toLowerCase();
	}

	if (target instanceof TFile) {
		const ext = target.extension?.trim();
		return ext ? ext.toLowerCase() : null;
	}

	return null;
}

/** True when `item` should appear for the given file / path target. */
export function customMenuItemMatchesTarget(
	item: CustomMenuItem,
	target: TAbstractFile | string | undefined | null,
): boolean {
	const ext = resolveVaultFileExtension(target);
	if (!ext) return false;
	return item.fileExtensions.includes(ext);
}
