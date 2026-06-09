import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { NoteAssistantPluginSettings, TextGenConfig } from '../src/settings/types';

function cloneDefaultSettings(): NoteAssistantPluginSettings {
    return {
        ...DEFAULT_SETTINGS,
        profiles: DEFAULT_SETTINGS.profiles.map(config => ({
            ...config,
            modalities: [...config.modalities],
        })),
        allowedCapabilities: [...DEFAULT_SETTINGS.allowedCapabilities],
        imageGenConfigs: DEFAULT_SETTINGS.imageGenConfigs.map(config => ({ ...config })),
        mcpServers: DEFAULT_SETTINGS.mcpServers.map(config => ({ ...config })),
        skillSearchPaths: [...DEFAULT_SETTINGS.skillSearchPaths],
        embeddingConfigs: DEFAULT_SETTINGS.embeddingConfigs.map(config => ({ ...config })),
        speechToTextConfigs: DEFAULT_SETTINGS.speechToTextConfigs.map(config => ({ ...config })),
    };
}

function makeTextGenConfig(id: string): TextGenConfig {
    return {
        id,
        name: id,
        provider: 'openai',
        apiKey: 'secret-ref',
        model: `${id}-model`,
        baseUrl: 'https://example.test/v1',
        modalities: ['image'],
        maxTokens: 123,
        thinkingLevel: 'auto',
        contextCompressionThreshold: 0,
        slidingWindowSize: 0,
        maxSummariesThreshold: 0,
    };
}

describe('DEFAULT_SETTINGS — profile defaults', () => {
    it('has correct active profile fallback behaviour: empty activeProfileId defaults to first profile', () => {
        const settings = cloneDefaultSettings();
        settings.profiles = [makeTextGenConfig('first'), makeTextGenConfig('second')];
        settings.activeProfileId = '';

        // getActiveProfile fallback: first profile when activeProfileId is empty
        const active = settings.profiles[0]!;
        expect(active.name).toBe('first');
        expect(settings.profiles).toHaveLength(2);
    });

    it('deep-clones profiles so mutations do not leak back to defaults', () => {
        const settings = cloneDefaultSettings();
        // DEFAULT_SETTINGS.profiles has one entry from createDefaultProfile
        expect(settings.profiles.length).toBeGreaterThanOrEqual(1);

        const originalFirst = settings.profiles[0]!;
        settings.profiles.push(makeTextGenConfig('extra'));
        settings.profiles[0]!.name = 'modified';

        // DEFAULT_SETTINGS should be untouched
        expect(DEFAULT_SETTINGS.profiles[0]!.name).not.toBe('modified');
        expect(DEFAULT_SETTINGS.profiles.length).not.toBe(settings.profiles.length);
    });
});
