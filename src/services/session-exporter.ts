import { Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type { ChatMessage } from './chat-stream';
import type NoteAssistantPlugin from '../main';
import { joinPath } from '../utils/path-helper';
import { CheckpointActionConfirmModal } from '../modals/checkpoint-action-confirm-modal';
import { t } from '../i18n';

/**
 * Serialize session messages to Markdown for export.
 * Only user/assistant messages are included; tool calls, thinking, and
 * system messages are skipped (thinking is preserved as a collapsible block).
 *
 * Extracted from SessionView.doExport (pure string-building portion).
 */
export function sessionToMarkdown(messages: ChatMessage[]): string {
    let content = '# AI Session Export\n\n';
    for (const msg of messages) {
        if (msg.role === 'user') {
            content += `## User\n\n${msg.content}\n\n`;
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

    const content = sessionToMarkdown(messages);
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
