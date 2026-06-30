// Re-export the full public API from sub-modules so all existing
// consumers (`import { ... } from "./context-compression"`) see the
// same surface as before.

export { ContextCompressor } from "./context-compressor";
export { estimateTokens, isValidBudgetHint } from "./token-estimation";
export { tryParseDelegateEnvelope } from "./envelope-shrink";
export { createChatCompletion, summarizeConversation, summarizeConversationToTitle } from "./summarizer";

export type {
    PromptConfig,
    ContextCompressionOptions,
    HistoryMessage,
    ConversationSummary,
    ContextCompressionResult,
} from "./types";
