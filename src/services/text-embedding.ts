import type { LLMProviderType } from "./providers";
import { createOpenAIEmbeddings } from "./providers/openai-provider";
import { createGeminiEmbeddings } from "./providers/gemini-provider";
import { MinimalModelConfig } from "./llm-provider";

// ─────────────────────────────────────────────
// Embedding API
// ─────────────────────────────────────────────

/**
 * Create text embeddings using the configured provider.
 * 
 * @param config Provider configuration including API key, model, etc.
 * @param texts Array of text strings to embed
 * @returns Array of embedding vectors (each is a number array)
 */
export async function createEmbeddings(
    config: MinimalModelConfig,
    texts: string[],
): Promise<number[][]> {
    switch (config.type) {
        case "openai":
            return createOpenAIEmbeddings(config, texts);
        case "gemini":
            return createGeminiEmbeddings(config, texts);
        default:
            throw new Error(`Unknown provider type for embedding: ${(config as any).type}`);
    }
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
 * Find the most similar texts to a query embedding.
 * Returns array of { index, similarity } sorted by similarity descending.
 *
 * @param queryEmbedding  The query vector to compare against
 * @param embeddings      Candidate vectors
 * @param topK            Maximum number of results to return (default 9)
 * @param minSimilarity   Minimum cosine similarity threshold; candidates below
 *                        this value are excluded from results (default 0, i.e. no filtering)
 */
export function findSimilar(
    queryEmbedding: number[],
    embeddings: number[][],
    topK: number = 9,
    minSimilarity: number = 0,
): Array<{ index: number; similarity: number }> {
    const similarities = embeddings.map((emb, index) => ({
        index,
        similarity: cosineSimilarity(queryEmbedding, emb),
    }));

    // Sort by similarity descending
    similarities.sort((a, b) => b.similarity - a.similarity);

    // Apply similarity threshold filter, then take topK
    const filtered = minSimilarity > 0
        ? similarities.filter(s => s.similarity >= minSimilarity)
        : similarities;

    return filtered.slice(0, topK);
}
