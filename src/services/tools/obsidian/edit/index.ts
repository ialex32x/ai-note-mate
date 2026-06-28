// Barrel export for vault edit (mutation) tools.
//
// Each tool lives in its own file under this folder; group them here so
// callers can keep using a single import path (`./edit`).

export { vaultCreateFile } from "./create-file";
export { vaultAppendFile } from "./append-file";
export { vaultPrependFile } from "./prepend-file";
export { vaultDeleteFiles } from "./delete-files";
export { vaultDeleteFolder } from "./delete-folder";
export { vaultRenameFile } from "./rename-file";
export { vaultReplaceText, vaultBatchReplaceText } from "./replace-text";
export { vaultSetSection } from "./set-section";
export { vaultInsertText } from "./insert-text";
export { vaultBatchSetFrontmatter, vaultBatchUnsetFrontmatter } from "./edit-frontmatter";
export { vaultWriteFile } from "./write-file";
export { vaultInstantiateTemplate } from "./instantiate-template";
export { vaultSaveChatAttachment } from "./save-chat-attachment";
