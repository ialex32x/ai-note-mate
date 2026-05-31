import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool } from "../../chat-stream";
import {
    vaultGetActiveFile,
    vaultGetFileState,
    vaultGetMetadata,
    vaultIsFolder,
    vaultReadFile,
    vaultReadSection,
    vaultResolveLink,
} from "./read";
import { vaultGrepFile, vaultSearchContent, vaultSearchFiles } from "./find";
import {
    vaultAppendFile,
    vaultCreateFile,
    vaultDeleteFiles,
    vaultDeleteFolder,
    vaultEditFilesFrontmatter,
    vaultInsertLinesBefore,
    vaultInstantiateTemplate,
    vaultPrependFile,
    vaultRenameFile,
    vaultEditLines,
    vaultReplaceText,
    vaultWriteFile,
} from "./edit";
import {
    vaultBrowseFolder,
    vaultFindOrphanFiles,
    vaultGetBacklinks,
    vaultGetOutgoingLinks,
    vaultGetOverview,
    vaultGetUnresolvedLinks,
    vaultListFilesSorted,
    vaultRankNotesByEmbeddedSize,
} from "./vault";
import { vaultAddFilesTags, vaultRemoveFilesTags, vaultSetFilesTags, vaultListTags, vaultRenameTag, vaultSearchByTag } from "./tags";
import {
    vaultReadCanvas,
    vaultCreateCanvas,
    vaultWriteCanvas,
    vaultAddCanvasNodes,
    vaultAddCanvasEdges,
    vaultLayoutCanvasGrid,
} from "./canvas";
import {
    vaultReadBase,
    vaultCreateBase,
    vaultWriteBase,
    vaultAddBaseView,
    vaultUpdateBaseFilters,
    vaultUpdateBaseViewOrder,
} from "./base";

/**
 * Tool partitioning rationale
 * ───────────────────────────
 * In multi-agent mode the Obsidian vault tool surface is split along a
 * single, easy-to-explain axis: **does the tool mutate the vault?**
 *
 *   - Read-only tools (read / search / list / metadata / graph queries
 *     and tag listings) → registered on the vault sub-agent. They can
 *     run multi-step explorations (e.g. read N files to compare them)
 *     without that intermediate content polluting the main thread's
 *     context window.
 *
 *   - Mutation tools (anything that writes, deletes, renames, or
 *     edits tags) → registered DIRECTLY on the main agent.
 *
 * Why all mutations go to main, not just content-writes:
 *  1. Eliminates a routing decision the LLM gets wrong: with a strict
 *     read/write split the rule is trivial ("looking → delegate, doing
 *     → main") instead of nuanced ("only delegate writes that don't
 *     have a content body").
 *  2. Removes the prompt-injection seam for content-bearing writes
 *     (`create_file` / `append_file` / `replace_text`):
 *     the literal file body rides as a JSON `content` field, never as
 *     prose inside `delegate_task.task`.
 *  3. Keeps the related hard rules (e.g. "tag edits MUST use
 *     `add_files_tags` / `remove_files_tags` / `set_files_tags`, not `replace_text`"; "moves MUST
 *     use `rename_or_move_file`, not delete+create") on the
 *     same agent that owns the tools they constrain — the rules and
 *     the tools live together.
 *
 * The vault sub-agent is therefore a pure inspection/query agent. Its
 * description, system prompt, and (display) label all reinforce that
 * read-only character so the routing LLM defaults to "inspect via
 * delegation, mutate directly".
 *
 * Single-agent fallback (no sub-agents configured) still uses the
 * union via `createObsidianTools()` — there's exactly one source of
 * truth for "every vault tool".
 */

/**
 * Vault tools that MUTATE the vault in any way: writing file bodies,
 * deleting, renaming/moving, or editing tags. Registered directly on
 * the main agent in multi-agent mode.
 *
 * Includes (so a future "what's a mutation tool?" check is unambiguous):
 *  - Content-writes: create / append / prepend / replace_text /
 *    edit_lines / insert_lines_before
 *    (replace_text batches multiple literal find/replace edits on a
 *    single file via its `replacements` array; edit_lines handles
 *    replace/delete via its `edits` array; insert_lines_before is
 *    a dedicated insert-before-line tool)
 *  - Structural: delete_files / delete_folder / rename_or_move_file
 *  - Frontmatter: edit_files_frontmatter (set/unset arbitrary YAML keys; tag
 *    keys are refused and routed to the tag-specific tools below)
 *  - Tag edits:   add_files_tags / remove_files_tags / set_files_tags / rename_tag (vault-wide)
 */
