/**
 * Standalone Skill Loader - extracted from gemini-cli.
 *
 * Frontmatter parsing is delegated to the shared `utils/frontmatter` helper,
 * which uses Obsidian's built-in `parseYaml` / `getFrontMatterInfo` — so this
 * module has no third-party YAML dependency.
 */

import { parseFrontmatterFromContent } from '../utils/frontmatter.js';

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
    const { exists, frontmatter, body } = parseFrontmatterFromContent(content, {
      // Skill descriptions commonly contain unquoted colons, which break
      // strict YAML. Enable the permissive fallback so we still salvage the
      // `name` / `description` fields in that case.
      permissiveFallback: true,
    });
    if (!exists || !frontmatter) {
      return null;
    }

    const name = frontmatter.name;
    const description = frontmatter.description;
    if (typeof name !== 'string' || typeof description !== 'string') {
      return null;
    }

    // Sanitize name for use as a filename/directory name
    const sanitizedName = name.replace(/[:\\/<>*?"|]/g, '-');

    const mtime = await fsAdapter.getMtime(filePath);

    return {
      name: sanitizedName,
      description,
      location: filePath,
      body: body.trim(),
      mtime: mtime ?? undefined,
    };
  } catch (error) {
    console.warn(`Error parsing skill file ${filePath}:`, error);
    return null;
  }
}
