import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { runVaultMutation } from "../../../vault/mutator";
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
 * Rename or remove a tag (and optionally its descendants) across every markdown note in the vault.
 *
 * When `new_tag` is provided, the tag is renamed. When `new_tag` is omitted or empty, the tag
 * is removed vault-wide (both inline `#tag` occurrences and YAML frontmatter entries).
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
                    "Vault-wide tag rename or removal. Rewrites both inline `#tag` occurrences and YAML " +
                    "frontmatter tag entries (under `tags` / `tag`) atomically per file. Inline " +
                    "replacements use the metadata cache's precise offsets, so they cannot touch " +
                    "neighbouring tokens like `#X-foo` when renaming `#X`. With `include_descendants`, " +
                    "`#X/alpha` is also affected (renamed to `#Y/alpha` or removed). " +
                    "Always run once with `dry_run=true` first to preview impact.",
                parameters: {
                    type: "object",
                    properties: {
                        old_tag: {
                            type: "string",
                            description:
                                "The existing tag to rename or remove, with or without the leading '#'. " +
                                "Example: 'project' or '#project'.",
                        },
                        new_tag: {
                            type: "string",
                            description:
                                "The new tag name, with or without the leading '#'. " +
                                "Omit or pass an empty string to remove the tag vault-wide instead of renaming it. " +
                                "When renaming, must be a valid tag identifier (no whitespace, quotes, or YAML special characters). " +
                                "Example: 'work/project' or '#work/project'.",
                        },
                        include_descendants: {
                            type: "boolean",
                            description:
                                "If true, also affect every nested sub-tag, preserving the sub-path " +
                                "for renames (e.g. old_tag='project', new_tag='work' will rewrite '#project/alpha' to '#work/alpha') " +
                                "or removing descendants when deleting. " +
                                "Defaults to false (affect the exact tag only).",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, return the per-file impact report without modifying any files. " +
                                "Defaults to false. Strongly recommended to run once with dry_run=true first.",
                        },
                    },
                    required: ["old_tag"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            const oldBare = normaliseTagName(args["old_tag"] as string);
            const includeDescendants = (args["include_descendants"] as boolean) ?? false;
            const dryRun = (args["dry_run"] as boolean) ?? false;

            if (oldBare === null) {
                return { success: false, type: "text", content: "old_tag must be a non-empty, valid tag name." };
            }

            // new_tag omitted or empty → vault-wide remove mode
            const newRaw = (args["new_tag"] as string | undefined)?.trim();
            const isRemove = !newRaw;

            let newBare: string | null = null;
            if (!isRemove) {
                newBare = normaliseTagName(newRaw);
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
            }

            const op: TagOp = isRemove
                ? { kind: "remove", targetBares: [oldBare], includeDescendants }
                : { kind: "rename", oldBare, newBare: newBare!, includeDescendants };

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

                // ─── Pre-compute inline changes ───────────────────────────────
                let inlineCount = 0;
                let inlineNewContent: string | undefined;
                if (inlineCacheEntries.length > 0) {
                    const content = await plugin.app.vault.read(file);
                    const result = rewriteInlineTags(content, inlineCacheEntries, op);
                    inlineCount = result.count;
                    if (result.count > 0) inlineNewContent = result.newContent;
                }

                // ─── Pre-compute frontmatter changes (clone — safe for both dry-run and write) ──
                let frontmatterCount = 0;
                let needsFrontmatter = false;
                {
                    const fm = cache?.frontmatter;
                    if (fm) {
                        const fmClone: Record<string, unknown> = { ...fm };
                        for (const key of ["tags", "tag"]) {
                            const v = (fm as Record<string, unknown>)[key];
                            if (Array.isArray(v)) fmClone[key] = [...(v as unknown[])];
                        }
                        frontmatterCount = rewriteFrontmatterTags(fmClone, op);
                        needsFrontmatter = frontmatterCount > 0;
                    }
                }

                const hasChanges = inlineCount > 0 || needsFrontmatter;

                // ─── Execute via checkpoint gateway ───────────────────────────
                if (hasChanges && !dryRun) {
                    try {
                        const lockErr = await runVaultMutation(plugin, chatStream, {
                            kind: "modify",
                            path: file.path,
                            toolName: "rename_tag",
                            perform: async () => {
                                if (inlineNewContent !== undefined) {
                                    await plugin.app.vault.modify(file, inlineNewContent);
                                }
                                if (needsFrontmatter) {
                                    await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                                        rewriteFrontmatterTags(fm, op);
                                    });
                                }
                            },
                        });
                        if (lockErr) {
                            skipped.push({ path: file.path, reason: lockErr.content as string });
                            inlineCount = 0;
                            frontmatterCount = 0;
                        }
                    } catch (err) {
                        skipped.push({
                            path: file.path,
                            reason: `Mutation failed: ${(err as Error)?.message ?? String(err)}`,
                        });
                        inlineCount = 0;
                        frontmatterCount = 0;
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

            const baseResult = {
                action: dryRun
                    ? (isRemove ? "dry_run_remove_tag" : "dry_run_rename_tag")
                    : (isRemove ? "tag_removed" : "tag_renamed"),
                old_tag: oldHash,
                include_descendants: includeDescendants,
                dry_run: dryRun,
                files_changed: fileResults.length,
                total_inline_replacements: totalInline,
                total_frontmatter_replacements: totalFrontmatter,
                files: fileResults,
                ...(skipped.length > 0 ? { skipped } : {}),
            };

            return {
                success: true,
                type: "object",
                content: isRemove
                    ? baseResult
                    : { ...baseResult, new_tag: "#" + newBare },
            };
        },
        requiresConfirmation: true,
    };
}