export function createObsidianMutationTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        // Content writes (path + literal body)
        vaultCreateFile(plugin),
        vaultAppendFile(plugin),
        vaultPrependFile(plugin),
        vaultReplaceText(plugin),
        vaultEditLines(plugin),
        vaultInsertLinesBefore(plugin),
        // Template instantiation (read template → replace vars → create file)
        vaultInstantiateTemplate(plugin),
        // Canvas / Bases (validated JSON Canvas / YAML writes)
        vaultCreateCanvas(plugin),
        vaultWriteCanvas(plugin),
        vaultAddCanvasNodes(plugin),
        vaultAddCanvasEdges(plugin),
        vaultLayoutCanvasGrid(plugin),
        vaultCreateBase(plugin),
        vaultWriteBase(plugin),
        vaultAddBaseView(plugin),
        vaultUpdateBaseFilters(plugin),
        vaultUpdateBaseViewOrder(plugin),
        // Structural writes (no content body)
        vaultDeleteFiles(plugin),
        vaultDeleteFolder(plugin),
        vaultRenameFile(plugin),
        // Frontmatter property edits (non-tag YAML keys)
        vaultEditFilesFrontmatter(plugin),
        // Tag edits
        vaultAddFilesTags(plugin),
        vaultRemoveFilesTags(plugin),
        vaultSetFilesTags(plugin),
        vaultRenameTag(plugin),
    ];
}

/**
 * Vault tools that only INSPECT the vault — read, search, list,
 * metadata, link graph, tag listings/searches. Registered on the vault
 * sub-agent in multi-agent mode.
 *
 * The vault sub-agent's one job is to answer "what's in the vault?"
 * questions. Anything that changes the vault belongs to the main agent.
 */
export function createObsidianReadOnlyTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        // Read
        vaultReadFile(plugin),
        vaultReadSection(plugin),
        vaultGetActiveFile(plugin),
        vaultGetMetadata(plugin),
        vaultGetFileState(plugin),
        vaultIsFolder(plugin),
        vaultResolveLink(plugin),
        // List / browse
        vaultBrowseFolder(plugin),
        // Search
        vaultSearchFiles(plugin),
        vaultSearchContent(plugin),
        vaultGrepFile(plugin),
        // Overview
        vaultGetOverview(plugin),
        vaultListFilesSorted(plugin),
        // Tag queries (NOT tag edits — those are mutations)
        vaultListTags(plugin),
        vaultSearchByTag(plugin),
        // Link graph
        vaultGetBacklinks(plugin),
        vaultGetOutgoingLinks(plugin),
        vaultGetUnresolvedLinks(plugin),
        vaultFindOrphanFiles(plugin),
        vaultRankNotesByEmbeddedSize(plugin),
        // Canvas / Bases inspection
        vaultReadCanvas(plugin),
        vaultReadBase(plugin),
    ];
}

/**
 * Build all Obsidian Vault tool definitions for use with ChatStream.registerTool().
 *
 * Returns the union of read-only and mutation tools. Used by the
 * single-agent fallback path; multi-agent mode partitions the two
 * groups across vault sub-agent (read-only) and main (mutations).
 *
 * @param plugin - The NoteAssistantPlugin instance (plugin.app provides the Obsidian App)
 * @returns An array of RegisteredTool objects ready to be registered.
 */
export function createObsidianTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        ...createObsidianReadOnlyTools(plugin),
        ...createObsidianMutationTools(plugin),
    ];
}

/**
 * Vault tools for the `vault_editor` sub-agent: the full read-only
 * inspection surface (so it can navigate and double-check before
 * editing) PLUS the subset of mutation tools that operate on the
 * CONTENT of a single already-existing file.
 *
 * Deliberately EXCLUDED — and the rationale matters enough to spell out:
 *
 *  - `create_file`: creating a new file is a main-agent planning
 *    decision. "Rewrite Foo.md" should never turn into "…and while I'm
 *    at it, spawn Foo-v2.md". If a task legitimately requires creating
 *    a sibling file (e.g. splitting one note into two), the editor
 *    refuses and surfaces the request as a warning — main agent takes
 *    over.
 *  - `delete_files` / `delete_folder` / `rename_or_move_file`: structural
 *    changes have nothing to do with rewriting a body. Giving the editor
 *    these tools just tempts it to "tidy up" on its own, which hides
 *    state changes from the main agent (violating the
 *    `§0.3 principle 1` of `docs/vault-editor-subagent-plan.md`).
 *  - `add_files_tags` / `remove_files_tags` / `set_files_tags` / `rename_tag` /
 *    `edit_files_frontmatter`: tag and frontmatter property edits are
 *    structural (vs content) when per-file, or vault-wide. Either way,
 *    they should stay explicit in the main agent's plan. The editor can
 *    still rewrite
 *    frontmatter text via `replace_text` (anchor or search mode) when
 *    that's genuinely part of a content rewrite — but it cannot
 *    trigger a tag-aware or property-aware structural edit
 *    unilaterally.
 *  - `write_file`: this is the NEW tool added for wholesale rewrites
 *    (§3.2 of the plan). Included here.
 *
 * The main agent explicitly does NOT get `write_file` — see
 * `docs/vault-editor-subagent-plan.md` §8.2 for why. Giving main the
 * overwrite tool would invite it to "read full + write full" and
 * negate the whole point of this sub-agent.
 */
export function createObsidianEditorTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        ...createObsidianReadOnlyTools(plugin),
        // Content writes ONLY — no structural mutations.
        vaultReplaceText(plugin),
        vaultEditLines(plugin),
        vaultInsertLinesBefore(plugin),
        vaultAppendFile(plugin),
        vaultPrependFile(plugin),
        vaultWriteFile(plugin),
    ];
}
