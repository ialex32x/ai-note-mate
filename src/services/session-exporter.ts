import { Notice, TFile, TFolder, normalizePath, type App } from 'obsidian';
import type { ChatMessage } from './chat-stream';
import type { ChatAttachment } from './chat-stream-types';
import type NoteAssistantPlugin from '../main';
import { joinPath } from '../utils/path-helper';
import { copyAttachmentToDir } from '../utils/attachment-utils';
import { CheckpointActionConfirmModal } from '../modals/checkpoint-action-confirm-modal';
import { t } from '../i18n';

/**
 * Serialize session messages to Markdown for export.
 * Only user/assistant messages are included; tool calls and
 * system messages are skipped (thinking is preserved as a collapsible block).
 *
 * @param messages - The chat messages to serialize.
 * @param attachmentMap - Optional mapping from attachment cachePath to the
 *   filename used in the exported note (e.g. for ![]() references). When
 *   provided, user messages that carry attachments will include inline
 *   image references after their text content.
 */
export function sessionToMarkdown(
    messages: ChatMessage[],
    attachmentMap?: Map<string, string>,
): string {
    let content = '# AI Session Export\n\n';
    for (const msg of messages) {
        if (msg.role === 'user') {
            content += `## User\n\n${msg.content}\n\n`;
            // Emit image references for pasted attachments when an
            // attachmentMap is supplied (the caller is responsible for
            // copying the actual binary files to the export directory).
            if (msg.attachments && msg.attachments.length > 0 && attachmentMap) {
                for (const att of msg.attachments) {
                    const exportName = attachmentMap.get(att.cachePath);
                    if (exportName) {
                        content += `![${att.fileName}](${encodeURI(exportName)})\n\n`;
                    }
                }
            }
        } else if (msg.role === 'assistant') {
            content += '## Assistant\n\n';
            if (msg.thinkingContent) {
                content += `<details>\n<summary>Thinking</summary>\n\n${msg.thinkingContent}\n\n</details>\n\n`;
            }
            if (msg.content) {
                content += msg.content + '\n\n';
            }
        }
    }
    return content;
}

/**
 * Full export flow: serialize the session to Markdown and write it to the
 * vault under the user-configured `saveAsNoteDir`.
 *
 * Behaviour:
 *   - If `saveAsNoteDir` is empty/whitespace, surface a Notice prompting
 *     the user to configure it in Settings → General; nothing is written.
 *   - If the configured directory does not yet exist, ask the user to
 *     confirm before we create it on the fly. `Vault.createFolder()`
 *     accepts nested paths (Obsidian creates each missing segment), so
 *     we don't need to walk the tree manually.
 *   - The output file is timestamped (`session-YYYY-MM-DD.md`); if the
 *     same name already exists in the target dir, we overwrite — same
 *     "single click → done" semantics the Save-as-note button has had
 *     before, just without a picker UI.
 *   - On success, open the file in the active tab (no new pane) and
 *     surface a Notice. Failures surface an error Notice.
 */
export async function exportSessionToVault(
    plugin: NoteAssistantPlugin,
    messages: ChatMessage[],
): Promise<void> {
    const app = plugin.app;
    const rawDir = plugin.settings.saveAsNoteDir?.trim() ?? '';
    if (!rawDir) {
        new Notice(t('view.exportNoDirConfigured'));
        return;
    }

    const dir = normalizePath(rawDir);
    const filename = `session-${new Date().toISOString().slice(0, 10)}.md`;
    const filePath = joinPath(dir, filename);

    // Verify the configured directory exists. `getAbstractFileByPath`
    // returns the same instance Obsidian tracks internally — comparing
    // against TFolder rejects "name collides with an existing file".
    const existingDir = app.vault.getAbstractFileByPath(dir);
    if (existingDir && !(existingDir instanceof TFolder)) {
        new Notice(t('view.exportDirIsFile', { path: dir }));
        return;
    }

    if (!existingDir) {
        const confirmed = await new CheckpointActionConfirmModal(
            app,
            t('view.exportCreateDirTitle'),
            t('view.exportCreateDirMessage', { path: dir }),
            t('view.exportCreateDirConfirm'),
            'accept',
        ).waitForResult();
        if (!confirmed) return;
    }

    // Collect and copy pasted image attachments from user messages
    // so they are included in the exported note.
    const attachmentMap = await copyAttachmentsForExport(app, messages, dir);

    const content = sessionToMarkdown(messages, attachmentMap);
    try {
        if (!existingDir) {
            await app.vault.createFolder(dir);
        }
        const existingFile = app.vault.getAbstractFileByPath(filePath);
        if (existingFile instanceof TFile) {
            await app.vault.modify(existingFile, content);
        } else {
            await app.vault.create(filePath, content);
        }
        // Open in the active tab — same behaviour as before the picker
        // was removed (Cmd/Ctrl+click in the originating menu still
        // gets a new tab via Obsidian's default link routing).
        void app.workspace.openLinkText(filePath, '', false);
        new Notice(t('view.exportSucceeded', { path: filePath }));
    } catch (err) {
        console.error('Export failed:', err);
        new Notice(t('view.exportFailed', { error: String(err) }));
    }
}

// ---------------------------------------------------------------------------
// Attachment copy helpers
// ---------------------------------------------------------------------------

/**
 * Collect all unique attachments from user messages, copy each cached
 * binary to the export directory via {@link copyAttachmentToDir}, and
 * return a map from cachePath → exported filename so
 * {@link sessionToMarkdown} can emit ![]() references.
 */
async function copyAttachmentsForExport(
    app: App,
    messages: ChatMessage[],
    exportDir: string,
): Promise<Map<string, string>> {
    const map = new Map<string, string>();

    // Gather unique attachments (deduplicate by cachePath).
    const unique: ChatAttachment[] = [];
    const seen = new Set<string>();
    for (const msg of messages) {
        if (!msg.attachments) continue;
        for (const att of msg.attachments) {
            if (!seen.has(att.cachePath)) {
                seen.add(att.cachePath);
                unique.push(att);
            }
        }
    }

    if (unique.length === 0) return map;

    for (const att of unique) {
        const targetPath = await copyAttachmentToDir(
            app,
            att.cachePath,
            exportDir,
            att.fileName,
        );
        if (targetPath) {
            // Extract just the filename portion for the markdown reference.
            const exportName = targetPath.slice(targetPath.lastIndexOf('/') + 1);
            map.set(att.cachePath, exportName);
        }
    }

    return map;
}
