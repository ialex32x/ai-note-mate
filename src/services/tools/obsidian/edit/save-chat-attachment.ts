import { TFolder } from "obsidian";
import type NoteAssistantPlugin from "../../../../main";
import type { RegisteredTool, ChatMessage } from "../../../chat-stream";
import type { ToolCapability } from "../../../llm-provider";
import { joinPath } from "../../../../utils/path-helper";
import { resolveUniqueFilename } from "../../../../utils/attachment-utils";
import { DEFAULT_SETTINGS } from "../../../../settings";
import { runVaultMutation } from "../../../vault";

/**
 * Save the user's pasted image/attachment from the current turn's user
 * message into the vault under the configured image download directory.
 *
 * Zero-parameter tool — picks up attachments automatically from the most
 * recent user message in the conversation.  If the user pasted multiple
 * images in one message, all of them are saved in a single call.
 */
export function vaultSaveChatAttachment(plugin: NoteAssistantPlugin): RegisteredTool {
    return {
        ondemand: true,

        schema: {
            type: "function",
            function: {
                name: "save_chat_attachment",
                description:
                    "Save the image attachment(s) from the current user message into the vault. " +
                    "Use this when the user pastes one or more images and asks you to save, store, " +
                    "or keep them in the vault. " +
                    "The attachments are automatically detected from the current conversation turn — " +
                    "no parameters are needed. " +
                    "Saved files are placed in the configured attachments directory.",
                parameters: {
                    type: "object",
                    properties: {},
                    required: [],
                },
            },
        },
        capabilities: ["create_file", "read_file"] as ToolCapability[],
        requiresConfirmation: true,

        exec: async (chatStream, _args, _signal) => {
            // Find the most recent user message — it carries this turn's
            // attachments.  Walk backwards so we always resolve to the
            // correct turn even if the conversation history is deep.
            const messages = chatStream.messages;
            let lastUserMsg: ChatMessage | undefined;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i]!.role === "user") {
                    lastUserMsg = messages[i];
                    break;
                }
            }

            if (!lastUserMsg) {
                return {
                    success: false,
                    type: "text",
                    content: "No user message found in the current conversation.",
                };
            }

            const attachments = lastUserMsg.attachments;
            if (!attachments || attachments.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content:
                        "The current user message has no image attachments. " +
                        "The user needs to paste an image into the chat first.",
                };
            }

            const vault = plugin.app.vault;
            const imageDownloadDir =
                plugin.settings.imageDownloadDir || DEFAULT_SETTINGS.imageDownloadDir;
            const vaultRoot = vault.getRoot().path;
            const saveDir = joinPath(vaultRoot, imageDownloadDir);

            // Ensure the target directory exists
            const existingDir = vault.getAbstractFileByPath(saveDir);
            if (!existingDir) {
                await vault.createFolder(saveDir);
            } else if (!(existingDir instanceof TFolder)) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Cannot save attachments: "${imageDownloadDir}" exists but is a file, not a folder. ` +
                        `Change the image download directory in Settings → Note Mate → General.`,
                };
            }

            const savedPaths: string[] = [];
            const errors: string[] = [];

            for (const att of attachments) {
                try {
                    const adapter = vault.adapter;
                    if (!(await adapter.exists(att.cachePath))) {
                        errors.push(
                            `Attachment cache file no longer exists: ${att.cachePath}`,
                        );
                        continue;
                    }

                    const buf = await adapter.readBinary(att.cachePath);

                    // Resolve a collision-free name in the target directory.
                    const fileName = await resolveUniqueFilename(
                        saveDir,
                        att.fileName,
                        async (p) => vault.getAbstractFileByPath(p) !== null,
                    );
                    const targetPath = joinPath(saveDir, fileName);

                    // Use runVaultMutation for proper locking / checkpoint
                    // integration.  The mutation kind is "create" even though
                    // we are conceptually "saving" — the file is new to the
                    // vault at this path.
                    const lockErr = await runVaultMutation(plugin, chatStream, {
                        kind: "create",
                        path: targetPath,
                        toolName: "save_chat_attachment",
                        perform: async () => {
                            await vault.createBinary(targetPath, buf);
                        },
                    });
                    if (lockErr) {
                        errors.push(`Failed to save ${att.fileName}: ${String(lockErr.content)}`);
                        continue;
                    }

                    savedPaths.push(targetPath);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`Failed to save ${att.fileName}: ${msg}`);
                }
            }

            if (savedPaths.length === 0) {
                return {
                    success: false,
                    type: "text",
                    content:
                        `Failed to save any attachments. ` +
                        (errors.length > 0 ? errors.join("; ") : "Unknown error."),
                };
            }

            const resultLines = savedPaths.map((p) => `![${p}](${p})`);
            let content =
                `Saved ${savedPaths.length} attachment(s):\n` +
                resultLines.join("\n");

            if (errors.length > 0) {
                content += `\n\nSome attachments could not be saved: ${errors.join("; ")}`;
            }

            return {
                success: true,
                type: "text",
                content,
            };
        },
    };
}
