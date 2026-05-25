import { describe, expect, it } from 'vitest';
import { DEFAULT_RSS_FETCH_HARD_LIMIT, DEFAULT_RSS_FETCH_SOFT_LIMIT } from '../src/settings/defaults';
import { createRSSFetchTools } from '../src/services/tools/rss-fetch-toolcall';
import type NoteAssistantPlugin from '../src/main';

function makePlugin(builtinRSSFetchEnabled: boolean): NoteAssistantPlugin {
    return {
        settings: {
            builtinRSSFetchEnabled,
        },
    } as NoteAssistantPlugin;
}

describe('createRSSFetchTools', () => {
    it('does not register the RSS tool when disabled', () => {
        expect(createRSSFetchTools(makePlugin(false))).toEqual([]);
    });

    it('registers rss_fetch_feed with the fixed per-turn call budget', () => {
        const tools = createRSSFetchTools(makePlugin(true));

        expect(tools).toHaveLength(1);
        expect(tools[0]!.schema.function.name).toBe('rss_fetch_feed');
        expect(tools[0]!.maxCallsPerTurn).toEqual({
            soft: DEFAULT_RSS_FETCH_SOFT_LIMIT,
            hard: DEFAULT_RSS_FETCH_HARD_LIMIT,
        });
    });
});
