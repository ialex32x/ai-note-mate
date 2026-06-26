/**
 * Parsing for note-defined custom agents.
 *
 * A custom agent is a single markdown note in the vault. Its shape:
 *   - Frontmatter `tools`: tool-name patterns the agent may use, e.g.
 *     `["mcp_xxx_*", "mcp_test_*"]`. Accepts a YAML array OR a single
 *     comma / newline separated string for authoring convenience.
 *   - Markdown body: the agent's prompt (frontmatter stripped).
 *
 * Users author and edit these notes directly; the settings UI only manages
 * the list of note paths and renders a read-only preview produced here.
 */

import { type App, TFile, normalizePath } from "obsidian";
import { parseFrontmatterFromContent } from "../../utils/frontmatter";

/**
 * Parsed representation of a custom-agent note. See the module comment for
 * the source format.
 */
export interface CustomAgentConfig {
	/**
	 * Tool-name patterns from the frontmatter `tools` field (e.g.
	 * `"mcp_xxx_*"`). Empty when the field is absent or blank.
	 */
	tools: string[];
	/** Agent prompt — the note body with the frontmatter block stripped. */
	prompt: string;
}

/**
 * Normalise the raw frontmatter `tools` value into a clean string list.
 *
 * Accepts the natural YAML array form as well as a single string (split on
 * commas and newlines) so users don't have to remember exact YAML list
 * syntax. Non-string array members are coerced via `String(...)`; blank
 * entries are dropped and duplicates removed while preserving first-seen
 * order for stable previews.
 */
export function normalizeAgentTools(raw: unknown): string[] {
	let parts: string[];
	if (Array.isArray(raw)) {
		parts = raw.map(v => String(v));
	} else if (typeof raw === "string") {
		parts = raw.split(/[,\n]/);
	} else {
		return [];
	}

	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of parts) {
		const trimmed = part.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

/**
 * Parse raw note content (frontmatter + body) into a {@link CustomAgentConfig}.
 *
 * Pure / synchronous — the caller is responsible for obtaining the content.
 * Prefer {@link loadCustomAgentConfig} when you have an {@link App} and a
 * vault-relative path.
 */
export function parseCustomAgentContent(content: string): CustomAgentConfig {
	const parsed = parseFrontmatterFromContent(content);
	const tools = normalizeAgentTools(parsed.frontmatter?.tools);
	return {
		tools,
		prompt: parsed.body.trim(),
	};
}

/**
 * Load and parse a custom-agent note by vault-relative path.
 *
 * Returns `null` when the path is empty or does not resolve to a markdown
 * file, so callers can distinguish "unconfigured / missing" from a parsed
 * (possibly empty) config. Read errors propagate to the caller.
 */
export async function loadCustomAgentConfig(
	app: App,
	path: string,
): Promise<CustomAgentConfig | null> {
	const raw = path.trim();
	if (!raw) return null;
	const file = app.vault.getAbstractFileByPath(normalizePath(raw));
	if (!(file instanceof TFile)) return null;
	const content = await app.vault.cachedRead(file);
	return parseCustomAgentContent(content);
}
