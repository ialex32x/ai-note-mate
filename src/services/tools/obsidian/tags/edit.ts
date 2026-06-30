import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { ChatStream, RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { runVaultMutation } from "../../../vault/mutator";
import { isFailure, requireFile } from "../_shared";
import {
    collectTagsForFile,
    normaliseTagName,
    rewriteFrontmatterTags,
    rewriteInlineTags,
    type TagOp,
} from "./_tag-ops";

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared execution engine — the three tool wrappers below each pre-process
// their args and delegate to this single code path. The `op` parameter
// (add/remove/set) was the single biggest cause of LLM call failures — the
// model would routinely forget to pass it. Splitting into three
// single-purpose tools eliminates the parameter entirely.
// ─────────────────────────────────────────────────────────────────────────────

type EffLocation = "frontmatter" | "inline" | "both";

interface SharedExecParams {
    /** Tool name for the response `action` field, e.g. "batch_add_note_tags". */
    actionName: string;
    /** The underlying operation. */
    opName: "add" | "remove" | "set";
    /** Chat stream for checkpoint integration. */
    chatStream: ChatStream | undefined;
    /** Already-validated array of vault-relative paths. */
    paths: string[];
    /** Tag names (with or without '#') — validated inside executeTagsEdit. */
    rawTags: unknown;
    /** Already-resolved concrete location (never "auto"). */
    location: EffLocation;
    /** Only meaningful for remove. */
    includeDescendants: boolean;
    dryRun: boolean;
}

async function executeTagsEdit(
    plugin: NoteAssistantPlugin,
    params: SharedExecParams,
): Promise<ToolCallResult> {
    const { actionName, opName, paths, rawTags, location, includeDescendants, dryRun } = params;

    // ─── Validate tags ────────────────────────────────────────────
    if (!Array.isArray(rawTags)) {
        return { success: false, type: "text", content: "tags must be an array of tag names." };
    }
    if ((opName === "add" || opName === "remove") && rawTags.length === 0) {
        return {
            success: false,
            type: "text",
            content: `tags must be non-empty for '${opName}'. For add, provide the tags to add; for remove, provide the tags to remove.`,
        };
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
    const uniqueBareTags = Array.from(new Set(bareTags));

    // ─── Resolve all files up front ───────────────────────────────
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
                if (location === "frontmatter" || location === "both") {
                    // Pre-compute count on clone (same for dry-run and write)
                    {
                        const cache = plugin.app.metadataCache.getFileCache(file);
                        const fm = cache?.frontmatter;
                        const fmClone: Record<string, unknown> = fm ? { ...fm } : {};
                        if (fm) {
                            for (const key of ["tags", "tag"]) {
                                const v = (fm as Record<string, unknown>)[key];
                                if (Array.isArray(v)) fmClone[key] = [...(v as unknown[])];
                            }
                        }
                        frontmatterChanges = addTagsToFrontmatter(fmClone, tagsToAdd);
                    }

                    if (!dryRun && frontmatterChanges > 0) {
                        try {
                            const lockErr = await runVaultMutation(plugin, params.chatStream, {
                                kind: "modify",
                                path: file.path,
                                toolName: actionName,
                                perform: async () => {
                                    await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                                        addTagsToFrontmatter(fm, tagsToAdd);
                                    });
                                },
                            });
                            if (lockErr) {
                                skipped.push({ path: file.path, reason: lockErr.content as string });
                                frontmatterChanges = 0;
                            }
                        } catch (err) {
                            skipped.push({
                                path: file.path,
                                reason: `processFrontMatter failed: ${(err as Error)?.message ?? String(err)}`,
                            });
                            frontmatterChanges = 0;
                        }
                    }
                }
                if (location === "inline") {
                    inlineChanges = tagsToAdd.length;

                    if (!dryRun) {
                        const content = await plugin.app.vault.read(file);
                        const sep = content.length === 0 || content.endsWith("\n") ? "" : "\n";
                        const line = tagsToAdd.map((t) => "#" + t).join(" ");
                        try {
                            const lockErr = await runVaultMutation(plugin, params.chatStream, {
                                kind: "modify",
                                path: file.path,
                                toolName: actionName,
                                perform: async () => {
                                    await plugin.app.vault.modify(file, content + sep + line + "\n");
                                },
                            });
                            if (lockErr) {
                                skipped.push({ path: file.path, reason: lockErr.content as string });
                                inlineChanges = 0;
                            }
                        } catch (err) {
                            skipped.push({
                                path: file.path,
                                reason: `vault.modify failed: ${(err as Error)?.message ?? String(err)}`,
                            });
                            inlineChanges = 0;
                        }
                    }
                }
            }
        }

        // ────────────────── REMOVE ──────────────────
        else if (opName === "remove") {
            let inlineNewContent: string | undefined;

            // Pre-compute inline
            if (location === "inline" || location === "both") {
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
                    if (count > 0) inlineNewContent = newContent;
                }
            }

            // Pre-compute frontmatter on clone (same for dry-run and write)
            let needsRemoveFm = false;
            if (location === "frontmatter" || location === "both") {
                const cache = plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;
                if (fm) {
                    const fmClone: Record<string, unknown> = { ...fm };
                    for (const key of ["tags", "tag"]) {
                        const v: unknown = fm[key];
                        if (Array.isArray(v)) fmClone[key] = [...(v as unknown[])];
                    }
                    frontmatterChanges = rewriteFrontmatterTags(fmClone, removeOp!);
                    needsRemoveFm = frontmatterChanges > 0;
                }
            }

            // Execute via checkpoint gateway (inline + frontmatter in one call)
            if (!dryRun && (inlineNewContent !== undefined || needsRemoveFm)) {
                try {
                    const lockErr = await runVaultMutation(plugin, params.chatStream, {
                        kind: "modify",
                        path: file.path,
                        toolName: actionName,
                        perform: async () => {
                            if (inlineNewContent !== undefined) {
                                await plugin.app.vault.modify(file, inlineNewContent);
                            }
                            if (needsRemoveFm) {
                                await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                                    rewriteFrontmatterTags(fm, removeOp!);
                                });
                            }
                        },
                    });
                    if (lockErr) {
                        skipped.push({ path: file.path, reason: lockErr.content as string });
                        inlineChanges = 0;
                        frontmatterChanges = 0;
                    }
                } catch (err) {
                    skipped.push({
                        path: file.path,
                        reason: `Mutation failed: ${(err as Error)?.message ?? String(err)}`,
                    });
                    inlineChanges = 0;
                    frontmatterChanges = 0;
                }
            }
        }

        // ────────────────── SET ──────────────────
        else if (opName === "set") {
            // Pre-compute count on clone (same for dry-run and write)
            {
                const cache = plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;
                const fmClone: Record<string, unknown> = fm ? { ...fm } : {};
                if (fm) {
                    for (const key of ["tags", "tag"]) {
                        const v: unknown = fm[key];
                        if (Array.isArray(v)) fmClone[key] = [...(v as unknown[])];
                    }
                }
                frontmatterChanges = setFrontmatterTags(fmClone, uniqueBareTags);
            }

            if (!dryRun && frontmatterChanges > 0) {
                try {
                    const lockErr = await runVaultMutation(plugin, params.chatStream, {
                        kind: "modify",
                        path: file.path,
                        toolName: actionName,
                        perform: async () => {
                            await plugin.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
                                setFrontmatterTags(fm, uniqueBareTags);
                            });
                        },
                    });
                    if (lockErr) {
                        skipped.push({ path: file.path, reason: lockErr.content as string });
                        frontmatterChanges = 0;
                    }
                } catch (err) {
                    skipped.push({
                        path: file.path,
                        reason: `processFrontMatter failed: ${(err as Error)?.message ?? String(err)}`,
                    });
                    frontmatterChanges = 0;
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

    const resultContent: Record<string, unknown> = {
        action: dryRun ? `dry_run_${actionName}` : actionName,
        op: opName,
        location,
        tags: uniqueBareTags.map((t) => "#" + t),
        dry_run: dryRun,
        files_processed: files.length,
        files_changed: fileResults.length,
        total_inline_changes: totalInline,
        total_frontmatter_changes: totalFrontmatter,
        files: fileResults,
    };
    if (opName === "remove") {
        resultContent["include_descendants"] = includeDescendants;
    }
    if (skipped.length > 0) {
        resultContent["skipped"] = skipped;
    }

    return {
        success: true,
        type: "object",
        content: resultContent,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: batch_add_note_tags
//
// Add tags to one or more specific notes. Writes to frontmatter by default;
// can optionally write inline `#tag` occurrences instead via `location`.
// Idempotent: adding a tag that already exists is a no-op for that file.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultBatchAddNoteTags(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "batch_add_note_tags",
                description:
                    "Add tags to one or more specific notes. Tags are written to YAML frontmatter by default " +
                    "(preserving existing structure); use `location='inline'` to append inline `#tag` occurrences " +
                    "instead. Idempotent — adding a tag that already exists is a no-op. " +
                    "Frontmatter is updated via `processFrontMatter` (preserves YAML structure, quoting, key order); " +
                    "inline edits use the metadata cache's exact offsets so nothing gets corrupted.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Vault-relative paths of the markdown files to add tags to (1 or more). " +
                                "All paths must point to existing markdown files.",
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Tag names to add, with or without the leading '#'. " +
                                "Must be non-empty. Example: ['todo', '#project/alpha'].",
                        },
                        location: {
                            type: "string",
                            enum: ["frontmatter", "inline"],
                            description:
                                "Where to add the tags. " +
                                "`frontmatter` (default) = add to YAML frontmatter tags. " +
                                "`inline` = append `#tag` occurrences on a new line at the end of the file. " +
                                "Defaults to `frontmatter`.",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, return the per-file impact report without modifying any files. " +
                                "Defaults to false.",
                        },
                    },
                    required: ["paths", "tags"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            // Accept singular aliases (common LLM slip).
            let rawPaths = args["paths"];
            if (!rawPaths && typeof args["path"] === "string") {
                rawPaths = [args["path"]];
            }
            let rawTags = args["tags"];
            if (!rawTags && typeof args["tag"] === "string") {
                rawTags = [args["tag"]];
            }
            const rawLocation = (args["location"] as string | undefined) ?? "frontmatter";

            // Validate paths
            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return { success: false, type: "text", content: "paths must be a non-empty array of vault-relative file paths." };
            }
            if (rawPaths.some((p) => typeof p !== "string" || p.length === 0)) {
                return { success: false, type: "text", content: "Each entry in paths must be a non-empty string." };
            }
            const paths = rawPaths as string[];

            // Validate location
            if (rawLocation !== "frontmatter" && rawLocation !== "inline") {
                return { success: false, type: "text", content: `Invalid location '${rawLocation}'; must be 'frontmatter' or 'inline'.` };
            }

            return executeTagsEdit(plugin, {
                actionName: "batch_add_note_tags",
                opName: "add",
                chatStream,
                paths,
                rawTags,
                location: rawLocation,
                includeDescendants: false,
                dryRun: (args["dry_run"] as boolean) ?? false,
            });
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: batch_remove_note_tags
//
// Remove tags from one or more specific notes. Removes from BOTH frontmatter
// and inline `#tag` occurrences by default; can be scoped via `location`.
// Idempotent: removing a tag that doesn't exist is a no-op.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultBatchRemoveNoteTags(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "batch_remove_note_tags",
                description:
                    "Remove tags from one or more specific notes. Removes from BOTH YAML frontmatter and inline " +
                    "`#tag` occurrences by default; use `location` to scope to frontmatter-only or inline-only. " +
                    "Idempotent — removing a tag that doesn't exist is a no-op. " +
                    "Frontmatter is updated via `processFrontMatter` (preserves YAML structure, quoting, key order); " +
                    "inline `#tag` occurrences are located via the metadata cache's exact offsets — neither YAML " +
                    "nor in-body prose can get corrupted.",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Vault-relative paths of the markdown files to remove tags from (1 or more). " +
                                "All paths must point to existing markdown files.",
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Tag names to remove, with or without the leading '#'. " +
                                "Must be non-empty. Example: ['todo', '#project/alpha'].",
                        },
                        location: {
                            type: "string",
                            enum: ["frontmatter", "inline", "both"],
                            description:
                                "Where to remove the tags from. " +
                                "`both` (default) = remove from YAML frontmatter AND inline `#tag` occurrences. " +
                                "`frontmatter` = only remove from YAML frontmatter tags. " +
                                "`inline` = only remove inline `#tag` occurrences in the body. " +
                                "Defaults to `both`.",
                        },
                        include_descendants: {
                            type: "boolean",
                            description:
                                "If true, also remove every nested sub-tag " +
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
                    required: ["paths", "tags"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            // Accept singular aliases (common LLM slip).
            let rawPaths = args["paths"];
            if (!rawPaths && typeof args["path"] === "string") {
                rawPaths = [args["path"]];
            }
            let rawTags = args["tags"];
            if (!rawTags && typeof args["tag"] === "string") {
                rawTags = [args["tag"]];
            }
            const rawLocation = (args["location"] as string | undefined) ?? "both";
            const includeDescendants = (args["include_descendants"] as boolean) ?? false;

            // Validate paths
            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return { success: false, type: "text", content: "paths must be a non-empty array of vault-relative file paths." };
            }
            if (rawPaths.some((p) => typeof p !== "string" || p.length === 0)) {
                return { success: false, type: "text", content: "Each entry in paths must be a non-empty string." };
            }
            const paths = rawPaths as string[];

            // Validate location
            if (rawLocation !== "frontmatter" && rawLocation !== "inline" && rawLocation !== "both") {
                return { success: false, type: "text", content: `Invalid location '${rawLocation}'; must be 'frontmatter', 'inline', or 'both'.` };
            }

            return executeTagsEdit(plugin, {
                actionName: "batch_remove_note_tags",
                opName: "remove",
                chatStream,
                paths,
                rawTags,
                location: rawLocation,
                includeDescendants,
                dryRun: (args["dry_run"] as boolean) ?? false,
            });
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: batch_set_note_tags
//
// Replace the frontmatter tags on one or more notes with exactly the given
// list. Deliberately does NOT touch inline `#tag` occurrences — use
// `batch_remove_note_tags` explicitly for those. Pass an empty `tags` array to
// clear all frontmatter tags.
// ─────────────────────────────────────────────────────────────────────────────

export function vaultBatchSetNoteTags(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "batch_set_note_tags",
                description:
                    "Replace the YAML frontmatter tags on one or more notes with exactly the given list " +
                    "(deduplicated). This operates ONLY on frontmatter — inline `#tag` occurrences in the body " +
                    "are deliberately NOT touched. To also remove inline tags, use `batch_remove_note_tags` first. " +
                    "Pass an empty `tags` array to clear all frontmatter tags from the selected notes. " +
                    "Frontmatter is updated via `processFrontMatter` (preserves YAML structure, quoting, key order).",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Vault-relative paths of the markdown files to set tags on (1 or more). " +
                                "All paths must point to existing markdown files.",
                        },
                        tags: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "The exact list of tag names to set, with or without the leading '#'. " +
                                "May be empty to clear all frontmatter tags. " +
                                "Example: ['todo', '#project/alpha', 'reviewed'].",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, return the per-file impact report without modifying any files. " +
                                "Defaults to false.",
                        },
                    },
                    required: ["paths", "tags"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            // Accept singular aliases (common LLM slip).
            let rawPaths = args["paths"];
            if (!rawPaths && typeof args["path"] === "string") {
                rawPaths = [args["path"]];
            }
            let rawTags = args["tags"];
            if (!rawTags && typeof args["tag"] === "string") {
                rawTags = [args["tag"]];
            }

            // Validate paths
            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return { success: false, type: "text", content: "paths must be a non-empty array of vault-relative file paths." };
            }
            if (rawPaths.some((p) => typeof p !== "string" || p.length === 0)) {
                return { success: false, type: "text", content: "Each entry in paths must be a non-empty string." };
            }
            const paths = rawPaths as string[];

            return executeTagsEdit(plugin, {
                actionName: "batch_set_note_tags",
                opName: "set",
                chatStream,
                paths,
                rawTags,
                location: "frontmatter", // set always operates on frontmatter only
                includeDescendants: false,
                dryRun: (args["dry_run"] as boolean) ?? false,
            });
        },
        requiresConfirmation: true,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter add / set helpers
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

    const targetKey = "tags" in fm ? "tags" : "tag" in fm ? "tag" : "tags";
    const cur = fm[targetKey];

    if (cur === undefined) {
        fm[targetKey] = toAdd.slice();
    } else if (typeof cur === "string") {
        const trimmed = cur.trim();
        const joined = (trimmed.length > 0 ? trimmed + ", " : "") + toAdd.join(", ");
        fm[targetKey] = joined;
    } else if (Array.isArray(cur)) {
        for (const t of toAdd) cur.push(t);
    } else {
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

    return Math.max(prior, bareTags.length);
}
