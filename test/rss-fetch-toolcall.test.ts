import { describe, expect, it } from 'vitest';
import { DEFAULT_RSS_FETCH_HARD_LIMIT, DEFAULT_RSS_FETCH_SOFT_LIMIT } from '../src/settings/defaults';
import { createRSSFetchTools } from '../src/services/tools/rss-fetch-toolcall';
import type NoteAssistantPlugin from '../src/main';

function makePlugin(): NoteAssistantPlugin {
    return { settings: {} } as NoteAssistantPlugin;
}

describe('createRSSFetchTools', () => {
    it('registers rss_fetch_feed with the fixed per-turn call budget', () => {
        const tools = createRSSFetchTools(makePlugin());

        expect(tools).toHaveLength(1);
        expect(tools[0]!.schema.function.name).toBe('rss_fetch_feed');
        expect(tools[0]!.maxCallsPerTurn).toEqual({
            soft: DEFAULT_RSS_FETCH_SOFT_LIMIT,
            hard: DEFAULT_RSS_FETCH_HARD_LIMIT,
        });
    });
});
