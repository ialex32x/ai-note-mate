import { TFile, getAllTags } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers — used by every tool in this folder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all tags for a markdown file by consulting the metadata cache.
 * Tags come from two sources: inline `#tag` occurrences and the YAML frontmatter `tags` field.
 * The returned tags always start with `#` and are deduplicated.
 */
export function collectTagsForFile(plugin: NoteAssistantPlugin, file: TFile): string[] {
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
export function normaliseTagName(raw: string): string | null {
    if (typeof raw !== "string") return null;
    let t = raw.trim();
    if (t.length === 0) return null;
    if (t.startsWith("#")) t = t.substring(1);
    if (t.length === 0) return null;
    // Reject obvious whitespace / quote / yaml special chars
    if (/[\s"'`,[\]{}]/.test(t)) return null;
    // Strip any leading or trailing slashes (nesting separator should not be at the edges)
    if (t.startsWith("/") || t.endsWith("/")) return null;
    return t;
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
export type TagOp =
    | { kind: "rename"; oldBare: string; newBare: string; includeDescendants: boolean }
    | { kind: "remove"; targetBares: string[]; includeDescendants: boolean };

export function applyTagOp(bareTag: string, op: TagOp): string | null {
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
export function applyOpToFrontmatterValue(value: string, op: TagOp): string | null {
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
export function rewriteFrontmatterTags(fm: Record<string, unknown>, op: TagOp): number {
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
                const item: unknown = cur[i];
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
export function rewriteInlineTags(
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
