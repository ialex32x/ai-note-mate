// SessionView class + internal helpers. External callers outside `views/`
// should keep importing from `views/session-view`.
export { SessionView } from './session-view';
export { ScrollController } from './scroll-controller';
export {
    updateSessionTitle,
    handleTitleClick,
    maybeGenerateSessionTitle,
} from './session-title-editor';
export {
    createSummarizerConfig,
    createInsightsConfig,
    createEmbeddingConfig,
    createToolFilterOptions,
    createProviderForActiveProfileOf,
    createChatAgent,
    buildDynamicTools,
    type ChatAgentCallbacks,
} from '../../services/chat-factory';
export { rebuildSessionDropdown, type SessionDropdownDeps } from './session-dropdown';
export { SessionNavigator, type SessionNavigatorDeps } from './session-navigator';
export { BubbleListController, type BubbleListControllerDeps } from './bubble-list-controller';
export {
    SessionStatusController,
    type SessionStatusControllerDeps,
} from './session-status-controller';
