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
export { vaultReplaceText } from "./replace-text";
export { vaultEditLines } from "./edit-lines";
export { vaultEditFilesFrontmatter } from "./edit-frontmatter";
export { vaultWriteFile } from "./write-file";
