/**
 * Pure helper functions extracted from chat-stream.ts.
 *
 * These are standalone utilities used by {@link ChatStream} for
 * tool embedding composition, message budget backfill, media
 * attachment conversion, and ID generation.  Moved to a separate
 * file to keep chat-stream.ts focused on the core streaming /
 * tool-call orchestration logic.
 */
import { getLocale, tIn } from '../i18n';
import type {
    MediaAttachment,
    ModalityCapability,
    ChatMessageParam,
} from './llm-provider';
import type { RegisteredTool } from './chat-stream-types';
import type { ChatMessage, ToolCallResultInfo } from './chat-stream-types';

// ── Tool embedding composition ───────────────────────────────────────

/**
 * Build the text used to embed a tool for similarity ranking.
 *
 * Composition (newline-separated):
 *   1. `function.name` — usually a strong, language-neutral signal
 *      (e.g. `vault_grep_file`, `web_search`).
 *   2. {@link RegisteredTool.embeddingDescription} when present, otherwise
 *      `function.description` — the bulk of the semantic payload.
 *   3. Top-level parameter names, when discoverable from
 *      `function.parameters.properties` — surfaces hints the description
 *      may not spell out (e.g. `tags`, `query`, `path`).
 *   4. Multilingual trigger keywords from the locale bundle — gives BM25
 *      lexical traction on queries in the user's UI language even when
 *      the (English) description shares zero tokens with them.
 *
 * Step 4 is ranker-only: the model still sees the original English
 * `function.description` in the schema. Keeping the schema language-
 * stable avoids any risk of locale-dependent tool-calling regressions
 * in providers that were trained predominantly on English function
 * specs.
 *
 * Changes to this composition invalidate the embedder's per-text cache
 * (entries are keyed by sha256(text)). That's acceptable: a one-shot
 * re-embed of all on-demand tools on first use after the change.
 */
export function buildToolEmbeddingText(tool: RegisteredTool): string {
    const fn = tool.schema.function;
    const description = tool.embeddingDescription ?? fn.description ?? '';
    const properties = fn.parameters['properties'];
    const paramNames = (properties && typeof properties === 'object' && !Array.isArray(properties))
        ? Object.keys(properties)
        : [];
    const paramLine = paramNames.length > 0 ? `Parameters: ${paramNames.join(', ')}` : '';
    const triggerLine = buildToolTriggerLine(fn.name);
    return [fn.name, description, paramLine, triggerLine].filter(Boolean).join('\n');
}

/**
 * Build a comma-separated trigger line for `schemaName` by looking up
 * `tool.triggers.<schemaName>` in the active locale bundle AND in the
 * English bundle.
 *
 * Why concatenate both:
 *   - The active locale's keywords cover queries written entirely in
 *     the user's UI language (typical CJK chat-style prompts).
 *   - The English keywords cover the very common mixed-language case
 *     ("帮我 search markdown 文件", "RSSフィード を fetch して") that
 *     non-English users naturally produce around tech terms.
 *
 * Tools without an entry (most MCP-supplied tools, long-tail built-in
 * tools we haven't authored yet) yield an empty string and degrade
 * silently — they still benefit from the description-based ranking
 * just as before.
 *
 * The BM25 tokenizer treats commas as separators, so the exact
 * delimiter doesn't carry semantic weight; the comma+space form is
 * picked purely for readability when the composed text shows up in
 * debug logs.
 */
export function buildToolTriggerLine(schemaName: string): string {
    const key = `tool.triggers.${schemaName}`;
    const currentLocale = getLocale();
    const cur = tIn(currentLocale, key);
    const en = tIn('en', key);
    // `tIn` returns the key verbatim when the entry is missing — that's the
    // sentinel for "no triggers here, skip silently".
    const parts: string[] = [];
    if (cur && cur !== key) parts.push(cur);
    // Skip the English bundle when the active locale entry is already the
    // English string (active locale IS 'en', or the translator happened to
    // copy the English value verbatim) — avoids duplicating the same tokens.
    if (en && en !== key && en !== cur) parts.push(en);
    return parts.length > 0 ? `Triggers: ${parts.join(', ')}` : '';
}

// ── Tool result normalisation ────────────────────────────────────────

/** Tool_result `content` as sent to the LLM (matches `prompt()` reconstruction). */
export function toolResultApiContent(res: ToolCallResultInfo): string {
    return res.status === "error" && !res.result.startsWith("Error:")
        ? `Error: ${res.result}`
        : res.result;
}

// ── Budget hint backfill ─────────────────────────────────────────────

/**
 * Copy shrink cache from assembled API tool_results onto UI `tool_call`
 * messages ({@link ChatMessage.contentBudgetHint}).
 */
export function backfillChatMessageBudgetHints(
    chatMessages: ChatMessage[],
    apiToolResults: ChatMessageParam[],
): void {
    const hints = new Map<string, { hint: string; hintLen: number }>();
    for (const src of apiToolResults) {
        if (src.role !== "tool_result" || !src.toolCallId) continue;
        const hint = src.contentBudgetHint;
        const hintLen = src.contentBudgetHintForLength;
        if (hint == null || hintLen == null) continue;
        hints.set(src.toolCallId, { hint, hintLen });
    }
    if (hints.size === 0) return;

    for (const msg of chatMessages) {
        if (msg.role !== "tool_call" || !msg.toolCallMeta || !msg.toolCallResult) continue;
        const entry = hints.get(msg.toolCallMeta.toolCallId);
        if (!entry) continue;
        const apiContent = toolResultApiContent(msg.toolCallResult);
        if (apiContent.length !== entry.hintLen) continue;
        msg.contentBudgetHint = entry.hint;
        msg.contentBudgetHintForLength = entry.hintLen;
    }
}

// ── ID generation ────────────────────────────────────────────────────

export function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Media attachment helpers ─────────────────────────────────────────

/**
 * Convert a tool's `media` result payload into a `MediaAttachment`.
 * Tools may either include an explicit `kind` or rely on `mimeType` for inference;
 * unknown MIME types default to `image` to preserve backward behaviour.
 */
export function toMediaAttachment(content: unknown): MediaAttachment | null {
    if (typeof content !== "object" || content === null) return null;
    const c = content as {
        path?: string;
        kind?: ModalityCapability;
        mimeType?: string;
        base64?: string;
    };
    if (typeof c.mimeType !== "string" || typeof c.base64 !== "string") return null;
    const kind: ModalityCapability = c.kind ?? inferKindFromMime(c.mimeType);
    return {
        kind,
        mimeType: c.mimeType,
        base64: c.base64,
        sourcePath: typeof c.path === "string" ? c.path : undefined,
    };
}

export function inferKindFromMime(mime: string): ModalityCapability {
    const m = mime.toLowerCase();
    if (m.startsWith("audio/")) return "audio";
    if (m.startsWith("video/")) return "video";
    if (m === "application/pdf") return "pdf";
    return "image";
}

export function mediaKindLabel(kind: ModalityCapability): string {
    switch (kind) {
        case "image": return "Image";
        case "audio": return "Audio";
        case "video": return "Video";
        case "pdf":   return "PDF";
    }
}
