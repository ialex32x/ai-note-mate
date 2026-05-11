import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import {
    collectTagsForFile,
    normaliseTagName,
    rewriteFrontmatterTags,
    rewriteInlineTags,
    type TagOp,
} from "./_tag-ops";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: rename_tag
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
                name: "rename_tag",
                description:
                    "Rename a tag (and optionally all of its nested sub-tags) across every markdown note in the vault. " +
                    "Rewrites both inline '#tag' occurrences AND YAML frontmatter tag entries (under 'tags' or 'tag') in a single atomic operation per file. " +
                    "Inline replacements use the metadata cache's precise offsets, so they will NOT accidentally touch words like 'XYZ' or '#X-foo' when renaming '#X'. " +
                    "When include_descendants is true, '#X/alpha' is also renamed to '#Y/alpha', preserving the sub-path. " +
                    "Always run with dry_run=true first to preview the impact (file count, occurrence count) before applying. " +
                    "Use this whenever the user wants to rename, refactor, merge, or move a tag across the whole vault — much safer and cheaper than looping replace_text over many files. " +
                    "If the user only wants to add/remove/set tags on specific notes (rather than rename everywhere), use edit_file_tags instead.",
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
                            if (Array.isArray(v)) fmClone[key] = [...(v as unknown[])];
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
