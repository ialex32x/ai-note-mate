import { TFile, getAllTags } from "obsidian";
import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool, ToolCallResult } from "../../chat-stream";
import type { ToolCapability } from "../../llm-provider";
import { isFailure, requireFile } from "./_shared";

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all tags for a markdown file by consulting the metadata cache.
 * Tags come from two sources: inline `#tag` occurrences and the YAML frontmatter `tags` field.
 * The returned tags always start with `#` and are deduplicated.
 */
function collectTagsForFile(plugin: NoteAssistantPlugin, file: TFile): string[] {
    const cache = plugin.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    const raw = getAllTags(cache);
    if (!raw) return [];
    return Array.from(new Set(raw));
}

/**
 * Normalise a user-supplied tag name to a canonical form WITHOUT the leading '#'.
 * Returns null if the input is empty or contains characters that are clearly not tag-safe.
 *
 * We intentionally accept the same character set Obsidian uses for tags
 * (alphanumerics, underscore, hyphen, forward-slash for nesting, plus Unicode letters).
 * This is permissive on purpose so we don't reject valid international tags.
 */
function normaliseTagName(raw: string): string | null {
    if (typeof raw !== "string") return null;
    let t = raw.trim();
    if (t.length === 0) return null;
    if (t.startsWith("#")) t = t.substring(1);
    if (t.length === 0) return null;
    // Reject obvious whitespace / quote / yaml special chars
    if (/[\s"'`,\[\]{}]/.test(t)) return null;
    // Strip any leading or trailing slashes (nesting separator should not be at the edges)
    if (t.startsWith("/") || t.endsWith("/")) return null;
    return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_list_tags
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate all tags across the vault.
 */
export function vaultListTags(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_list_tags",
                description:
                    "List all tags used across the vault with their occurrence counts (number of notes using each tag). " +
                    "Optionally filter by a prefix to narrow down to a tag namespace (e.g. 'project/'). " +
                    "Tags are returned in the '#tag' format. " +
                    "Use this when the user wants to see which tags exist, explore their tag taxonomy, " +
                    "find related tags, or when you need to discover tag vocabulary before searching for notes.",
                parameters: {
                    type: "object",
                    properties: {
                        prefix: {
                            type: "string",
                            description:
                                "Optional tag prefix filter. Can be provided with or without the leading '#'. " +
                                "Example: 'project/' returns all sub-tags of #project. Omit to list all tags.",
                        },
                        limit: {
                            type: "number",
                            description:
                                "Maximum number of tags to return, sorted by descending note count. Defaults to 100.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of tags to skip. Defaults to 0. " +
                                "Set to previous skip + number of returned tags to fetch the next page when has_more is true.",
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const rawPrefix = args["prefix"] as string | undefined;
            const limit = (args["limit"] as number) ?? 100;
            const skip = Math.max(0, (args["skip"] as number) ?? 0);

            // Normalise prefix: always matches against the leading '#' form
            let prefix: string | undefined;
            if (rawPrefix && rawPrefix.length > 0) {
                prefix = rawPrefix.startsWith("#") ? rawPrefix : "#" + rawPrefix;
            }

            const counts = new Map<string, number>();
            for (const file of plugin.app.vault.getMarkdownFiles()) {
                const tags = collectTagsForFile(plugin, file);
                for (const tag of tags) {
                    if (prefix && !tag.startsWith(prefix)) continue;
                    counts.set(tag, (counts.get(tag) ?? 0) + 1);
                }
            }

            const sorted = [...counts.entries()]
                .map(([tag, count]) => ({ tag, count }))
                .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

            const totalUniqueTags = counts.size;
            const paginated = sorted.slice(skip, skip + limit);
            const hasMore = skip + paginated.length < totalUniqueTags;

            return {
                success: true,
                type: "object",
                content: {
                    total_unique_tags: totalUniqueTags,
                    has_more: hasMore,
                    skip,
                    tags: paginated,
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_search_by_tag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find all markdown files that carry the specified tag (exact or prefix match).
 */
export function vaultSearchByTag(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_search_by_tag",
                description:
                    "Find all markdown notes that carry any of the given tags. " +
                    "ALWAYS batch multiple tags into a single call (up to 10) — NEVER issue separate calls for each tag. " +
                    "A file is included if it matches ANY of the provided tags (OR semantics). " +
                    "Each returned file lists which of the searched tags it matched in its matched_tags field, " +
                    "so you can derive per-tag counts from a single batch call without querying tags individually. " +
                    "By default matches each tag exactly; set 'include_descendants' to true to also match nested sub-tags " +
                    "(e.g. tag='project' with descendants matches #project/alpha, #project/beta, etc.).",
                parameters: {
                    type: "object",
                    properties: {
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Array of tags to search for (1–10 tags), with or without the leading '#'. " +
                                "Example: ['project', '#review'].",
                        },
                        include_descendants: {
                            type: "boolean",
                            description:
                                "If true, also match nested sub-tags (e.g. tag='project' matches #project/alpha). " +
                                "Defaults to false (exact match only).",
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of matching files to return. Defaults to 200.",
                        },
                        skip: {
                            type: "number",
                            description:
                                "Number of matching results to skip. Defaults to 0. " +
                                "Set to previous skip + count to fetch the next page when has_more is true.",
                        },
                    },
                    required: ["tags"],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const rawTags = args["tags"] as string[];
            const includeDescendants = (args["include_descendants"] as boolean) ?? false;
            const limit = (args["limit"] as number) ?? 200;
            const skip = Math.max(0, (args["skip"] as number) ?? 0);

            if (!Array.isArray(rawTags) || rawTags.length === 0) {
                return { success: false, type: "text", content: "tags must be a non-empty array of tag names." };
            }
            if (rawTags.length > 10) {
                return { success: false, type: "text", content: `Too many tags (${rawTags.length}); maximum is 10.` };
            }

            // Normalise all tags and build matchers
            const normalized = rawTags.map((raw) => {
                if (!raw || raw.trim() === "") return null;
                const n = raw.startsWith("#") ? raw : "#" + raw;
                return { original: raw, normalized: n, prefix: n.endsWith("/") ? n : n + "/" };
            });

            const invalidTag = normalized.find((n) => n === null);
            if (invalidTag) {
                return { success: false, type: "text", content: "Each tag must be a non-empty string." };
            }

            const tagMatchers = normalized as NonNullable<typeof normalized[number]>[];

            const matchesTag = (t: string): boolean => {
                for (const m of tagMatchers) {
                    if (t === m.normalized) return true;
                    if (includeDescendants && t.startsWith(m.prefix)) return true;
                }
                return false;
            };

            // Collect ALL matching files (do not break early — we need total count for pagination)
            const seen = new Set<string>();
            const allMatches: { path: string; mtime: number; matched_tags: string[] }[] = [];

            for (const file of plugin.app.vault.getMarkdownFiles()) {
                if (seen.has(file.path)) continue;

                const fileTags = collectTagsForFile(plugin, file);
                const matched: string[] = [];
                for (const ft of fileTags) {
                    if (matchesTag(ft)) {
                        matched.push(ft);
                    }
                }

                if (matched.length > 0) {
                    seen.add(file.path);
                    allMatches.push({ path: file.path, mtime: file.stat.mtime, matched_tags: matched });
                }
            }

            // Sort by mtime descending (most recently modified first) for deterministic pagination
            allMatches.sort((a, b) => b.mtime - a.mtime);

            const totalMatches = allMatches.length;
            const files = allMatches.slice(skip, skip + limit);
            const hasMore = skip + files.length < totalMatches;

            return {
                success: true,
                type: "object",
                content: {
                    searched_tags: tagMatchers.map((m) => m.normalized),
                    include_descendants: includeDescendants,
                    total_matches: totalMatches,
                    has_more: hasMore,
                    skip,
                    count: files.length,
                    files,
                },
            };
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared tag-rewrite primitives (used by both rename and edit)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decide what to do with a single bare-tag string under a given operation.
 * Returns:
 *   - a non-empty string → the new bare tag to use in its place (rename)
 *   - the empty string  → remove this tag entirely
 *   - null              → leave this tag untouched
 */
type TagOp =
    | { kind: "rename"; oldBare: string; newBare: string; includeDescendants: boolean }
    | { kind: "remove"; targetBares: string[]; includeDescendants: boolean };

function applyTagOp(bareTag: string, op: TagOp): string | null {
    if (op.kind === "rename") {
        if (bareTag === op.oldBare) return op.newBare;
        if (op.includeDescendants && bareTag.startsWith(op.oldBare + "/")) {
            return op.newBare + bareTag.substring(op.oldBare.length);
        }
        return null;
    }
    // remove
    for (const t of op.targetBares) {
        if (bareTag === t) return ""; // exact match → remove
        if (op.includeDescendants && bareTag.startsWith(t + "/")) return "";
    }
    return null;
}

/**
 * Rewrite a frontmatter tag value (which may or may not be prefixed with '#').
 * Returns:
 *   - non-empty string → replacement value (with original '#' style preserved)
 *   - empty string    → remove this entry entirely
 *   - null            → leave unchanged
 */
function applyOpToFrontmatterValue(value: string, op: TagOp): string | null {
    if (typeof value !== "string") return null;
    const hadHash = value.startsWith("#");
    const bare = hadHash ? value.substring(1) : value;
    const result = applyTagOp(bare, op);
    if (result === null) return null;
    if (result === "") return ""; // signal removal
    return hadHash ? "#" + result : result;
}

/**
 * Apply a tag operation to the frontmatter `tags`/`tag` fields in-place.
 * - rename → individual entries are rewritten
 * - remove → matching entries are spliced out; if the field becomes empty, the key is deleted
 * Returns the number of individual entries that were rewritten or removed.
 */
function rewriteFrontmatterTags(fm: Record<string, unknown>, op: TagOp): number {
    let changed = 0;
    for (const key of ["tags", "tag"]) {
        if (!(key in fm)) continue;
        const cur = fm[key];

        if (typeof cur === "string") {
            // Two valid YAML forms:
            //   tags: foo
            //   tags: "foo, bar baz"  (Obsidian splits on whitespace/commas)
            // We split, apply, then re-join with the same delimiter style we detected.
            const parts = cur.split(/([,\s]+)/); // keep delimiters
            let anyChanged = false;
            const kept: string[] = [];
            for (let i = 0; i < parts.length; i++) {
                const cell = parts[i] ?? "";
                if (i % 2 === 1) {
                    // delimiter — only keep if last kept piece is a tag (avoid leading/trailing/double separators)
                    kept.push(cell);
                    continue;
                }
                if (!cell) {
                    kept.push(cell);
                    continue;
                }
                const result = applyOpToFrontmatterValue(cell, op);
                if (result === null) {
                    kept.push(cell);
                } else if (result === "") {
                    // removed — also drop the trailing delimiter we just pushed
                    const last = kept[kept.length - 1];
                    if (kept.length > 0 && last !== undefined && /^[,\s]+$/.test(last)) {
                        kept.pop();
                    }
                    anyChanged = true;
                    changed++;
                } else {
                    kept.push(result);
                    anyChanged = true;
                    changed++;
                }
            }
            if (anyChanged) {
                const joined = kept.join("").replace(/^[,\s]+|[,\s]+$/g, "");
                if (joined.length === 0) {
                    delete fm[key];
                } else {
                    fm[key] = joined;
                }
            }
        } else if (Array.isArray(cur)) {
            const next: unknown[] = [];
            for (let i = 0; i < cur.length; i++) {
                const item = cur[i];
                if (typeof item !== "string") {
                    next.push(item);
                    continue;
                }
                const result = applyOpToFrontmatterValue(item, op);
                if (result === null) {
                    next.push(item);
                } else if (result === "") {
                    changed++;
                } else {
                    next.push(result);
                    changed++;
                }
            }
            if (next.length !== cur.length || next.some((v, i) => v !== cur[i])) {
                if (next.length === 0) {
                    delete fm[key];
                } else {
                    fm[key] = next;
                }
            }
        }
        // Other shapes (object/null/number) are ignored — Obsidian wouldn't treat them as tags either.
    }
    return changed;
}

/**
 * Apply a tag operation to inline `#tag` occurrences in the file body using the precise positions
 * reported by the metadata cache. Replacements are applied from the end of the file backwards so
 * earlier offsets stay valid.
 *
 * For rename, the `#tag` occurrence is rewritten in place.
 * For remove, the `#tag` occurrence (and any single trailing space/tab on the same line) is deleted
 * so we don't leave behind double spaces.
 *
 * Returns `{ newContent, count }`. When count is 0, content is returned unchanged.
 */
function rewriteInlineTags(
    content: string,
    cacheTags: { tag: string; from: number; to: number }[],
    op: TagOp,
): { newContent: string; count: number } {
    if (cacheTags.length === 0) return { newContent: content, count: 0 };

    // Sort by start offset descending so each replacement leaves earlier offsets intact.
    const sorted = [...cacheTags].sort((a, b) => b.from - a.from);

    let result = content;
    let count = 0;

    for (const t of sorted) {
        // The cache stores the tag including the leading '#'.
        const cachedRaw = t.tag.startsWith("#") ? t.tag.substring(1) : t.tag;
        const opResult = applyTagOp(cachedRaw, op);
        if (opResult === null) continue;

        // Defensive: verify that the slice at [from, to) actually still looks like a hash-tag.
        // (Metadata cache may be stale relative to disk content; if so, skip rather than corrupt the file.)
        const slice = result.substring(t.from, t.to);
        if (!slice.startsWith("#")) continue;
        const sliceBare = slice.substring(1);
        if (sliceBare !== cachedRaw) continue;

        if (opResult === "") {
            // Removal: also consume one trailing inline whitespace (space/tab) to avoid leaving a double-space gap.
            // Newlines are preserved so we don't merge a tag-only line into the next paragraph.
            let endCut = t.to;
            const nextCh = result.charAt(endCut);
            if (nextCh === " " || nextCh === "\t") {
                endCut += 1;
            }
            result = result.substring(0, t.from) + result.substring(endCut);
        } else {
            result = result.substring(0, t.from) + "#" + opResult + result.substring(t.to);
        }
        count++;
    }

    return { newContent: result, count };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_rename_tag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-file change record produced by the rename pass.
 */
interface RenameTagFileResult {
    path: string;
    inline_replacements: number;
    frontmatter_replacements: number;
}

/**
 * Rename a tag (and optionally its descendants) across every markdown note in the vault.
 *
 * Inline `#tag` references are rewritten using the precise offsets reported by Obsidian's
 * metadata cache, which avoids the boundary / partial-word pitfalls of plain text replacement.
 * Frontmatter tags are rewritten via `app.fileManager.processFrontMatter`, which preserves
 * YAML formatting and quoting safely.
 */
export function vaultRenameTag(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_rename_tag",
                description:
                    "Rename a tag (and optionally all of its nested sub-tags) across every markdown note in the vault. " +
                    "Rewrites both inline '#tag' occurrences AND YAML frontmatter tag entries (under 'tags' or 'tag') in a single atomic operation per file. " +
                    "Inline replacements use the metadata cache's precise offsets, so they will NOT accidentally touch words like 'XYZ' or '#X-foo' when renaming '#X'. " +
                    "When include_descendants is true, '#X/alpha' is also renamed to '#Y/alpha', preserving the sub-path. " +
                    "Always run with dry_run=true first to preview the impact (file count, occurrence count) before applying. " +
                    "Use this whenever the user wants to rename, refactor, merge, or move a tag across the whole vault — much safer and cheaper than looping vault_replace_text over many files. " +
                    "If the user only wants to add/remove/set tags on specific notes (rather than rename everywhere), use vault_edit_file_tags instead.",
                parameters: {
                    type: "object",
                    properties: {
                        old_tag: {
                            type: "string",
                            description:
                                "The existing tag to rename, with or without the leading '#'. " +
                                "Example: 'project' or '#project'.",
                        },
                        new_tag: {
                            type: "string",
                            description:
                                "The new tag name, with or without the leading '#'. " +
                                "Must be a non-empty, valid tag identifier (no whitespace, quotes, or YAML special characters). " +
                                "Example: 'work/project' or '#work/project'.",
                        },
                        include_descendants: {
                            type: "boolean",
                            description:
                                "If true, also rename every nested sub-tag, preserving the sub-path " +
                                "(e.g. old_tag='project', new_tag='work' will rewrite '#project/alpha' to '#work/alpha'). " +
                                "Defaults to false (rename the exact tag only).",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, return the per-file impact report without modifying any files. " +
                                "Defaults to false. Strongly recommended to run once with dry_run=true first.",
                        },
                    },
                    required: ["old_tag", "new_tag"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const oldBare = normaliseTagName(args["old_tag"] as string);
            const newBare = normaliseTagName(args["new_tag"] as string);
            const includeDescendants = (args["include_descendants"] as boolean) ?? false;
            const dryRun = (args["dry_run"] as boolean) ?? false;

            if (oldBare === null) {
                return { success: false, type: "text", content: "old_tag must be a non-empty, valid tag name." };
            }
            if (newBare === null) {
                return { success: false, type: "text", content: "new_tag must be a non-empty, valid tag name." };
            }
            if (oldBare === newBare) {
                return {
                    success: false,
                    type: "text",
                    content: `old_tag and new_tag are identical ('${oldBare}'); nothing to rename.`,
                };
            }

            const op: TagOp = { kind: "rename", oldBare, newBare, includeDescendants };

            // Identify all candidate files via the metadata cache.
            // A file is a candidate if any of its tags equals '#oldBare' (or starts with '#oldBare/' when descendants are included).
            const oldHash = "#" + oldBare;
            const oldHashPrefix = oldHash + "/";

            const fileResults: RenameTagFileResult[] = [];
            let totalInline = 0;
            let totalFrontmatter = 0;
            const skipped: { path: string; reason: string }[] = [];

            for (const file of plugin.app.vault.getMarkdownFiles()) {
                const tagsInFile = collectTagsForFile(plugin, file);
                const matches = tagsInFile.some(
                    (t) => t === oldHash || (includeDescendants && t.startsWith(oldHashPrefix)),
                );
                if (!matches) continue;

                const cache = plugin.app.metadataCache.getFileCache(file);
                const inlineCacheEntries = (cache?.tags ?? []).map((entry) => ({
                    tag: entry.tag,
                    from: entry.position.start.offset,
                    to: entry.position.end.offset,
                }));

                // ─── Inline pass ───────────────────────────────────────────────
                let inlineCount = 0;
                if (inlineCacheEntries.length > 0) {
                    const content = await plugin.app.vault.read(file);
                    const { newContent, count } = rewriteInlineTags(content, inlineCacheEntries, op);
                    inlineCount = count;
                    if (count > 0 && !dryRun) {
                        await plugin.app.vault.modify(file, newContent);
                    }
                }

                // ─── Frontmatter pass ──────────────────────────────────────────
                // Note: we run the frontmatter pass even on dry_run, but pre-compute the count without writing.
                let frontmatterCount = 0;

                if (dryRun) {
                    // Compute count without mutating the file, by inspecting the cached frontmatter snapshot.
                    const fm = cache?.frontmatter;
                    if (fm) {
                        // Clone shallowly so the simulated rewrite does not mutate the live cache.
                        const fmClone: Record<string, unknown> = { ...fm };
                        for (const key of ["tags", "tag"]) {
                            const v = (fm as Record<string, unknown>)[key];
                            if (Array.isArray(v)) fmClone[key] = [...v];
                        }
                        frontmatterCount = rewriteFrontmatterTags(fmClone, op);
                    }
                } else {
                    try {
                        await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                            frontmatterCount = rewriteFrontmatterTags(fm, op);
                        });
                    } catch (err) {
                        skipped.push({
                            path: file.path,
                            reason: `processFrontMatter failed: ${(err as Error)?.message ?? String(err)}`,
                        });
                    }
                }

                if (inlineCount > 0 || frontmatterCount > 0) {
                    fileResults.push({
                        path: file.path,
                        inline_replacements: inlineCount,
                        frontmatter_replacements: frontmatterCount,
                    });
                    totalInline += inlineCount;
                    totalFrontmatter += frontmatterCount;
                }
            }

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? "dry_run_rename_tag" : "tag_renamed",
                    old_tag: oldHash,
                    new_tag: "#" + newBare,
                    include_descendants: includeDescendants,
                    dry_run: dryRun,
                    files_changed: fileResults.length,
                    total_inline_replacements: totalInline,
                    total_frontmatter_replacements: totalFrontmatter,
                    files: fileResults,
                    ...(skipped.length > 0 ? { skipped } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: vault_edit_file_tags
// ─────────────────────────────────────────────────────────────────────────────

interface EditTagsFileResult {
    path: string;
    /** Number of inline `#tag` occurrences added, removed, or modified. */
    inline_changes: number;
    /** Number of frontmatter tag entries added, removed, or modified. */
    frontmatter_changes: number;
    /** Tags that were attempted but turned out to be a no-op for this file (e.g. add of an existing tag). */
    no_op_tags?: string[];
}

/**
 * Add, remove, or set tags on one or more specific notes.
 *
 * Unlike `vault_rename_tag` (which operates on the whole vault), this tool targets a small list of
 * files explicitly chosen by the caller. Frontmatter writes go through `processFrontMatter`, and
 * inline edits use the metadata cache's precise offsets, so neither YAML structure nor in-body
 * prose can get corrupted by the kind of accidents `vault_replace_text` is prone to.
 */
export function vaultEditFileTags(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "vault_edit_file_tags",
                description:
                    "Add, remove, or set (overwrite) tags on one or more specific notes. " +
                    "This is the ONLY safe way to edit tags on individual files — do NOT use vault_replace_text for tag edits, " +
                    "as it cannot reliably distinguish '#X' from '#XYZ', and cannot safely modify YAML frontmatter. " +
                    "Frontmatter is updated via the official processFrontMatter API (preserves YAML structure, quoting, key order). " +
                    "Inline '#tag' occurrences are located via the metadata cache's exact offsets. " +
                    "Operations are idempotent: adding an existing tag or removing a missing tag is a no-op, not an error. " +
                    "If the user wants to rename a tag everywhere across the entire vault, use vault_rename_tag instead.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "Vault-relative paths of the markdown files to edit (1 or more). " +
                                "All paths must point to existing markdown files.",
                        },
                        op: {
                            type: "string",
                            enum: ["add", "remove", "set"],
                            description:
                                "The operation to perform: " +
                                "'add' = add the given tags (skipping any already present); " +
                                "'remove' = remove the given tags (skipping any not present); " +
                                "'set' = replace the file's frontmatter tags with exactly the given list (deduplicated). " +
                                "'set' deliberately does NOT touch inline '#tag' occurrences in the body (use 'remove' explicitly for that).",
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "List of tag names to add / remove / set, with or without the leading '#'. " +
                                "Must be non-empty for 'add' and 'remove'. May be empty for 'set' to clear frontmatter tags. " +
                                "Example: ['todo', '#project/alpha'].",
                        },
                        location: {
                            type: "string",
                            enum: ["frontmatter", "inline", "auto"],
                            description:
                                "Where to apply the operation. " +
                                "Defaults: 'add' → 'auto' (writes to frontmatter); 'remove' → 'auto' (removes from BOTH frontmatter and inline); 'set' → 'frontmatter' (does not touch inline). " +
                                "'frontmatter' = only edit YAML frontmatter tags. " +
                                "'inline' = only edit inline '#tag' occurrences in the body (for 'add', appends '#tag' on a new line at end of file). " +
                                "'auto' = the default behaviour described above.",
                        },
                        include_descendants: {
                            type: "boolean",
                            description:
                                "Only used when op='remove'. If true, also remove every nested sub-tag " +
                                "(e.g. removing 'project' will also remove '#project/alpha', '#project/beta', etc.). " +
                                "Defaults to false (exact match only).",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, return the per-file impact report without modifying any files. " +
                                "Defaults to false.",
                        },
                    },
                    required: ["paths", "op", "tags"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal): Promise<ToolCallResult> => {
            const rawPaths = args["paths"];
            const opName = args["op"] as string;
            const rawTags = args["tags"];
            const rawLocation = (args["location"] as string | undefined) ?? "auto";
            const includeDescendants = (args["include_descendants"] as boolean) ?? false;
            const dryRun = (args["dry_run"] as boolean) ?? false;

            // ─── Validate paths ───────────────────────────────────────────
            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return { success: false, type: "text", content: "paths must be a non-empty array of vault-relative file paths." };
            }
            if (rawPaths.some((p) => typeof p !== "string" || p.length === 0)) {
                return { success: false, type: "text", content: "Each entry in paths must be a non-empty string." };
            }
            const paths = rawPaths as string[];

            // ─── Validate op ──────────────────────────────────────────────
            if (opName !== "add" && opName !== "remove" && opName !== "set") {
                return { success: false, type: "text", content: `Invalid op '${opName}'; must be one of 'add', 'remove', 'set'.` };
            }

            // ─── Validate location ────────────────────────────────────────
            if (rawLocation !== "frontmatter" && rawLocation !== "inline" && rawLocation !== "auto") {
                return { success: false, type: "text", content: `Invalid location '${rawLocation}'; must be 'frontmatter', 'inline', or 'auto'.` };
            }

            // ─── Validate tags ────────────────────────────────────────────
            if (!Array.isArray(rawTags)) {
                return { success: false, type: "text", content: "tags must be an array of tag names." };
            }
            if ((opName === "add" || opName === "remove") && rawTags.length === 0) {
                return { success: false, type: "text", content: `tags must be non-empty for op='${opName}'.` };
            }
            const bareTags: string[] = [];
            for (const t of rawTags) {
                if (typeof t !== "string") {
                    return { success: false, type: "text", content: "Each tag must be a string." };
                }
                const n = normaliseTagName(t);
                if (n === null) {
                    return { success: false, type: "text", content: `Invalid tag name: '${t}'.` };
                }
                bareTags.push(n);
            }
            // De-duplicate while preserving order
            const uniqueBareTags = Array.from(new Set(bareTags));

            // ─── Resolve effective location (auto → concrete) ─────────────
            // add: auto = frontmatter
            // remove: auto = both
            // set: auto = frontmatter (set never touches inline by design)
            type EffLocation = "frontmatter" | "inline" | "both";
            let effLocation: EffLocation;
            if (rawLocation === "frontmatter") effLocation = "frontmatter";
            else if (rawLocation === "inline") effLocation = "inline";
            else {
                // auto
                if (opName === "remove") effLocation = "both";
                else effLocation = "frontmatter";
            }
            // Hard rule: 'set' never modifies inline regardless of location, except when caller
            // explicitly selected 'inline' (in which case we respect them but warn via response).
            // For simplicity: 'set' + 'inline' is rejected — it's almost certainly a misuse.
            if (opName === "set" && effLocation === "inline") {
                return {
                    success: false,
                    type: "text",
                    content: "op='set' cannot be combined with location='inline'. Use op='remove' (with all current inline tags) followed by op='add' (with new ones), or omit location to default to frontmatter.",
                };
            }

            // ─── Resolve all files up front so we can fail fast on bad paths ─
            const files: TFile[] = [];
            for (const p of paths) {
                const f = requireFile(plugin.app, p);
                if (isFailure(f)) return f;
                if (!(f instanceof TFile) || f.extension !== "md") {
                    return { success: false, type: "text", content: `Not a markdown file: ${p}` };
                }
                files.push(f);
            }

            // Build the underlying TagOp for inline / frontmatter rewrite passes.
            // For 'add' there is no rewrite-style op — we add tags directly via processFrontMatter / append.
            // For 'set' we treat frontmatter as a wholesale overwrite (no rewrite-op pass needed).
            const removeOp: TagOp | null =
                opName === "remove"
                    ? { kind: "remove", targetBares: uniqueBareTags, includeDescendants }
                    : null;

            const fileResults: EditTagsFileResult[] = [];
            const skipped: { path: string; reason: string }[] = [];
            let totalInline = 0;
            let totalFrontmatter = 0;

            for (const file of files) {
                let inlineChanges = 0;
                let frontmatterChanges = 0;
                const noOpTags: string[] = [];

                // ────────────────── ADD ──────────────────
                if (opName === "add") {
                    // Determine which tags are already present (so we don't re-add).
                    const existing = new Set(
                        collectTagsForFile(plugin, file).map((t) => (t.startsWith("#") ? t.substring(1) : t)),
                    );
                    const tagsToAdd = uniqueBareTags.filter((t) => {
                        if (existing.has(t)) {
                            noOpTags.push("#" + t);
                            return false;
                        }
                        return true;
                    });

                    if (tagsToAdd.length > 0) {
                        if (effLocation === "frontmatter" || effLocation === "both") {
                            if (!dryRun) {
                                try {
                                    await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                                        frontmatterChanges = addTagsToFrontmatter(fm, tagsToAdd);
                                    });
                                } catch (err) {
                                    skipped.push({
                                        path: file.path,
                                        reason: `processFrontMatter failed: ${(err as Error)?.message ?? String(err)}`,
                                    });
                                    continue;
                                }
                            } else {
                                // Dry-run: simulate against the cached frontmatter snapshot.
                                const cache = plugin.app.metadataCache.getFileCache(file);
                                const fm = cache?.frontmatter;
                                const fmClone: Record<string, unknown> = fm ? { ...fm } : {};
                                if (fm) {
                                    for (const key of ["tags", "tag"]) {
                                        const v = (fm as Record<string, unknown>)[key];
                                        if (Array.isArray(v)) fmClone[key] = [...v];
                                    }
                                }
                                frontmatterChanges = addTagsToFrontmatter(fmClone, tagsToAdd);
                            }
                        }
                        if (effLocation === "inline") {
                            // Append '#tag1 #tag2 ...' on a new line at end of file.
                            if (!dryRun) {
                                const content = await plugin.app.vault.read(file);
                                const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
                                const line = tagsToAdd.map((t) => "#" + t).join(" ");
                                await plugin.app.vault.modify(file, content + sep + line + "\n");
                            }
                            inlineChanges = tagsToAdd.length;
                        }
                    }
                }

                // ────────────────── REMOVE ──────────────────
                else if (opName === "remove") {
                    // Inline pass
                    if (effLocation === "inline" || effLocation === "both") {
                        const cache = plugin.app.metadataCache.getFileCache(file);
                        const inlineCacheEntries = (cache?.tags ?? []).map((entry) => ({
                            tag: entry.tag,
                            from: entry.position.start.offset,
                            to: entry.position.end.offset,
                        }));
                        if (inlineCacheEntries.length > 0) {
                            const content = await plugin.app.vault.read(file);
                            const { newContent, count } = rewriteInlineTags(content, inlineCacheEntries, removeOp!);
                            inlineChanges = count;
                            if (count > 0 && !dryRun) {
                                await plugin.app.vault.modify(file, newContent);
                            }
                        }
                    }

                    // Frontmatter pass
                    if (effLocation === "frontmatter" || effLocation === "both") {
                        if (dryRun) {
                            const cache = plugin.app.metadataCache.getFileCache(file);
                            const fm = cache?.frontmatter;
                            if (fm) {
                                const fmClone: Record<string, unknown> = { ...fm };
                                for (const key of ["tags", "tag"]) {
                                    const v = (fm as Record<string, unknown>)[key];
                                    if (Array.isArray(v)) fmClone[key] = [...v];
                                }
                                frontmatterChanges = rewriteFrontmatterTags(fmClone, removeOp!);
                            }
                        } else {
                            try {
                                await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                                    frontmatterChanges = rewriteFrontmatterTags(fm, removeOp!);
                                });
                            } catch (err) {
                                skipped.push({
                                    path: file.path,
                                    reason: `processFrontMatter failed: ${(err as Error)?.message ?? String(err)}`,
                                });
                                continue;
                            }
                        }
                    }
                }

                // ────────────────── SET ──────────────────
                else if (opName === "set") {
                    // 'set' only ever touches frontmatter (we already rejected location='inline' above).
                    if (dryRun) {
                        const cache = plugin.app.metadataCache.getFileCache(file);
                        const fm = cache?.frontmatter as Record<string, unknown> | undefined;
                        const fmClone: Record<string, unknown> = fm ? { ...fm } : {};
                        if (fm) {
                            for (const key of ["tags", "tag"]) {
                                const v = (fm as Record<string, unknown>)[key];
                                if (Array.isArray(v)) fmClone[key] = [...v];
                            }
                        }
                        frontmatterChanges = setFrontmatterTags(fmClone, uniqueBareTags);
                    } else {
                        try {
                            await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                                frontmatterChanges = setFrontmatterTags(fm, uniqueBareTags);
                            });
                        } catch (err) {
                            skipped.push({
                                path: file.path,
                                reason: `processFrontMatter failed: ${(err as Error)?.message ?? String(err)}`,
                            });
                            continue;
                        }
                    }
                }

                if (inlineChanges > 0 || frontmatterChanges > 0 || noOpTags.length > 0) {
                    fileResults.push({
                        path: file.path,
                        inline_changes: inlineChanges,
                        frontmatter_changes: frontmatterChanges,
                        ...(noOpTags.length > 0 ? { no_op_tags: noOpTags } : {}),
                    });
                    totalInline += inlineChanges;
                    totalFrontmatter += frontmatterChanges;
                }
            }

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? `dry_run_edit_file_tags_${opName}` : `edit_file_tags_${opName}`,
                    op: opName,
                    location: rawLocation,
                    effective_location: effLocation,
                    tags: uniqueBareTags.map((t) => "#" + t),
                    include_descendants: opName === "remove" ? includeDescendants : undefined,
                    dry_run: dryRun,
                    files_processed: files.length,
                    files_changed: fileResults.length,
                    total_inline_changes: totalInline,
                    total_frontmatter_changes: totalFrontmatter,
                    files: fileResults,
                    ...(skipped.length > 0 ? { skipped } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter add / set helpers (used by vault_edit_file_tags only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Add the given bare tags to frontmatter, deduping against what's already there.
 * - If neither 'tags' nor 'tag' exists, creates 'tags' as an array.
 * - If 'tag' (singular) exists as a string, the new tags are added to it (string form preserved).
 * - If 'tags' is a string, new tags are appended with comma separators.
 * - If 'tags' is an array, new tags are pushed.
 * Returns the number of tags actually added (after dedupe).
 */
function addTagsToFrontmatter(fm: Record<string, unknown>, bareTagsToAdd: string[]): number {
    if (bareTagsToAdd.length === 0) return 0;

    // Discover existing tags across both possible keys, preserving the canonical key style.
    const existingBare = new Set<string>();
    for (const key of ["tags", "tag"]) {
        const v = fm[key];
        if (typeof v === "string") {
            for (const piece of v.split(/[,\s]+/)) {
                if (!piece) continue;
                existingBare.add(piece.startsWith("#") ? piece.substring(1) : piece);
            }
        } else if (Array.isArray(v)) {
            for (const item of v) {
                if (typeof item !== "string") continue;
                existingBare.add(item.startsWith("#") ? item.substring(1) : item);
            }
        }
    }

    const toAdd = bareTagsToAdd.filter((t) => !existingBare.has(t));
    if (toAdd.length === 0) return 0;

    // Pick the key to write to: prefer existing 'tags', then existing 'tag', otherwise create 'tags'.
    const targetKey = "tags" in fm ? "tags" : "tag" in fm ? "tag" : "tags";
    const cur = fm[targetKey];

    if (cur === undefined) {
        // Brand new — write as a YAML array (most idiomatic in Obsidian).
        fm[targetKey] = toAdd.slice();
    } else if (typeof cur === "string") {
        // Preserve string form. Append with comma+space, stripping any leading/trailing junk.
        const trimmed = cur.trim();
        const joined = (trimmed.length > 0 ? trimmed + ", " : "") + toAdd.join(", ");
        fm[targetKey] = joined;
    } else if (Array.isArray(cur)) {
        for (const t of toAdd) cur.push(t);
    } else {
        // Existing value is some other shape (object/null/number) — leave it alone and create 'tags' array instead.
        fm["tags"] = toAdd.slice();
    }

    return toAdd.length;
}

/**
 * Replace the file's frontmatter tags with exactly the given list (deduplicated).
 * - If the resulting list is empty, both 'tags' and 'tag' keys are deleted.
 * - Otherwise, 'tags' is written as an array, and any 'tag' (singular) key is deleted to
 *   avoid the two keys diverging.
 * Returns the count of tag entries in the resulting list (or the prior count if it was larger,
 * to roughly indicate the magnitude of change).
 */
function setFrontmatterTags(fm: Record<string, unknown>, bareTags: string[]): number {
    // Count prior entries to give a meaningful "changes" number.
    let prior = 0;
    for (const key of ["tags", "tag"]) {
        const v = fm[key];
        if (typeof v === "string") {
            for (const piece of v.split(/[,\s]+/)) if (piece) prior++;
        } else if (Array.isArray(v)) {
            for (const item of v) if (typeof item === "string") prior++;
        }
    }

    if (bareTags.length === 0) {
        delete fm["tags"];
        delete fm["tag"];
    } else {
        fm["tags"] = bareTags.slice();
        delete fm["tag"];
    }

    // Number of "changes" = max(prior, new) — gives a sensible non-zero indicator either way.
    return Math.max(prior, bareTags.length);
}
