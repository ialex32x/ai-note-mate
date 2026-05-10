import { App, Notice, TFile } from 'obsidian';
import type { ChatMessage } from './chat-stream';

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
 * Full export flow: serialize, prompt user for destination via SaveFileModal,
 * write file to vault, open it in a new tab, and show notices.
 *
 * Extracted from SessionView.doExport.
 */
export async function exportSessionToVault(app: App, messages: ChatMessage[]): Promise<void> {
    const content = sessionToMarkdown(messages);

    const filename = `session-${new Date().toISOString().slice(0, 10)}.md`;
    const suggestedFolder = app.workspace.getActiveFile()?.parent ?? undefined;

    const { SaveFileModal } = await import('../modals/save-file-modal');
    const modal = new SaveFileModal(app, filename, suggestedFolder);
    const result = await modal.waitForResult();
    if (!result) return;

    const { folder, filename: chosenName } = result;
    const filePath = folder.path === '/' ? chosenName : `${folder.path}/${chosenName}`;

    try {
        const existing = app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
            await app.vault.modify(existing, content);
        } else {
            await app.vault.create(filePath, content);
        }
        const file = app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
            const leaf = app.workspace.getLeaf('tab');
            void leaf.openFile(file);
        }
        new Notice('Session exported successfully');
    } catch (err) {
        console.error('Export failed:', err);
        new Notice('Export failed' + String(err));
    }
}
