import { TFile } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ToolCallResult } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { isFailure, requireFile } from "../_shared";
import { runVaultMutation } from "../../../vault";

// ─────────────────────────────────────────────────────────────────────────────
// Tool: edit_files_frontmatter
//
// Generic YAML frontmatter property editor for one or more notes. Operates
// through `app.fileManager.processFrontMatter`, so YAML structure, quoting,
// and key order survive intact — unlike a text-level edit through
// `replace_text` / `edit_lines` which can corrupt nested values, multi-line
// strings, or quoted scalars.
//
// SCOPE BOUNDARY: deliberately refuses edits to `tags` / `tag` keys.
// Tag operations belong on `add_files_tags` / `remove_files_tags` /
// `set_files_tags` (targeted files — accepts one or more paths, with
// inline-tag awareness) and `rename_tag` (vault-wide). Routing tag edits
// through this generic tool would either:
//   - drop the inline `#tag` body channel (silent capability gap), or
//   - bolt on tag-specific semantics (add/remove/descendants) that pollute
//     a generic property tool's contract.
// Better to fail loudly and point the model at the right tool.
//
// SEMANTICS:
//   - op="set":   replace each listed key with the supplied value. Other
//                 keys remain untouched. To clear a single key, use
//                 `op="unset"`. Values may be string / number / boolean /
//                 array / object / null.
//   - op="unset": remove each listed key from frontmatter. No-op for keys
//                 that were already absent.
//
// There is no `merge` op by design: deep merge is ambiguous on arrays
// (append? union? replace?) and easy to get wrong silently. If a caller
// needs to add an item to an array (e.g. aliases), they should read the
// current value first and `op="set"` with the merged array — explicit
// rather than guessed.
// ─────────────────────────────────────────────────────────────────────────────

const REFUSED_TAG_KEYS = new Set(["tags", "tag"]);

/**
 * Per-file change record produced by the edit pass.
 */
interface EditFrontmatterFileResult {
    path: string;
    /** Keys whose values were assigned/replaced. */
    set_keys?: string[];
    /** Keys that were removed. */
    unset_keys?: string[];
    /** Keys that were no-ops (set with identical value, or unset of an absent key). */
    no_op_keys?: string[];
}

/**
 * Recursively check that a value is JSON-serialisable. Functions / undefined /
 * symbols / circular refs would either crash YAML serialisation or produce
 * garbage on disk, so we refuse them up front instead of letting
 * `processFrontMatter` swallow them silently.
 */
function isPlainJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
    if (value === null) return true;
    const t = typeof value;
    if (t === "string" || t === "number" || t === "boolean") {
        // Reject NaN / +/-Infinity — JSON cannot encode them and YAML
        // libraries differ on behaviour.
        if (t === "number" && !Number.isFinite(value as number)) return false;
        return true;
    }
    if (t !== "object") return false;
    if (seen.has(value as object)) return false;
    seen.add(value as object);
    if (Array.isArray(value)) {
        for (const item of value) {
            if (!isPlainJsonValue(item, seen)) return false;
        }
        return true;
    }
    // Plain object: every value must be JSON-safe. Keys are always strings in JSON.
    for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!isPlainJsonValue((value as Record<string, unknown>)[key], seen)) return false;
    }
    return true;
}

