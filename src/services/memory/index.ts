/**
 * Public entry-points for the Memory feature.
 *
 * Internal modules are free to import from sub-files; outside callers
 * should pull from this barrel so the surface area stays explicit and
 * future refactors only need to update one re-export list.
 */

export {
    CRITICAL_HEADING_SUFFIX,
    MEMORY_ENTRY_LEVEL,
} from './constants';
export {
    isCriticalHeading,
    stripCriticalSuffix,
    formatFileHeading,
    isValidLogicalHeading,
} from './heading-format';
export {
    parseMemoryNote,
    renderMemoryEntry,
    trimTrailingBlankLines,
    type MemoryEntry,
    type ParsedMemoryNote,
} from './memory-note-parser';
export { stripCallouts } from './body-sanitizer';
export {
    MemoryStore,
    MemoryStoreError,
    isMemoryConfigured,
    findEntryByLogical,
    showMemoryStoreErrorNotice,
    type MemoryStoreErrorKind,
} from './memory-store';
export {
    buildMemorySystemPromptPrefix,
    type BuildMemoryPromptParams,
} from './memory-prompt';
export {
    extractMemoryOps,
    type MemoryExtractOp,
    type ExtractMemoryInput,
    type ExtractMemoryOptions,
} from './memory-extractor';
export {
    maybeExtractMemoriesAfterFinish,
} from './memory-runner';
export {
    maybeConsolidateMemories,
} from './memory-consolidator';
