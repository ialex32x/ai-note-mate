import { DefaultGeminiImageModel } from "./types";
import type {
	EmbeddingConfig,
	ImageGenConfig,
	NoteAssistantPluginSettings,
	ProviderProfile,
} from "./types";
import { ALL_TOOL_CAPABILITIES } from "../services/llm-provider";

export function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultProfile(): ProviderProfile {
	return {
		id: generateId(),
		name: 'DeepSeek',
		provider: 'openai',
		baseUrl: 'https://api.deepseek.com',
		model: 'deepseek-chat',
		apiKey: '',
		modalities: ['image'],
		maxTokens: 0,
	};
}

export function createDefaultImageGenConfig(): ImageGenConfig {
	return {
		id: generateId(),
		name: 'Gemini Image Gen',
		apiScheme: 'gemini',
		apiKey: '',
		model: DefaultGeminiImageModel,
	};
}

export function createDefaultEmbeddingConfig(): EmbeddingConfig {
	return {
		id: generateId(),
		name: 'Embedding',
		type: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		apiKey: '',
		model: 'text-embedding-3-small',
	};
}

export const DEFAULT_SETTINGS: NoteAssistantPluginSettings = {
	profiles: [createDefaultProfile()],
	activeProfileId: '',  // will be set to the first profile's id in loadSettings
	summarizerProfileId: '',
	systemPrompt: '',
	imageDownloadDir: 'Attachments',
	builtinWebSearchEnabled: true,
	builtinWebFetchEnabled: true,
	builtinRSSFetchEnabled: true,
	builtinJavaScriptEnabled: true,
	allowedCapabilities: [...ALL_TOOL_CAPABILITIES],
	imageGenConfigs: [],
	activeImageGenId: '',
	enterToSend: true,
	toolConfirmMode: 'auto',
	mcpServers: [],
	skillSearchPaths: [],
	embeddingEnabled: true,
	embeddingConfigs: [],
	activeEmbeddingId: '',
	memoryEnabled: true,
	memories: [],
	followUpSuggestionsEnabled: true,
	followUpSuggestionsStructured: false,
	followUpSuggestionsAutoSend: false,
	insightExtractionEnabled: false,
	insightExtractionMinReplyChars: 400,
};
