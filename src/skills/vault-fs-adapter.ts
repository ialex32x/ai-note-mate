/**
 * Obsidian Vault file system adapter implementation.
 * Uses Obsidian's Vault API for cross-platform compatibility (desktop and mobile).
 */

import { TFile, TFolder, Vault, normalizePath } from 'obsidian';
import type { FileSystemAdapter } from './skill-loader.js';

/**
 * Creates a file system adapter using Obsidian's Vault API.
 * Works on both desktop and mobile platforms.
 */
export function createVaultFsAdapter(vault: Vault): FileSystemAdapter {
  return {
    async isDirectory(path: string): Promise<boolean> {
      const normalizedPath = normalizePath(path);
      const folder = vault.getFolderByPath(normalizedPath);
      return !!folder;
    },

    async readFile(path: string): Promise<string> {
      const normalizedPath = normalizePath(path);
      const file = vault.getAbstractFileByPath(normalizedPath);
      if (!file) {
        throw new Error(`File not found: ${normalizedPath}`);
      }
      if (!(file instanceof TFile)) {
        throw new Error(`Not a file: ${normalizedPath}`);
      }
      return vault.read(file);
    },

    async findSkillFiles(baseDir: string): Promise<string[]> {
      const normalizedBaseDir = normalizePath(baseDir);
      const results: string[] = [];

      const baseFolder = normalizedBaseDir === '/' || normalizedBaseDir === ''
        ? vault.getRoot()
        : vault.getAbstractFileByPath(normalizedBaseDir);

      if (!(baseFolder instanceof TFolder)) {
        return results;
      }

      // Helper to check if a path should be ignored
      const shouldIgnore = (name: string): boolean => {
        return name === 'node_modules' || name.startsWith('.');
      };

      // Scan root level for SKILL.md
      for (const child of baseFolder.children) {
        if (child instanceof TFile && child.name === 'SKILL.md') {
          results.push(child.path);
        }
      }

      // Scan one level deep for subdir/SKILL.md
      for (const child of baseFolder.children) {
        if (child instanceof TFolder && !shouldIgnore(child.name)) {
          for (const subChild of child.children) {
            if (subChild instanceof TFile && subChild.name === 'SKILL.md') {
              results.push(subChild.path);
            }
          }
        }
      }

      return results;
    },

    async getMtime(path: string): Promise<number | null> {
      const normalizedPath = normalizePath(path);
      const file = vault.getAbstractFileByPath(normalizedPath);
      if (!(file instanceof TFile)) {
        return null;
      }
      const mtime = file.stat?.mtime;
      return typeof mtime === 'number' ? mtime : null;
    },
  };
}
