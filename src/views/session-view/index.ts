// Internal helpers used only by session-view.ts. Not part of the public
// plugin API — callers outside `views/` should keep importing from
// `views/session-view` instead.
export { ScrollController } from './scroll-controller';
export { TypingIndicator } from './typing-indicator';
export { showInitializationError } from './init-error-screen';
export { appendErrorBubble } from './error-bubble';
export {
    updateSessionTitle,
    handleTitleClick,
    maybeGenerateSessionTitle,
} from './session-title-editor';
export {
    createSummarizerConfig,
    createEmbeddingConfig,
    createProviderForActiveProfileOf,
    createChatAgent,
    buildDynamicTools,
    type ChatAgentCallbacks,
} from './chat-factory';
export { InsightCoordinator, type InsightDeps } from './insight-coordinator';
export { rebuildSessionDropdown, type SessionDropdownDeps } from './session-dropdown';
export { SessionNavigator, type SessionNavigatorDeps } from './session-navigator';
