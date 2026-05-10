import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import {
    collectTagsForFile,
    normaliseTagName,
    rewriteFrontmatterTags,
    rewriteInlineTags,
    type TagOp,
} from "./_tag-ops";

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
                                const v = fm[key];
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
