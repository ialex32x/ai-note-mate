/**
 * Frontmatter utilities built on top of the Obsidian API.
 *
 * Obsidian ships its own YAML parser (`parseYaml` / `stringifyYaml`) and a
 * frontmatter block locator (`getFrontMatterInfo`). Combined with
 * `metadataCache.getFileCache().frontmatter` (pre-parsed, cached) and
 * `fileManager.processFrontMatter` (atomic read-modify-write), these cover
 * every frontmatter use case in this plugin without pulling in `js-yaml`.
 *
 * This module centralises those primitives so the rest of the codebase can
 * work against a single, stable surface.
 */

import {
    type App,
    type DataWriteOptions,
    type TFile,
    getFrontMatterInfo,
    parseYaml,
    stringifyYaml,
} from "obsidian";

// Re-export the raw YAML helpers for callers that genuinely need them.
// Prefer the higher-level helpers below whenever possible.
export { parseYaml, stringifyYaml, getFrontMatterInfo };

/**
 * Result of splitting raw file content into frontmatter + body.
 */
export interface ParsedFrontmatter {
    /** Whether a frontmatter block was present. */
    exists: boolean;
    /** Parsed frontmatter object, or null when absent / unparseable. */
    frontmatter: Record<string, unknown> | null;
    /** File body with the frontmatter block stripped. If no frontmatter, this is the original content. */
    body: string;
}

/**
 * Options for {@link parseFrontmatterFromContent}.
 */
export interface ParseFrontmatterOptions {
    /**
     * When the primary YAML parse fails (e.g. an unquoted value contains a
     * colon), attempt a permissive line-by-line `key: value` fallback that
     * only recognises top-level scalar and simple multi-line keys.
     *
     * This is intended for lightweight metadata formats like SKILL.md where
     * robustness against authoring mistakes matters more than full YAML
     * fidelity. Defaults to `false`.
     */
    permissiveFallback?: boolean;
}

/**
 * Parse frontmatter from the raw text content of a markdown-like file.
 *
 * This is the right entry point when you only have the file's text — for
 * example, content loaded via an abstract filesystem adapter where no `TFile`
 * exists. When you do have a `TFile`, prefer {@link getFileFrontmatter},
 * which reads from the already-parsed metadata cache and avoids re-parsing.
 */
export function parseFrontmatterFromContent(
    content: string,
    options: ParseFrontmatterOptions = {},
): ParsedFrontmatter {
    const info = getFrontMatterInfo(content);
    if (!info.exists) {
        return { exists: false, frontmatter: null, body: content };
    }

    const body = content.slice(info.contentStart);

    let frontmatter: Record<string, unknown> | null = null;
    try {
        const parsed: unknown = parseYaml(info.frontmatter);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            frontmatter = parsed as Record<string, unknown>;
        }
    } catch {
        // Fall through — may attempt permissive fallback below.
    }

    if (!frontmatter && options.permissiveFallback) {
        frontmatter = parsePermissiveFrontmatter(info.frontmatter);
    }

    return { exists: true, frontmatter, body };
}

/**
 * Read the pre-parsed frontmatter for a vault file from Obsidian's metadata
 * cache. This is a zero-parse read and the preferred path for any `TFile`.
 *
 * Returns `null` when the cache has no entry for the file, or when the file
 * has no frontmatter block. A returned object is a **snapshot** — do not
 * mutate it to persist changes. Use {@link updateFileFrontmatter} for writes.
 */
export function getFileFrontmatter(
    app: App,
    file: TFile,
): Record<string, unknown> | null {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm || typeof fm !== "object") return null;
    return fm as Record<string, unknown>;
}

/**
 * Atomically read, mutate, and write the frontmatter of a markdown file.
 *
 * Thin wrapper around `app.fileManager.processFrontMatter` — exposed here so
 * frontmatter writes flow through one well-known helper and are trivial to
 * adjust later (e.g. for logging or error shaping).
 *
 * The mutator receives a JS object representing the current frontmatter and
 * should mutate it in place (add/delete/reassign keys). YAML formatting,
 * quoting, and key ordering are preserved by Obsidian.
 */
export function updateFileFrontmatter(
    app: App,
    file: TFile,
    mutator: (frontmatter: Record<string, unknown>) => void,
    options?: DataWriteOptions,
): Promise<void> {
    return app.fileManager.processFrontMatter(
        file,
        (fm: Record<string, unknown>) => {
            mutator(fm);
        },
        options,
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Permissive fallback (internal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple line-oriented frontmatter parser used when strict YAML parsing fails
 * and the caller opted into a permissive fallback.
 *
 * Only recognises top-level `key: value` pairs with optional indented
 * continuation lines for multi-line values. This is intentionally minimal —
 * it exists to salvage authoring mistakes (unquoted colons inside values) in
 * lightweight metadata files, not to reimplement YAML.
 */
function parsePermissiveFrontmatter(
    content: string,
): Record<string, unknown> | null {
    const lines = content.split(/\r?\n/);
    const out: Record<string, unknown> = {};
    let matched = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;

        const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (!m) continue;

        const key = m[1]!;
        const head = (m[2] ?? "").trim();
        const parts = [head];

        // Absorb indented continuation lines (a simple multi-line scalar).
        while (i + 1 < lines.length) {
            const next = lines[i + 1];
            if (next && /^[ \t]+\S/.test(next)) {
                parts.push(next.trim());
                i++;
            } else {
                break;
            }
        }

        out[key] = parts.filter(Boolean).join(" ");
        matched = true;
    }

    return matched ? out : null;
}
