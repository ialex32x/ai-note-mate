import { createOpenAIEmbeddings } from "./providers/openai-provider";
import { createGeminiEmbeddings } from "./providers/gemini-provider";
import { MinimalModelConfig } from "./llm-provider";

// ─────────────────────────────────────────────
// Embedding API
// ─────────────────────────────────────────────

/**
 * Per-call batch size limit when forwarding requests to the underlying
 * provider. Picked to satisfy the most restrictive OpenAI-compatible
 * embedding endpoint we currently target — Aliyun DashScope's
 * `text-embedding-v3 / v4` cap inputs at 10 per request (older v1/v2 at 25,
 * OpenAI proper at 2048). 10 is small enough to be universally safe; the
 * ChatStream tool-filter path also caches per text, so after the first call
 * only the query is a miss and the chunking degenerates to a single request.
 */
const EMBEDDING_BATCH_SIZE = 10;

function chunk<T>(arr: readonly T[], size: number): T[][] {
    if (size <= 0) return [arr.slice()];
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

function dispatchEmbeddings(
    config: MinimalModelConfig,
    texts: string[],
    signal?: AbortSignal,
): Promise<number[][]> {
    const providerType = config.type;
    switch (providerType) {
        case "openai":
            return createOpenAIEmbeddings(config, texts, signal);
        case "gemini":
            return createGeminiEmbeddings(config, texts, signal);
        case "anthropic":
            throw new Error("Anthropic does not provide an embeddings API. Use OpenAI or Gemini for embeddings.");
        default:
            throw new Error(`Unknown provider type for embedding: ${String(providerType)}`);
    }
}

/**
 * Create text embeddings using the configured provider.
 *
 * Splits the input into chunks of {@link EMBEDDING_BATCH_SIZE} and dispatches
 * the chunks in parallel, then re-assembles the vectors in the original order.
 * This keeps us within the per-request limits of every provider we currently
 * support without surfacing batching to callers.
 *
 * @param config Provider configuration including API key, model, etc.
 * @param texts  Array of text strings to embed
 * @param signal Optional AbortSignal forwarded to the underlying provider
 *   SDK so the embedding HTTP call(s) can be cancelled mid-flight when
 *   the caller's surrounding turn aborts. Without this, an already-
 *   aborted turn still pays the full embedding round-trip before the
 *   next signal check fires.
 * @returns      Array of embedding vectors in the same order as `texts`
 */
export async function createEmbeddings(
    config: MinimalModelConfig,
    texts: string[],
    signal?: AbortSignal,
): Promise<number[][]> {
    if (texts.length === 0) return [];
    const chunks = texts.length <= EMBEDDING_BATCH_SIZE
        ? [texts]
        : chunk(texts, EMBEDDING_BATCH_SIZE);
    console.debug(
        `Embedding: dispatching ${texts.length} text(s) in ${chunks.length} chunk(s) (batch=${EMBEDDING_BATCH_SIZE}, provider=${config.type}, model=${config.model})`,
    );

    if (chunks.length === 1) {
        return dispatchEmbeddings(config, chunks[0]!, signal);
    }

    const chunkResults = await Promise.all(
        chunks.map((c) => dispatchEmbeddings(config, c, signal)),
    );

    const out: number[][] = new Array<number[]>(texts.length);
    let cursor = 0;
    for (let ci = 0; ci < chunks.length; ci++) {
        const inputs = chunks[ci]!;
        const vectors = chunkResults[ci]!;
        if (vectors.length !== inputs.length) {
            throw new Error(
                `Embedding provider returned ${vectors.length} vectors for ${inputs.length} inputs`,
            );
        }
        for (let i = 0; i < vectors.length; i++) {
            out[cursor++] = vectors[i]!;
        }
    }
    return out;
}

// ─────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────

/**
 * Calculate cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 means identical.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error("Vectors must have the same dimension");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
    }

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Decide whether a query is too short / signal-poor to drive embedding-based
 * filtering. When this returns true, callers should fall back to the full
 * candidate set rather than risk wiping it out with a meaningless query.
 *
 * Heuristic:
 *   - After stripping whitespace / punctuation / symbols, fewer than 8
 *     characters → too short (catches "yes", "ok", "继续", "go on" …).
 *   - No CJK ideograph/kana/hangul AND no English-alphabet word (length ≥ 2)
 *     → too short (catches pure-number/pure-emoji follow-ups).
 *
 * Intentionally simple: cheap on every turn, easy to reason about, and a
 * false-negative just means we attach the full set (safe degradation).
 *
 * Lives in this file so every embedding-based shortlister (tool filter,
 * skill catalogue, future consumers) can share one definition of
 * "too short to bother".
 */
export function isQueryTooShort(text: string): boolean {
    if (!text) return true;
    const stripped = text.replace(/[\s\p{P}\p{S}]/gu, '');
    if (stripped.length < 8) return true;
    const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
    const hasEnglishWord = /[a-zA-Z]{2,}/.test(text);
    return !hasCJK && !hasEnglishWord;
}
