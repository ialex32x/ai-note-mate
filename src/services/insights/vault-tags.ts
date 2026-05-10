import { App, getAllTags } from 'obsidian';

/**
 * Collect every tag that currently exists anywhere in the vault, returned
 * as bare strings (no leading '#') sorted by descending usage count.
 *
 * This is used by the insight extractor so the LLM can be constrained to
 * pick from the user's existing tag vocabulary rather than inventing new
 * ones. The function walks the metadata cache for every markdown file,
 * which is O(N) in vault size but only runs on demand when an insight
 * extraction kicks off — we intentionally avoid caching here because tag
 * edits elsewhere in the app would silently stale the cache.
 */
export function collectVaultTags(app: App): string[] {
    const counts = new Map<string, number>();
    for (const file of app.vault.getMarkdownFiles()) {
        const cache = app.metadataCache.getFileCache(file);
        if (!cache) continue;
        const raw = getAllTags(cache);
        if (!raw) continue;
        // `getAllTags` already dedupes per-file.
        for (const tag of raw) {
            const bare = tag.startsWith('#') ? tag.substring(1) : tag;
            if (!bare) continue;
            counts.set(bare, (counts.get(bare) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([tag]) => tag);
}
