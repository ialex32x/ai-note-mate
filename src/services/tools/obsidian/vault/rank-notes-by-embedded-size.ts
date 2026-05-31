import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";

/** Note paths that can be ranked (sources in resolvedLinks). */
const NOTE_SOURCE_EXTENSIONS = new Set(["md", "canvas"]);

/** Linked targets that are never counted as embedded attachments. */
const NON_ATTACHMENT_TARGET_EXTENSIONS = new Set(["md", "base", "canvas"]);

const RANK_DEFAULT_LIMIT = 20;
const RANK_MAX_LIMIT = 100;
const BREAKDOWN_DEFAULT_LIMIT = 5;
const BREAKDOWN_MAX_LIMIT = 20;

const RANK_CAVEAT =
    "Totals are based on Obsidian's resolved link index (`[[...]]`, `![[...]]`, `[text](path)`). " +
    "Each note's total is the sum of unique attachment target file sizes (each target counted once " +
    "per note, regardless of how many times it is embedded). Non-note targets only — all extensions " +
    "except .md, .base, and .canvas. `attachment_reference_count` is the total embed/link occurrences " +
    "and may exceed the number of distinct files. References in YAML frontmatter, code blocks, " +
    "Dataview queries, and other plugins are NOT included.";

export function extensionFromVaultPath(path: string): string {
    const dot = path.lastIndexOf(".");
    if (dot < 0) return "";
    return path.slice(dot + 1).toLowerCase();
}

export function isNoteSourcePath(path: string): boolean {
    return NOTE_SOURCE_EXTENSIONS.has(extensionFromVaultPath(path));
}

export function isEmbeddedAttachmentTarget(file: TFile): boolean {
    const ext = file.extension.toLowerCase();
    return !NON_ATTACHMENT_TARGET_EXTENSIONS.has(ext);
}

export interface RankNotesByEmbeddedSizeOpts {
    folderPrefix?: string;
    minTotalBytes?: number;
    limit: number;
    skip: number;
    includeBreakdown: boolean;
    breakdownLimit: number;
}

export interface EmbeddedAttachmentBreakdownItem {
    path: string;
    size: number;
    count: number;
    bytes: number;
}

export interface RankedNoteEmbeddedSize {
    path: string;
    attachment_total_bytes: number;
    attachment_reference_count: number;
    top_attachments?: EmbeddedAttachmentBreakdownItem[];
}

interface MutableNoteAgg {
    totalBytes: number;
    refCount: number;
    byTarget: Map<string, { size: number; count: number }>;
}

export interface AggregateEmbeddedAttachmentResult {
    notes: RankedNoteEmbeddedSize[];
    sources_scanned: number;
    notes_with_attachments: number;
    missing_targets: number;
    total_matches: number;
}

/**
 * Aggregate embedded attachment bytes per note from Obsidian's resolvedLinks index.
 */
