
import { normalizePath } from 'obsidian';

/**
 * Joins path segments and normalizes the result.
 * Uses Obsidian's normalizePath for cross-platform compatibility.
 * @param paths - Path segments to join
 * @returns Normalized path with forward slashes
 */
export function joinPath(...paths: string[]): string {
    return normalizePath(paths.filter(p => p.length > 0).join('/'));
}
