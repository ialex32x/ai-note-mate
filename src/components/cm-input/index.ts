/**
 * CodeMirror 6 Input Component with File Reference Support.
 *
 * This module provides a rich text input component based on CodeMirror 6,
 * with special support for Obsidian-style file references ([[path]] syntax).
 *
 * Usage:
 * ```ts
 * import { CMInput } from './components/cm-input';
 *
 * const input = new CMInput(containerEl, {
 *     app: this.app,
 *     placeholder: 'Type a message...',
 *     onEnter: (view) => {
 *         const content = input.getContent();
 *         // Handle send
 *         return true;
 *     },
 * });
 *
 * // Insert a file reference
 * input.insertFileRef(file);
 *
 * // Get content (includes [[path]] for file refs)
 * const content = input.getContent();
 *
 * // Extract just the file paths
 * const refs = input.getFileRefs();
 * ```
 */

export { CMInput, extractFileRefs, type CMInputOptions } from './cm-input';
export { FileRefWidget } from './file-ref-widget';
export { fileRefCompletionSource } from './file-ref-completion';
