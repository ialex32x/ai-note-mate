// Public entry module for plugin settings.
// The implementation has been split into ./settings/* (now including ./settings/sections/*)
// This file is kept as a re-export barrel to preserve existing import paths.

export * from "./settings/types";
export {
	DEFAULT_SETTINGS,
	createDefaultEmbeddingConfig,
	createDefaultImageGenConfig,
	createDefaultSpeechToTextConfig,
	createDefaultProfile,
} from "./settings/defaults";
export {
	getActiveEmbeddingConfig,
	getActiveImageGenConfig,
	getActiveSpeechToTextConfig,
	getActiveProfile,
	getSummarizerProfile,
	getInsightsProfile,
	getSttBaseUrl,
	isActiveTextGenConfigured as isActiveProfileConfigured,
	isActiveImageGenConfigured,
	isActiveSpeechToTextConfigured,
	isValidCosBucketName,
	isCosConfigured,
	hasMcpServersConfigured,
	resolveSubAgentProvider,
} from "./settings/helpers";
export { NoteAssistantSettingTab } from "./settings/settings-tab";
