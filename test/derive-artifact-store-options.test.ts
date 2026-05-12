import { describe, it, expect } from "vitest";
import { deriveArtifactStoreOptions } from "../src/settings/helpers";
import { ARTIFACT_STORE_DEFAULTS } from "../src/services/artifact-store";
import { DEFAULT_SETTINGS } from "../src/settings/defaults";
import type { NoteAssistantPluginSettings } from "../src/settings/types";

/**
 * Tests for {@link deriveArtifactStoreOptions} — the bridge between
 * the plugin's persisted settings (KB / minutes, validated) and the
 * {@link ArtifactStore}'s native options (bytes / ms, unvalidated).
 *
 * The contract under test (mirrors plan §1.3 + helper's docblock):
 *   - Sane positive values → multiplied to bytes / ms.
 *   - Values < 1 for byte caps → fall back to ARTIFACT_STORE_DEFAULTS
 *     (would either disable the store or break LRU termination).
 *   - `ttlMinutes < 0` → fall back to default; `ttlMinutes === 0` is
 *     KEPT verbatim (legitimate "TTL disabled" sentinel — different
 *     from byte caps where 0 is nonsense).
 *   - `DEFAULT_SETTINGS` round-trips to ARTIFACT_STORE_DEFAULTS so a
 *     fresh install reproduces the historical behaviour exactly.
 */

function makeSettings(overrides: Partial<NoteAssistantPluginSettings>): NoteAssistantPluginSettings {
    return { ...DEFAULT_SETTINGS, ...overrides };
}

describe("deriveArtifactStoreOptions", () => {
    it("converts default settings to ARTIFACT_STORE_DEFAULTS verbatim", () => {
        const opts = deriveArtifactStoreOptions(DEFAULT_SETTINGS);
        expect(opts.totalBytesCap).toBe(ARTIFACT_STORE_DEFAULTS.totalBytesCap);
        expect(opts.singleArtifactCap).toBe(ARTIFACT_STORE_DEFAULTS.singleArtifactCap);
        expect(opts.ttlMs).toBe(ARTIFACT_STORE_DEFAULTS.ttlMs);
    });

    it("multiplies positive KB to bytes and minutes to ms", () => {
        const settings = makeSettings({
            artifactStoreTotalBytesKb: 2048,        // 2 MB
            artifactStoreSingleArtifactKb: 256,     // 256 KB
            artifactStoreTtlMinutes: 5,             // 5 min
        });
        const opts = deriveArtifactStoreOptions(settings);
        expect(opts.totalBytesCap).toBe(2048 * 1024);
        expect(opts.singleArtifactCap).toBe(256 * 1024);
        expect(opts.ttlMs).toBe(5 * 60_000);
    });

    it("falls back to default when totalBytesKb < 1", () => {
        for (const bad of [0, -1, -1024]) {
            const settings = makeSettings({ artifactStoreTotalBytesKb: bad });
            const opts = deriveArtifactStoreOptions(settings);
            expect(opts.totalBytesCap).toBe(ARTIFACT_STORE_DEFAULTS.totalBytesCap);
        }
    });

    it("falls back to default when singleArtifactKb < 1", () => {
        for (const bad of [0, -1, -128]) {
            const settings = makeSettings({ artifactStoreSingleArtifactKb: bad });
            const opts = deriveArtifactStoreOptions(settings);
            expect(opts.singleArtifactCap).toBe(ARTIFACT_STORE_DEFAULTS.singleArtifactCap);
        }
    });

    it("keeps ttlMinutes === 0 (TTL disabled sentinel)", () => {
        const settings = makeSettings({ artifactStoreTtlMinutes: 0 });
        const opts = deriveArtifactStoreOptions(settings);
        // The store's contract: ttlMs <= 0 means "disabled". We must
        // pass 0 through unchanged; falling back to the 30-minute
        // default here would silently override the user's explicit
        // "no TTL" choice.
        expect(opts.ttlMs).toBe(0);
    });

    it("falls back to default when ttlMinutes is negative", () => {
        // Negative minutes have no meaning. The settings UI uses -1
        // as its "NaN / unparseable input" sentinel (see global-section.ts);
        // the helper must round that back to the 30-min default.
        const settings = makeSettings({ artifactStoreTtlMinutes: -1 });
        const opts = deriveArtifactStoreOptions(settings);
        expect(opts.ttlMs).toBe(ARTIFACT_STORE_DEFAULTS.ttlMs);
    });

    it("rounds non-integer KB values down (Math.floor) to keep byte counts integral", () => {
        // ArtifactStore byte counts are integers throughout. We don't
        // expose fractional KB to the user, but the parser would let
        // a stray decimal land here; document the rounding rule.
        const settings = makeSettings({
            artifactStoreTotalBytesKb: 1.9,
            artifactStoreSingleArtifactKb: 0.5,    // < 1 → default
            artifactStoreTtlMinutes: 0.7,
        });
        const opts = deriveArtifactStoreOptions(settings);
        // 1.9 KB ≥ 1 → Math.floor(1.9 * 1024) = 1945
        expect(opts.totalBytesCap).toBe(Math.floor(1.9 * 1024));
        // 0.5 KB < 1 → default
        expect(opts.singleArtifactCap).toBe(ARTIFACT_STORE_DEFAULTS.singleArtifactCap);
        // 0.7 min ≥ 0 → Math.floor(0.7 * 60_000) = 42_000
        expect(opts.ttlMs).toBe(Math.floor(0.7 * 60_000));
    });
});
