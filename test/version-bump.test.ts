import { describe, it, expect } from 'vitest';

/**
 * Core logic extracted from version-bump.mjs so it can be tested in isolation.
 *
 * versions.json is a fallback for users whose Obsidian is older than
 * manifest.json's minAppVersion. Each entry is a threshold marker:
 * "starting from plugin version X, you need Obsidian version Y".
 *
 * So we only add a new entry when minAppVersion actually changes.
 * If it stays the same, the existing entry is already sufficient.
 */
function updateVersions(
	current: Record<string, string>,
	targetVersion: string,
	minAppVersion: string
): Record<string, string> {
	const versions = { ...current };

	const alreadyHasMinAppVersion = Object.values(versions).includes(minAppVersion);
	if (!alreadyHasMinAppVersion) {
		versions[targetVersion] = minAppVersion;
	}

	return versions;
}

describe('version-bump logic', () => {
	// -----------------------------------------------------------------------
	// Empty / first release — always add
	// -----------------------------------------------------------------------
	describe('empty versions.json (first release)', () => {
		it('adds the first entry', () => {
			const result = updateVersions({}, '1.0.0', '1.11.0');
			expect(result).toEqual({ '1.0.0': '1.11.0' });
		});
	});

	// -----------------------------------------------------------------------
	// Same minAppVersion — skip (no change)
	// -----------------------------------------------------------------------
	describe('same minAppVersion skips versions.json update', () => {
		it('skips when the only entry already has the same minAppVersion', () => {
			// "1.6.1": "1.11.4" already exists → releasing 1.6.2 with same
			// minAppVersion 1.11.4 should leave versions.json untouched.
			const result = updateVersions(
				{ '1.6.1': '1.11.4' },
				'1.6.2',
				'1.11.4'
			);
			expect(result).toEqual({ '1.6.1': '1.11.4' });
		});

		it('skips when any existing entry already has the same minAppVersion', () => {
			// Multiple entries, one already has 1.11.4.
			const current = {
				'1.0.0': '1.11.0',
				'1.1.2': '1.11.4',
			};
			const result = updateVersions(current, '1.6.2', '1.11.4');
			expect(result).toEqual({
				'1.0.0': '1.11.0',
				'1.1.2': '1.11.4',
			});
			expect(Object.keys(result)).toHaveLength(2);
		});

		it('skips even when many entries share the same minAppVersion', () => {
			// Realistic: several versions all requiring 1.11.4.
			const current: Record<string, string> = {
				'1.0.0': '1.11.0',
				'1.1.2': '1.11.4',
				'1.3.0': '1.11.4',
				'1.6.2': '1.11.4',
			};
			const result = updateVersions(current, '1.6.3', '1.11.4');
			expect(result).toEqual(current);
			expect(Object.keys(result)).toHaveLength(4);
		});
	});

	// -----------------------------------------------------------------------
	// Different minAppVersion — append
	// -----------------------------------------------------------------------
	describe('new minAppVersion appends a new entry', () => {
		it('appends when minAppVersion changes from the only entry', () => {
			const result = updateVersions(
				{ '1.6.1': '1.11.4' },
				'1.7.0',
				'1.11.5'
			);
			expect(result).toEqual({
				'1.6.1': '1.11.4',
				'1.7.0': '1.11.5',
			});
		});

		it('appends when minAppVersion is completely new', () => {
			const current = {
				'1.0.0': '1.11.0',
				'1.2.0': '1.11.4',
			};
			const result = updateVersions(current, '2.0.0', '1.12.0');
			expect(result).toEqual({
				'1.0.0': '1.11.0',
				'1.2.0': '1.11.4',
				'2.0.0': '1.12.0',
			});
			expect(Object.keys(result)).toHaveLength(3);
		});

		it('appends a new minor bump of minAppVersion', () => {
			const current = { '1.0.0': '1.11.0' };
			const result = updateVersions(current, '1.1.0', '1.11.4');
			expect(result).toEqual({
				'1.0.0': '1.11.0',
				'1.1.0': '1.11.4',
			});
		});
	});

	// -----------------------------------------------------------------------
	// Idempotent re-run
	// -----------------------------------------------------------------------
	describe('idempotent re-run', () => {
		it('no change when re-run with same version and same minAppVersion', () => {
			const current = { '1.0.0': '1.11.0', '1.6.1': '1.11.4' };
			const result = updateVersions(current, '1.6.1', '1.11.4');
			expect(result).toEqual({ '1.0.0': '1.11.0', '1.6.1': '1.11.4' });
		});

		it('adds entry when re-run with same version but minAppVersion changed', () => {
			// Extremely unlikely in practice, but safe to handle.
			// 1.6.1 existed with 1.11.3, now minAppVersion is 1.11.4.
			const current = { '1.0.0': '1.11.0', '1.6.1': '1.11.3' };
			const result = updateVersions(current, '1.6.1', '1.11.4');
			// 1.11.4 is new → appends (old 1.6.1 entry stays since we're
			// adding, not replacing — in practice this shouldn't happen).
			expect(result).toEqual({
				'1.0.0': '1.11.0',
				'1.6.1': '1.11.4', // overwritten by JS object key semantics
			});
		});
	});

	// -----------------------------------------------------------------------
	// Realistic scenario
	// -----------------------------------------------------------------------
	describe('realistic scenario', () => {
		it('current versions.json: same minAppVersion → skip', () => {
			const current: Record<string, string> = {
				'1.0.0': '1.11.0',
				'1.1.2': '1.11.4',
			};
			// Releasing 1.6.2 with minAppVersion 1.11.4 (same as 1.1.2).
			const result = updateVersions(current, '1.6.2', '1.11.4');
			// Should NOT add anything — 1.1.2 already marks the 1.11.4 threshold.
			expect(result).toEqual({
				'1.0.0': '1.11.0',
				'1.1.2': '1.11.4',
			});
		});

		it('current versions.json: minAppVersion changed → append', () => {
			const current: Record<string, string> = {
				'1.0.0': '1.11.0',
				'1.1.2': '1.11.4',
			};
			// Releasing 1.7.0 with minAppVersion 1.12.0 (new).
			const result = updateVersions(current, '1.7.0', '1.12.0');
			expect(result).toEqual({
				'1.0.0': '1.11.0',
				'1.1.2': '1.11.4',
				'1.7.0': '1.12.0',
			});
		});

		it('simulate full release history with correct threshold behavior', () => {
			let versions: Record<string, string> = {};

			// v1.0.0 — first release, requires Obsidian 1.11.0
			versions = updateVersions(versions, '1.0.0', '1.11.0');
			expect(versions).toEqual({ '1.0.0': '1.11.0' });

			// v1.1.0 — same minAppVersion → skip
			versions = updateVersions(versions, '1.1.0', '1.11.0');
			expect(versions).toEqual({ '1.0.0': '1.11.0' });

			// v1.2.0 — minAppVersion bumped to 1.11.4 → append
			versions = updateVersions(versions, '1.2.0', '1.11.4');
			expect(versions).toEqual({
				'1.0.0': '1.11.0',
				'1.2.0': '1.11.4',
			});

			// v1.3.0 through v1.6.2 — same minAppVersion → all skipped
			for (const v of ['1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.6.1', '1.6.2']) {
				versions = updateVersions(versions, v, '1.11.4');
			}
			expect(versions).toEqual({
				'1.0.0': '1.11.0',
				'1.2.0': '1.11.4',
			});

			// v1.7.0 — minAppVersion bumped to 1.12.0 → append
			versions = updateVersions(versions, '1.7.0', '1.12.0');
			expect(versions).toEqual({
				'1.0.0': '1.11.0',
				'1.2.0': '1.11.4',
				'1.7.0': '1.12.0',
			});
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------
	describe('edge cases', () => {
		it('handles pre-release semver tags', () => {
			const result = updateVersions(
				{ '1.0.0': '1.11.0' },
				'1.1.0-beta.1',
				'1.11.4'
			);
			expect(result).toEqual({
				'1.0.0': '1.11.0',
				'1.1.0-beta.1': '1.11.4',
			});
		});

		it('handles build-metadata semver tags', () => {
			const result = updateVersions({}, '2.0.0+20250101', '1.12.0');
			expect(result).toEqual({ '2.0.0+20250101': '1.12.0' });
		});

		it('input record is not mutated', () => {
			const current = { '1.0.0': '1.11.0' };
			updateVersions(current, '1.1.0', '1.11.4');
			expect(current).toEqual({ '1.0.0': '1.11.0' });
		});

		it('preserves unrelated entries untouched', () => {
			const current: Record<string, string> = {
				'0.1.0': '1.10.0',
				'0.2.0': '1.10.0',
				'1.0.0': '1.11.0',
			};
			// 1.11.0 already exists → skip
			const result = updateVersions(current, '1.1.0', '1.11.0');
			expect(result).toEqual(current);
		});
	});
});
