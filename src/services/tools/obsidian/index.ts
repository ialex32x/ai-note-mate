import type NoteAssistantPlugin from "../../../main";
import type { RegisteredTool } from "../../chat-stream";
import {
    vaultGetActiveFile,
    vaultGetFileState,
    vaultGetMetadata,
    vaultIsDirectory,
    vaultReadFile,
    vaultResolveLink,
} from "./read";
import { vaultBrowseDirectory } from "./browse";
import { vaultSearchContent, vaultSearchFiles } from "./search";
import {
    vaultAppendFile,
    vaultCreateFile,
    vaultDeleteFiles,
    vaultDeleteFolder,
    vaultInsertLines,
    vaultPrependFile,
    vaultRenameFile,
    vaultReplaceLines,
    vaultReplaceText,
} from "./write";
import { vaultGetOverview, vaultListFilesSorted } from "./overview";
import { vaultEditFileTags, vaultListTags, vaultRenameTag, vaultSearchByTag } from "./tags";
import { vaultFindOrphanFiles, vaultGetBacklinks } from "./graph";

/**
 * Build all Obsidian Vault tool definitions for use with ChatStream.registerTool().
 *
 * @param plugin - The NoteAssistantPlugin instance (plugin.app provides the Obsidian App)
 * @returns An array of RegisteredTool objects ready to be registered.
 *
 * @example
 * ```ts
 * const tools = createObsidianTools(plugin);
 * tools.forEach(t => chat.registerTool(t));
 * ```
 */
export function createObsidianTools(plugin: NoteAssistantPlugin): RegisteredTool[] {
    return [
        // Read
        vaultReadFile(plugin),
        vaultGetActiveFile(plugin),
        vaultGetMetadata(plugin),
        vaultGetFileState(plugin),
        vaultIsDirectory(plugin),
        vaultResolveLink(plugin),
        // List
        vaultBrowseDirectory(plugin),
        // Search
        vaultSearchFiles(plugin),
        vaultSearchContent(plugin),
        // Write
        vaultCreateFile(plugin),
        vaultAppendFile(plugin),
        vaultPrependFile(plugin),
        vaultDeleteFiles(plugin),
        vaultDeleteFolder(plugin),
        vaultRenameFile(plugin),
        vaultReplaceText(plugin),
        vaultReplaceLines(plugin),
        vaultInsertLines(plugin),
        // Overview
        vaultGetOverview(plugin),
        vaultListFilesSorted(plugin),
        // Tags
        vaultListTags(plugin),
        vaultSearchByTag(plugin),
        vaultRenameTag(plugin),
        vaultEditFileTags(plugin),
        // Graph
        vaultGetBacklinks(plugin),
        vaultFindOrphanFiles(plugin),
    ];
}
