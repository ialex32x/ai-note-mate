import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { migrateLegacySettingsShape } from '../src/settings/helpers';
import type { NoteAssistantPluginSettings, TextGenConfig } from '../src/settings/types';

function cloneDefaultSettings(): NoteAssistantPluginSettings {
    return {
        ...DEFAULT_SETTINGS,
        textGenConfigs: DEFAULT_SETTINGS.textGenConfigs.map(config => ({
            ...config,
            modalities: [...config.modalities],
        })),
        allowedCapabilities: [...DEFAULT_SETTINGS.allowedCapabilities],
        imageGenConfigs: DEFAULT_SETTINGS.imageGenConfigs.map(config => ({ ...config })),
        mcpServers: DEFAULT_SETTINGS.mcpServers.map(config => ({ ...config })),
        uploadConfigs: DEFAULT_SETTINGS.uploadConfigs.map(config => ({ ...config })),
        skillSearchPaths: [...DEFAULT_SETTINGS.skillSearchPaths],
        embeddingConfigs: DEFAULT_SETTINGS.embeddingConfigs.map(config => ({ ...config })),
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

describe('migrateLegacySettingsShape', () => {
    it('moves persisted legacy profile settings into textGenConfig fields after defaults are merged', () => {
        const legacyProfile = makeTextGenConfig('legacy-profile');
        const saved = {
            profiles: [legacyProfile],
            activeProfileId: 'legacy-profile',
            summarizerProfileId: 'legacy-summary',
            memories: [{ id: 'old-memory' }],
        } as Partial<NoteAssistantPluginSettings> & {
            profiles?: TextGenConfig[];
            activeProfileId?: string;
            summarizerProfileId?: string;
            memories?: unknown;
        };
        const settings = {
            ...cloneDefaultSettings(),
            ...saved,
        } as NoteAssistantPluginSettings & {
            profiles?: unknown;
            activeProfileId?: unknown;
            summarizerProfileId?: unknown;
            memories?: unknown;
        };

        migrateLegacySettingsShape(settings, saved);

        expect(settings.textGenConfigs).toEqual([legacyProfile]);
        expect(settings.activeTextGenConfigId).toBe('legacy-profile');
        expect(settings.summarizerTextGenConfigId).toBe('legacy-summary');
        expect('profiles' in settings).toBe(false);
        expect('activeProfileId' in settings).toBe(false);
        expect('summarizerProfileId' in settings).toBe(false);
        expect('memories' in settings).toBe(false);
    });

    it('keeps persisted textGenConfig fields when both new and legacy fields exist', () => {
        const newConfig = makeTextGenConfig('new-config');
        const saved = {
            textGenConfigs: [newConfig],
            activeTextGenConfigId: 'new-config',
            summarizerTextGenConfigId: 'new-summary',
            profiles: [makeTextGenConfig('legacy-profile')],
            activeProfileId: 'legacy-profile',
            summarizerProfileId: 'legacy-summary',
        } as Partial<NoteAssistantPluginSettings> & {
            profiles?: TextGenConfig[];
            activeProfileId?: string;
            summarizerProfileId?: string;
        };
        const settings = {
            ...cloneDefaultSettings(),
            ...saved,
        } as NoteAssistantPluginSettings & {
            profiles?: unknown;
            activeProfileId?: unknown;
            summarizerProfileId?: unknown;
        };

        migrateLegacySettingsShape(settings, saved);

        expect(settings.textGenConfigs).toEqual([newConfig]);
        expect(settings.activeTextGenConfigId).toBe('new-config');
        expect(settings.summarizerTextGenConfigId).toBe('new-summary');
        expect('profiles' in settings).toBe(false);
        expect('activeProfileId' in settings).toBe(false);
        expect('summarizerProfileId' in settings).toBe(false);
    });
});
