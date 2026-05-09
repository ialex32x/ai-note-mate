/**
 * Generic heuristic search engine scheduler.
 *
 * Each engine has a priority (lower = preferred).
 * - Initial priority: 0 (engines tried in registration order)
 * - Timeout or failure → priority + 1
 * - Success → priority resets to 0
 *
 * Usage:
 *   const scheduler = new SearchEngineScheduler<EngineId>();
 *   scheduler.register({ id: 'bing', name: 'Bing', search: fn });
 *   scheduler.register({ id: 'google', name: 'Google', search: fn });
 *   // getSorted() returns engines ordered by ascending priority
 */

export interface SearchEngine<TId = string> {
    id: TId;
    name: string;
    search: (query: string, limit: number, signal?: AbortSignal) => Promise<unknown[]>;
}

export class SearchEngineScheduler<TId = string> {
    private priorities = new Map<TId, number>();
    private engines = new Map<TId, SearchEngine<TId>>();

    register(engine: SearchEngine<TId>) {
        this.engines.set(engine.id, engine);
        if (!this.priorities.has(engine.id)) {
            this.priorities.set(engine.id, 0);
        }
    }

    /** Return engines sorted by ascending priority */
    getSorted(): SearchEngine<TId>[] {
        return Array.from(this.engines.values()).sort(
            (a, b) => (this.priorities.get(a.id) ?? 0) - (this.priorities.get(b.id) ?? 0)
        );
    }

    markSuccess(id: TId) {
        this.priorities.set(id, 0);
    }

    markFailure(id: TId) {
        this.priorities.set(id, (this.priorities.get(id) ?? 0) + 1);
    }

    getPriority(id: TId): number {
        return this.priorities.get(id) ?? 0;
    }
}
