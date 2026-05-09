// Public entry module for plugin settings.
// The implementation has been split into ./settings/* and ./components/settings-sections/*
// This file is kept as a re-export barrel to preserve existing import paths.

export * from "./settings/types";
export {
	DEFAULT_SETTINGS,
	createDefaultEmbeddingConfig,
	createDefaultImageGenConfig,
	createDefaultProfile,
} from "./settings/defaults";
export {
	getActiveEmbeddingConfig,
	getActiveImageGenConfig,
	getActiveProfile,
	getSummarizerProfile,
} from "./settings/helpers";
export { NoteAssistantSettingTab } from "./settings/settings-tab";