export function aggregateEmbeddedAttachmentBytesByNote(
    resolvedLinks: Record<string, Record<string, number>>,
    getFile: (path: string) => TFile | null,
    opts: RankNotesByEmbeddedSizeOpts,
): AggregateEmbeddedAttachmentResult {
    const normalizedPrefix = opts.folderPrefix
        ? opts.folderPrefix.endsWith("/")
            ? opts.folderPrefix
            : opts.folderPrefix + "/"
        : undefined;

    const minTotal = opts.minTotalBytes ?? 0;
    const bySource = new Map<string, MutableNoteAgg>();
    let sourcesScanned = 0;
    let missingTargets = 0;

    for (const sourcePath of Object.keys(resolvedLinks)) {
        if (!isNoteSourcePath(sourcePath)) continue;
        if (normalizedPrefix && !sourcePath.startsWith(normalizedPrefix)) continue;

        sourcesScanned++;
        const targets = resolvedLinks[sourcePath];
        if (!targets) continue;

        for (const targetPath of Object.keys(targets)) {
            const count = targets[targetPath] ?? 0;
            if (count <= 0) continue;

            const file = getFile(targetPath);
            if (!file) {
                missingTargets++;
                continue;
            }
            if (!isEmbeddedAttachmentTarget(file)) continue;

            const size = file.stat.size;

            let agg = bySource.get(sourcePath);
            if (!agg) {
                agg = { totalBytes: 0, refCount: 0, byTarget: new Map() };
                bySource.set(sourcePath, agg);
            }
            // Each distinct target contributes its on-disk size once per source note.
            if (!agg.byTarget.has(targetPath)) {
                agg.totalBytes += size;
                agg.byTarget.set(targetPath, { size, count });
            } else {
                const prev = agg.byTarget.get(targetPath)!;
                prev.count += count;
            }
            agg.refCount += count;
        }
    }

    const ranked: RankedNoteEmbeddedSize[] = [];
    for (const [path, agg] of bySource) {
        if (agg.totalBytes < minTotal) continue;

        const entry: RankedNoteEmbeddedSize = {
            path,
            attachment_total_bytes: agg.totalBytes,
            attachment_reference_count: agg.refCount,
        };

        if (opts.includeBreakdown) {
            const items: EmbeddedAttachmentBreakdownItem[] = [];
            for (const [targetPath, t] of agg.byTarget) {
                items.push({
                    path: targetPath,
                    size: t.size,
                    count: t.count,
                    bytes: t.size,
                });
            }
            items.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path));
            entry.top_attachments = items.slice(0, opts.breakdownLimit);
        }

        ranked.push(entry);
    }

    ranked.sort(
        (a, b) =>
            b.attachment_total_bytes - a.attachment_total_bytes
            || a.path.localeCompare(b.path),
    );

    const totalMatches = ranked.length;
    const page = ranked.slice(opts.skip, opts.skip + opts.limit);

    return {
        notes: page,
        sources_scanned: sourcesScanned,
        notes_with_attachments: totalMatches,
        missing_targets: missingTargets,
        total_matches: totalMatches,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool: rank_notes_by_embedded_size
// ─────────────────────────────────────────────────────────────────────────────

export function vaultRankNotesByEmbeddedSize(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "rank_notes_by_embedded_size",
                description:
                    "Rank markdown/canvas notes by total on-disk size of distinct files they link or embed " +
                    "(`[[...]]`, `![[...]]`, `[text](path)`). Each note's score is the sum of unique " +
                    "attachment target sizes (each file counted once per note, not per embed). Targets: " +
                    "every non-note file except .md, .base, and .canvas. PRIMARY tool when the user or " +
                    "delegate task asks: which notes have the largest/heaviest embedded attachments, attachment " +
                    "footprint per note, notes ranked by linked file size, or which notes reference the biggest " +
                    "attachment files — call this FIRST instead of vault-wide `search_content` for `![[` or " +
                    "per-note `get_outgoing_links`. For listing every file inside an `assets/` or `attachments/` " +
                    "folder (including unlinked orphans), use `list_files_sorted` with `folder_prefix` separately. " +
                    "Do NOT use `list_files_sorted` for per-note embed totals — it ranks individual files only.",
                parameters: {
                    type: "object",
                    properties: {
                        limit: {
                            type: "number",
                            description: `Maximum notes to return. Defaults to ${RANK_DEFAULT_LIMIT}, max ${RANK_MAX_LIMIT}.`,
                        },
                        skip: {
                            type: "number",
                            description: "Number of ranked notes to skip for pagination. Defaults to 0.",
                        },
                        folder_prefix: {
                            type: "string",
                            description:
                                "Optional vault-relative folder prefix; only source notes under this path are ranked " +
                                "(e.g. 'Daily/').",
                        },
                        min_total_bytes: {
                            type: "number",
                            description:
                                "Only return notes whose embedded attachment total is at least this many bytes. " +
                                "Omit to include any note with at least one counted attachment.",
                        },
                        include_breakdown: {
                            type: "boolean",
                            description:
                                "If true, include `top_attachments` per note (largest contributing targets). " +
                                `Defaults to false.`,
                        },
                        breakdown_limit: {
                            type: "number",
                            description:
                                `When include_breakdown is true, how many targets to list per note. ` +
                                `Defaults to ${BREAKDOWN_DEFAULT_LIMIT}, max ${BREAKDOWN_MAX_LIMIT}.`,
                        },
                    },
                    required: [],
                },
            },
        },
        capabilities: ["read_file"] as ToolCapability[],
        exec: async (_chatStream, args, _signal) => {
            const skip = Math.max(0, (args["skip"] as number) ?? 0);
            const rawLimit = (args["limit"] as number) ?? RANK_DEFAULT_LIMIT;
            const limit = Math.max(1, Math.min(RANK_MAX_LIMIT, rawLimit));

            const includeBreakdown = (args["include_breakdown"] as boolean) ?? false;
            const rawBreakdownLimit = (args["breakdown_limit"] as number) ?? BREAKDOWN_DEFAULT_LIMIT;
            const breakdownLimit = Math.max(
                1,
                Math.min(BREAKDOWN_MAX_LIMIT, rawBreakdownLimit),
            );

            const folderPrefix = args["folder_prefix"] as string | undefined;
            const minTotalBytes = args["min_total_bytes"] as number | undefined;
            if (minTotalBytes !== undefined && (!Number.isFinite(minTotalBytes) || minTotalBytes < 0)) {
                return {
                    success: false,
                    type: "text",
                    content: "min_total_bytes must be a non-negative number.",
                };
            }

            const resolved = plugin.app.metadataCache.resolvedLinks;
            const result = aggregateEmbeddedAttachmentBytesByNote(
                resolved,
                (path) => {
                    const f = plugin.app.vault.getAbstractFileByPath(path);
                    return f instanceof TFile ? f : null;
                },
                {
                    folderPrefix,
                    minTotalBytes,
                    limit,
                    skip,
                    includeBreakdown,
                    breakdownLimit,
                },
            );

            const hasMore = skip + result.notes.length < result.total_matches;

            return {
                success: true,
                type: "object",
                content: {
                    folder_prefix: folderPrefix ?? null,
                    min_total_bytes: minTotalBytes ?? null,
                    sort_by: "attachment_total_bytes",
                    sort_order: "desc",
                    sources_scanned: result.sources_scanned,
                    notes_with_attachments: result.notes_with_attachments,
                    missing_targets: result.missing_targets,
                    total_matches: result.total_matches,
                    skip,
                    count: result.notes.length,
                    has_more: hasMore,
                    note: RANK_CAVEAT,
                    notes: result.notes,
                },
            };
        },
    };
}
