/**
 * Standalone Skill Manager - extracted from gemini-cli
 * Zero dependency on gemini-cli internals.
 */

import {
  type SkillDefinition,
  type FileSystemAdapter,
  loadSkillsFromDir,
  loadSkillFromFile,
} from './skill-loader.js';

export {
  type SkillDefinition,
  type FileSystemAdapter,
  loadSkillsFromDir,
  loadSkillFromFile,
} from './skill-loader.js';
export { createVaultFsAdapter } from './vault-fs-adapter.js';

/**
 * Configuration for skill discovery directories.
 */
export interface SkillDiscoveryConfig {
  /**
   * Directories to scan for skills, in order of ascending precedence.
   * Later directories override earlier ones when skill names conflict.
   * Example: ['~/.my-app/skills', './project/.my-app/skills']
   */
  skillDirs: string[];
}

export class SkillManager {
  private skills: SkillDefinition[] = [];
  private activeSkillNames: Set<string> = new Set();
  private fsAdapter: FileSystemAdapter;

  /**
   * Creates a new SkillManager.
   * @param fsAdapter - File system adapter implementation for platform-agnostic file operations
   */
  constructor(fsAdapter: FileSystemAdapter) {
    this.fsAdapter = fsAdapter;
  }

  /**
   * Clears all discovered skills.
   */
  clearSkills(): void {
    this.skills = [];
  }

  /**
   * Discovers skills from the configured directories.
   * Directories are scanned in order — later directories have higher precedence.
   */
  async discoverSkills(config: SkillDiscoveryConfig): Promise<void> {
    this.clearSkills();

    for (const dir of config.skillDirs) {
      const skills = await loadSkillsFromDir(dir, this.fsAdapter);
      this.addSkillsWithPrecedence(skills);
    }
  }

  /**
   * Adds skills to the manager programmatically.
   * New skills override existing ones with the same name.
   */
  addSkills(skills: SkillDefinition[]): void {
    this.addSkillsWithPrecedence(skills);
  }

  private addSkillsWithPrecedence(newSkills: SkillDefinition[]): void {
    const skillMap = new Map<string, SkillDefinition>(
      this.skills.map((s) => [s.name, s]),
    );

    for (const newSkill of newSkills) {
      const existingSkill = skillMap.get(newSkill.name);
      if (existingSkill && existingSkill.location !== newSkill.location) {
        console.warn(
          `Skill conflict: "${newSkill.name}" from "${newSkill.location}" overrides "${existingSkill.location}".`,
        );
      }
      skillMap.set(newSkill.name, newSkill);
    }

    this.skills = Array.from(skillMap.values());
  }

  /**
   * Returns the list of enabled discovered skills.
   */
  getSkills(): SkillDefinition[] {
    return this.skills.filter((s) => !s.disabled);
  }

  /**
   * Returns all discovered skills, including disabled ones.
   */
  getAllSkills(): SkillDefinition[] {
    return this.skills;
  }

  /**
   * Filters discovered skills by a predicate.
   */
  filterSkills(predicate: (skill: SkillDefinition) => boolean): void {
    this.skills = this.skills.filter(predicate);
  }

  /**
   * Sets the list of disabled skill names (case-insensitive).
   */
  setDisabledSkills(disabledNames: string[]): void {
    const lowercaseDisabledNames = disabledNames.map((n) => n.toLowerCase());
    for (const skill of this.skills) {
      skill.disabled = lowercaseDisabledNames.includes(
        skill.name.toLowerCase(),
      );
    }
  }

  /**
   * Reads a skill by name (case-insensitive).
   */
  getSkill(name: string): SkillDefinition | null {
    const lowercaseName = name.toLowerCase();
    return (
      this.skills.find((s) => s.name.toLowerCase() === lowercaseName) ?? null
    );
  }

  /**
   * Re-reads a skill from disk if its source file's mtime has changed
   * since the last load, keeping the in-memory body in sync with user edits.
   *
   * Behaviour:
   *  - If the skill is not found, returns null.
   *  - If the skill has no recorded mtime (e.g. built-in skills added via
   *    `addSkills()`), it is treated as frozen and returned as-is.
   *  - If the underlying file no longer reports an mtime, the cached entry
   *    is kept (we do NOT delete, to avoid flakiness from transient adapter
   *    failures). The stale body is returned.
   *  - If mtime is unchanged, returns the cached skill as-is.
   *  - If mtime has changed, reloads the skill from disk and replaces the
   *    in-memory entry. Returns the refreshed skill, or the previous cached
   *    entry if the reload fails.
   *
   * @param name - Skill name (case-insensitive).
   */
  async refreshSkillIfStale(name: string): Promise<SkillDefinition | null> {
    const skill = this.getSkill(name);
    if (!skill) {
      return null;
    }

    // Skills without an mtime are treated as frozen (e.g. built-in skills).
    if (skill.mtime === undefined) {
      return skill;
    }

    let currentMtime: number | null = null;
    try {
      currentMtime = await this.fsAdapter.getMtime(skill.location);
    } catch (err) {
      console.warn(
        `refreshSkillIfStale: getMtime failed for "${skill.location}":`,
        err,
      );
      return skill;
    }

    // Adapter could not determine mtime — keep the cached entry.
    if (currentMtime === null) {
      return skill;
    }

    if (skill.mtime === currentMtime) {
      return skill;
    }

    // mtime changed — reload from disk.
    const refreshed = await loadSkillFromFile(skill.location, this.fsAdapter);
    if (!refreshed) {
      // Reload failed (e.g. frontmatter now invalid). Keep stale copy
      // rather than silently removing the skill.
      console.warn(
        `refreshSkillIfStale: failed to reload "${skill.name}" from "${skill.location}"; keeping previous version.`,
      );
      return skill;
    }

    // Preserve flags that are NOT derived from the file itself.
    refreshed.disabled = skill.disabled;
    refreshed.isBuiltin = skill.isBuiltin;
    refreshed.tag = skill.tag;

    this.replaceSkillByLocation(skill.location, refreshed);
    return refreshed;
  }