/**
 * Stable structural equality used to detect set-no-ops (writing the same
 * value as already exists). Object key order is ignored — we sort keys
 * before recursing so `{a: 1, b: 2}` equals `{b: 2, a: 1}`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) return false;
        }
        return true;
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao).sort();
    const bk = Object.keys(bo).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
        if (ak[i] !== bk[i]) return false;
        if (!deepEqual(ao[ak[i]!], bo[bk[i]!])) return false;
    }
    return true;
}

export function vaultEditFilesFrontmatter(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "edit_files_frontmatter",
                description:
                    "Set or remove YAML frontmatter properties on one or more markdown notes via the " +
                    "official `processFrontMatter` API (preserves YAML formatting and key order). " +
                    "\n\n" +
                    "Ops: `set` assigns each key in `properties` to the given value (string / number / " +
                    "boolean / array / object / null); other keys remain untouched. `unset` removes each " +
                    "key in `keys` from frontmatter. Both are idempotent (setting the same value, or " +
                    "unsetting an absent key, is a no-op). There is no `merge` op by design — to add to " +
                    "an existing array (e.g. aliases), read the current value first and `set` the merged " +
                    "array. " +
                    "\n\n" +
                    "Editing the `tags` / `tag` keys is REFUSED — use `add_files_tags` / `remove_files_tags` / " +
                    "`set_files_tags` (accepts one or more paths) or `rename_tag` (vault-wide) instead. " +
                    "\n\n" +
                    "Use this for any non-tag frontmatter change (e.g. 'set status to done', 'clear " +
                    "due_date on these notes', 'add author=John', 'set aliases to [...]').",
                parameters: {
                    type: "object",
                    properties: {
                        paths: {
                            type: "array",
                            items: { type: "string" },
                            minItems: 1,
                            description:
                                "Vault-relative paths of the markdown files to edit (1 or more). " +
                                "All paths must point to existing markdown files.",
                        },
                        op: {
                            type: "string",
                            enum: ["set", "unset"],
                            description:
                                "'set' = assign each key in `properties` to the given value. " +
                                "'unset' = remove each key listed in `keys` from frontmatter.",
                        },
                        properties: {
                            type: "object",
                            description:
                                "[op=set only] Object mapping frontmatter key → new value. " +
                                "Values may be string, number, boolean, array, object, or null. " +
                                "Keys `tags` / `tag` are refused — use add_files_tags / remove_files_tags / set_files_tags / rename_tag.",
                            additionalProperties: true,
                        },
                        keys: {
                            type: "array",
                            items: { type: "string" },
                            description:
                                "[op=unset only] Frontmatter keys to remove. " +
                                "Keys `tags` / `tag` are refused — use add_files_tags / remove_files_tags / set_files_tags.",
                        },
                        dry_run: {
                            type: "boolean",
                            description:
                                "If true, return the per-file impact report without modifying any files. " +
                                "Defaults to false.",
                        },
                    },
                    required: ["paths", "op"],
                },
            },
        },
        capabilities: ["write_file"] as ToolCapability[],
        exec: async (chatStream, args, _signal): Promise<ToolCallResult> => {
            // Accept both `paths` (array, canonical) and `path` (single string, common LLM slip).
            let rawPaths = args["paths"];
            if (!rawPaths && typeof args["path"] === "string") {
                rawPaths = [args["path"]];
            }
            const opName = args["op"] as string;
            const dryRun = (args["dry_run"] as boolean) ?? false;

            // ─── Validate paths ───────────────────────────────────────────
            if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content: "paths must be a non-empty array of vault-relative file paths.",
                };
            }
            if (rawPaths.some((p) => typeof p !== "string" || p.length === 0)) {
                return {
                    success: false,
                    type: "text",
                    content: "Each entry in paths must be a non-empty string.",
                };
            }
            const paths = rawPaths as string[];

            // ─── Validate op ──────────────────────────────────────────────
            if (opName !== "set" && opName !== "unset") {
                return {
                    success: false,
                    type: "text",
                    content: `Invalid op '${opName}'; must be one of 'set', 'unset'.`,
                };
            }

            // ─── Validate per-op payload ──────────────────────────────────
            // Set mode: `properties` is the operand. Refuse tag keys (and any
            // non-JSON value) up front so we never half-apply the batch.
            const setEntries: Array<[string, unknown]> = [];
            // Unset mode: `keys` is the operand.
            const unsetKeys: string[] = [];

            if (opName === "set") {
                const props = args["properties"];
                if (!props || typeof props !== "object" || Array.isArray(props)) {
                    return {
                        success: false,
                        type: "text",
                        content: "op='set' requires `properties` to be a non-null object mapping key → value.",
                    };
                }
                const keys = Object.keys(props as Record<string, unknown>);
                if (keys.length === 0) {
                    return {
                        success: false,
                        type: "text",
                        content: "op='set' requires `properties` to contain at least one key.",
                    };
                }
                for (const key of keys) {
                    if (REFUSED_TAG_KEYS.has(key)) {
                        return {
                            success: false,
                            type: "text",
                            content:
                                `edit_files_frontmatter cannot edit the '${key}' key. ` +
                                `For tag operations use \`add_files_tags\` / \`remove_files_tags\` / \`set_files_tags\` ` +
                                `(each accepts one or more paths, with inline-tag awareness) or \`rename_tag\` ` +
                                `(vault-wide rename). These tools handle YAML + inline tags safely and support ` +
                                `add/remove/descendant semantics that this generic tool intentionally does not.`,
                        };
                    }
                    const value = (props as Record<string, unknown>)[key];
                    if (!isPlainJsonValue(value)) {
                        return {
                            success: false,
                            type: "text",
                            content:
                                `properties['${key}'] is not JSON-serialisable (functions, NaN/Infinity, ` +
                                `undefined, symbols, and circular references are not allowed).`,
                        };
                    }
                    setEntries.push([key, value]);
                }
                if (args["keys"] !== undefined) {
                    return {
                        success: false,
                        type: "text",
                        content: "op='set' does not accept the `keys` parameter; use `properties`.",
                    };
                }
            } else {
                // unset
                const rawKeys = args["keys"];
                if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
                    return {
                        success: false,
                        type: "text",
                        content: "op='unset' requires `keys` to be a non-empty array of frontmatter key names.",
                    };
                }
                for (let i = 0; i < rawKeys.length; i++) {
                    const k: unknown = rawKeys[i];
                    if (typeof k !== "string" || k.length === 0) {
                        return {
                            success: false,
                            type: "text",
                            content: `keys[${i}] must be a non-empty string.`,
                        };
                    }
                    if (REFUSED_TAG_KEYS.has(k)) {
                        return {
                            success: false,
                            type: "text",
                            content:
                                `edit_files_frontmatter cannot unset the '${k}' key. ` +
                                `Use \`set_files_tags\` with an empty tags array to clear frontmatter tags safely — ` +
                                `that path also coalesces the alternate 'tag'/'tags' keys. Use \`remove_files_tags\` ` +
                                `for inline tag removal.`,
                        };
                    }
                    unsetKeys.push(k);
                }
                // Dedupe while preserving order.
                const seen = new Set<string>();
                const dedupedUnsetKeys: string[] = [];
                for (const k of unsetKeys) {
                    if (seen.has(k)) continue;
                    seen.add(k);
                    dedupedUnsetKeys.push(k);
                }
                unsetKeys.length = 0;
                unsetKeys.push(...dedupedUnsetKeys);
                if (args["properties"] !== undefined) {
                    return {
                        success: false,
                        type: "text",
                        content: "op='unset' does not accept the `properties` parameter; use `keys`.",
                    };
                }
            }

            // ─── Resolve all files up front ───────────────────────────────
            const files: TFile[] = [];
            for (const p of paths) {
                const f = requireFile(plugin.app, p);
                if (isFailure(f)) return f;
                if (!(f instanceof TFile) || f.extension !== "md") {
                    return {
                        success: false,
                        type: "text",
                        content: `Not a markdown file: ${p}`,
                    };
                }
                files.push(f);
            }

            // ─── Apply per file ───────────────────────────────────────────
            const fileResults: EditFrontmatterFileResult[] = [];
            const skipped: { path: string; reason: string }[] = [];
            let totalKeysChanged = 0;

            const applyToFm = (fm: Record<string, unknown>): {
                changed: string[];
                noOp: string[];
            } => {
                const changed: string[] = [];
                const noOp: string[] = [];
                if (opName === "set") {
                    for (const [key, value] of setEntries) {
                        if (key in fm && deepEqual(fm[key], value)) {
                            noOp.push(key);
                            continue;
                        }
                        // Clone arrays/objects so the caller's values can't be
                        // accidentally mutated through the live frontmatter.
                        fm[key] = clonePlainValue(value);
                        changed.push(key);
                    }
                } else {
                    for (const key of unsetKeys) {
                        if (!(key in fm)) {
                            noOp.push(key);
                            continue;
                        }
                        delete fm[key];
                        changed.push(key);
                    }
                }
                return { changed, noOp };
            };

            for (const file of files) {
                let result: { changed: string[]; noOp: string[] };

                if (dryRun) {
                    // Simulate against a shallow snapshot of the cached
                    // frontmatter so we can report the expected impact
                    // without mutating anything.
                    const cache = plugin.app.metadataCache.getFileCache(file);
                    const fm = cache?.frontmatter as Record<string, unknown> | undefined;
                    const fmClone: Record<string, unknown> = fm ? structuredCloneSafe(fm) : {};
                    result = applyToFm(fmClone);
                } else {
                    // Real write: route through runVaultMutation so lock +
                    // checkpoint + audit fire BEFORE the YAML rewrite lands.
                    // The actual edit happens inside processFrontMatter to
                    // preserve YAML structure / quoting / key order — we
                    // capture the changed/noOp keys via closure for the
                    // structured response.
                    let captured: { changed: string[]; noOp: string[] } | null = null;
                    let processFailure: string | null = null;
                    const lockErr = await runVaultMutation(plugin, chatStream, {
                        kind: "modify",
                        path: file.path,
                        toolName: "edit_files_frontmatter",
                        perform: async () => {
                            try {
                                await plugin.app.fileManager.processFrontMatter(
                                    file,
                                    (fm: Record<string, unknown>) => {
                                        captured = applyToFm(fm);
                                    },
                                );
                            } catch (err) {
                                processFailure =
                                    `processFrontMatter failed: ${(err as Error)?.message ?? String(err)}`;
                                throw err;
                            }
                        },
                    });
                    if (processFailure !== null) {
                        skipped.push({ path: file.path, reason: processFailure });
                        continue;
                    }
                    if (lockErr) {
                        skipped.push({
                            path: file.path,
                            reason: typeof lockErr.content === "string"
                                ? lockErr.content
                                : "lock conflict",
                        });
                        continue;
                    }
                    result = captured ?? { changed: [], noOp: [] };
                }

                if (result.changed.length === 0 && result.noOp.length === 0) {
                    continue;
                }
                const entry: EditFrontmatterFileResult = { path: file.path };
                if (opName === "set" && result.changed.length > 0) {
                    entry.set_keys = result.changed;
                }
                if (opName === "unset" && result.changed.length > 0) {
                    entry.unset_keys = result.changed;
                }
                if (result.noOp.length > 0) {
                    entry.no_op_keys = result.noOp;
                }
                fileResults.push(entry);
                totalKeysChanged += result.changed.length;
            }

            return {
                success: true,
                type: "object",
                content: {
                    action: dryRun ? `dry_run_edit_files_frontmatter_${opName}` : `edit_files_frontmatter_${opName}`,
                    op: opName,
                    dry_run: dryRun,
                    files_processed: files.length,
                    files_changed: fileResults.length,
                    total_keys_changed: totalKeysChanged,
                    files: fileResults,
                    ...(skipped.length > 0 ? { skipped } : {}),
                },
            };
        },
        requiresConfirmation: true,
    };
}

/**
 * Deep-clone a JSON-safe value. We avoid the global `structuredClone` (not
 * universally available in older Electron renderers shipped with Obsidian on
 * mobile) and we don't need its full feature set — only plain JSON shapes
 * end up here, having already been validated by `isPlainJsonValue`.
 */
function clonePlainValue(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        const arr = value as unknown[];
        return arr.map((item) => clonePlainValue(item));
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
        out[k] = clonePlainValue((value as Record<string, unknown>)[k]);
    }
    return out;
}

/**
 * Same idea as `clonePlainValue` but with a tighter contract: input may
 * contain non-JSON values (functions, undefined) that we silently drop, so
 * the dry-run simulation never accidentally surfaces those as if they were
 * legitimate frontmatter. Plain values pass through verbatim.
 */
function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        const v = value[key];
        if (v === undefined) continue;
        if (typeof v === "function" || typeof v === "symbol") continue;
        if (typeof v === "object" && v !== null) {
            if (Array.isArray(v)) {
                const arr = v as unknown[];
                out[key] = arr.map((item) => clonePlainValue(item));
            } else {
                out[key] = clonePlainValue(v);
            }
        } else {
            out[key] = v;
        }
    }
    return out;
}
