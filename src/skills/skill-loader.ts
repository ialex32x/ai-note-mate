/**
 * Standalone Skill Loader - extracted from gemini-cli
 * Zero dependency on gemini-cli internals.
 * npm dependencies: js-yaml
 */

import { load } from 'js-yaml';

/**
 * File system adapter interface for platform-agnostic file operations.
 * Uses Obsidian Vault API for both desktop and mobile compatibility.
 */
export interface FileSystemAdapter {
  /**
   * Check if a path exists and is a directory.
   */
  isDirectory(path: string): Promise<boolean>;

  /**
   * Read file content as string.
   * @param path - Vault-relative path to the file
   */
  readFile(path: string): Promise<string>;

  /**
   * Find SKILL.md files in a directory.
   * Searches at root level and one level deep (subdir/SKILL.md).
   * @param baseDir - Base directory path (vault-relative)
   * @returns Array of vault-relative paths to matching files
   */
  findSkillFiles(baseDir: string): Promise<string[]>;

  /**
   * Get the last-modified time of a file, in milliseconds since the epoch.
   * Returns null if the file does not exist or mtime is unavailable.
   * Used by SkillManager to detect stale cached bodies.
   * @param path - Vault-relative path to the file
   */
  getMtime(path: string): Promise<number | null>;
}

/**
 * Represents the definition of an Agent Skill.
 */
export interface SkillDefinition {
  /** The unique name of the skill. */
  name: string;
  /** A concise description of what the skill does. */
  description: string;
  /** The vault-relative path to the skill's source file. */
  location: string;
  /** The core logic/instructions of the skill (markdown body). */
  body: string;
  /** Whether the skill is currently disabled. */
  disabled?: boolean;
  /** Whether the skill is a built-in skill. */
  isBuiltin?: boolean;
  /** Optional tag for grouping or source tracking. */
  tag?: string;
  /**
   * Last-modified time (ms since epoch) of the SKILL.md file at the time
   * `body` was loaded. Used to detect stale caches. Undefined when the
   * adapter cannot supply mtime (e.g. built-in skills with no backing file).
   */
  mtime?: number;
}

export const FRONTMATTER_REGEX =
  /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;

/**
 * Parses frontmatter content using YAML with a fallback to simple key-value parsing.
 */
function parseFrontmatter(
  content: string,
): { name: string; description: string } | null {
  try {
    const parsed = load(content);
    if (parsed && typeof parsed === 'object') {
      const { name, description } = parsed as Record<string, unknown>;
      if (typeof name === 'string' && typeof description === 'string') {
        return { name, description };
      }
    }
  } catch {
    // YAML parsing failed, fall back to simple parser
  }

  return parseSimpleFrontmatter(content);
}

/**
 * Simple frontmatter parser that extracts name and description fields.
 * Handles cases where values contain colons that would break YAML parsing.
 */
function parseSimpleFrontmatter(
  content: string,
): { name: string; description: string } | null {
  const lines = content.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const nameMatch = line.match(/^\s*name:\s*(.*)$/);
    if (nameMatch && nameMatch[1] !== undefined) {
      name = nameMatch[1].trim();
      continue;
    }

    const descMatch = line.match(/^\s*description:\s*(.*)$/);
    if (descMatch && descMatch[1] !== undefined) {
      const descLines = [descMatch[1].trim()];

      // Check for multi-line description (indented continuation lines)
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1];
        if (nextLine && nextLine.match(/^[ \t]+\S/)) {
          descLines.push(nextLine.trim());
          i++;
        } else {
          break;
        }
      }

      description = descLines.filter(Boolean).join(' ');
      continue;
    }
  }

  if (name !== undefined && description !== undefined) {
    return { name, description };
  }
  return null;
}

/**
 * Discovers and loads all skills (SKILL.md files) in the provided directory.
 * Searches for SKILL.md at root level and one level deep (subdir/SKILL.md).
 *
 * @param dir - Directory path to search for skills (vault-relative)
 * @param fsAdapter - File system adapter implementation
 * @returns Array of discovered skill definitions
 */
export async function loadSkillsFromDir(
  dir: string,
  fsAdapter: FileSystemAdapter,
): Promise<SkillDefinition[]> {
  const discoveredSkills: SkillDefinition[] = [];

  try {
    const isDir = await fsAdapter.isDirectory(dir);
    if (!isDir) {
      return [];
    }

    const skillFiles = await fsAdapter.findSkillFiles(dir);

    for (const skillFile of skillFiles) {
      const metadata = await loadSkillFromFile(skillFile, fsAdapter);
      if (metadata) {
        discoveredSkills.push(metadata);
      }
    }
  } catch (error) {
    console.warn(`Error discovering skills in ${dir}:`, error);
  }

  return discoveredSkills;
}

/**
 * Loads a single skill from a SKILL.md file.
 *
 * @param filePath - Vault-relative path to the SKILL.md file
 * @param fsAdapter - File system adapter implementation
 * @returns Skill definition or null if parsing fails
 */
export async function loadSkillFromFile(
  filePath: string,
  fsAdapter: FileSystemAdapter,
): Promise<SkillDefinition | null> {
  try {
    const content = await fsAdapter.readFile(filePath);
    const match = content.match(FRONTMATTER_REGEX);
    if (!match || !match[1]) {
      return null;
    }

    const frontmatter = parseFrontmatter(match[1]);
    if (!frontmatter) {
      return null;
    }

    // Sanitize name for use as a filename/directory name
    const sanitizedName = frontmatter.name.replace(/[:\\/<>*?"|]/g, '-');

    const mtime = await fsAdapter.getMtime(filePath);

    return {
      name: sanitizedName,
      description: frontmatter.description,
      location: filePath,
      body: match[2]?.trim() ?? '',
      mtime: mtime ?? undefined,
    };
  } catch (error) {
    console.warn(`Error parsing skill file ${filePath}:`, error);
    return null;
  }
}