  private replaceSkillByLocation(
    location: string,
    next: SkillDefinition,
  ): void {
    const idx = this.skills.findIndex((s) => s.location === location);
    if (idx >= 0) {
      this.skills[idx] = next;
    } else {
      this.skills.push(next);
    }
  }

  /**
   * Activates a skill by name (marks it as "in use" for the current session).
   */
  activateSkill(name: string): void {
    this.activeSkillNames.add(name);
  }

  /**
   * Checks if a skill is active.
   */
  isSkillActive(name: string): boolean {
    return this.activeSkillNames.has(name);
  }

  /**
   * Builds a system prompt snippet listing available skills as a *catalogue*
   * (name + description only). The full skill body is loaded on demand via
   * the `load_skill` tool — this is the "progressive disclosure" pattern,
   * keeping the initial context small while still letting the model discover
   * which skills exist.
   *
   * Equivalent to {@link buildSystemPromptForSkills} called with the
   * current enabled-skill set. Callers that want to render a *subset*
   * of skills (e.g. an embedding-based shortlist filtered by the
   * current user query — see `src/skills/skill-catalogue.ts`) should
   * use {@link buildSystemPromptForSkills} directly.
   *
   * @returns A formatted string to append to your system prompt, or an
   * empty string when no skills are enabled.
   */
  buildSystemPrompt(): string {
    return this.buildSystemPromptForSkills(this.getSkills());
  }

  /**
   * Render a catalogue of the *given* skill set as a system-prompt
   * snippet. Same wording / shape as {@link buildSystemPrompt} but
   * accepts the skill list as input, so callers can pass a filtered /
   * shortlisted subset without SkillManager having to know how the
   * subset was picked (embedding similarity, manual selection, etc).
   *
   * Pass a subset of {@link getSkills} — disabled skills slipped in
   * from elsewhere would be advertised here but rejected by
   * `load_skill`, so callers MUST filter `.disabled` themselves before
   * calling.
   *
   * @returns Catalogue text, or '' when `skills` is empty.
   */
  buildSystemPromptForSkills(skills: SkillDefinition[]): string {
    if (skills.length === 0) {
      return '';
    }

    const parts: string[] = [
      '## Available Skills',
      '',
      'Below is a catalogue of skills (name + short description). The full',
      'procedure body of each skill is kept out of context to save tokens',
      'and is fetched on demand via the `load_skill` tool.',
      '',
      'When a user request matches a listed skill AND that skill\'s full',
      'instructions have not already been provided earlier in this',
      'conversation, call `load_skill` with the skill name to retrieve',
      'its procedure, then follow it. If you already received a skill\'s',
      'instructions in a previous turn of this conversation, those',
      'instructions remain in context — reuse them directly and do NOT',
      'call `load_skill` again for the same skill.',
      '',
      'Skills catalogue:',
      '',
    ];

    for (const skill of skills) {
      parts.push(`- **${skill.name}**: ${skill.description}`);
    }

    return parts.join('\n');
  }
  /**
   * Builds the full instruction text for a single skill, intended to be
   * returned by the `load_skill` tool. Wraps the skill body with a header
   * so the model has clear context about which skill was just activated.
   *
   * @param name - Skill name (case-insensitive).
   * @returns Instruction text, or null when the skill is not found or disabled.
   */
  buildSkillInstructions(name: string): string | null {
    const skill = this.getSkill(name);
    if (!skill || skill.disabled) {
      return null;
    }

    // Derive the skill's containing directory from its SKILL.md location.
    // `location` is a vault-relative path to the SKILL.md file.
    // Using plain string slicing (not Node `path`) to keep behaviour
    // identical across desktop and mobile platforms.
    const loc = skill.location ?? '';
    const lastSlash = loc.lastIndexOf('/');
    const skillDir = lastSlash >= 0 ? loc.slice(0, lastSlash) : '';

    const parts: string[] = [
      `## Skill Activated: ${skill.name}`,
      '',
      `**Description:** ${skill.description}`,
    ];

    if (skillDir) {
      parts.push(
        '',
        `**Skill directory (vault-relative):** \`${skillDir}\``,
        '',
        '**Path hint:** File paths, links, or references that appear in the',
        'instructions below *may* be relative to the skill directory above',
        '(e.g. `./assets/foo.png`, `../shared/bar.md`, or bare names like',
        '`foo.md`). This is not guaranteed — treat it as a hint. When you',
        'need to pass such a path to a tool that expects a vault-relative',
        'path, resolve it by joining it onto the skill directory. Paths that',
        'clearly point elsewhere in the vault (e.g. starting with a top-level',
        'folder you recognise) should be used as-is.',
      );
    }

    parts.push(
      '',
      '**Instructions:**',
      '',
      skill.body,
    );
    return parts.join('\n');
  }
}
