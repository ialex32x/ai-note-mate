// Internal helpers used only by session-view.ts. Not part of the public
// plugin API — callers outside `views/` should keep importing from
// `views/session-view` instead.
export { ScrollController } from './scroll-controller';
export { StreamingLoader } from './streaming-loader';
export { showInitializationError } from './init-error-screen';
export { appendErrorBubble, ErrorBubbleTracker } from './error-bubble';
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
} from './chat-factory';
export { rebuildSessionDropdown, type SessionDropdownDeps } from './session-dropdown';
export { SessionNavigator, type SessionNavigatorDeps } from './session-navigator';
