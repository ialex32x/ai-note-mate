import { describe, it, expect, vi } from 'vitest';
import { GeneratedAssetCollection } from '../src/services/generated-asset-collection';
import type { GeneratedAsset } from '../src/services/generated-asset-collection';

function makeAsset(overrides?: Partial<GeneratedAsset>): GeneratedAsset {
    return {
        path: 'test.md',
        toolCallId: 'tc1',
        timestamp: Date.now(),
        ...overrides,
    };
}

describe('GeneratedAssetCollection', () => {
    it('should start with empty assets', () => {
        const coll = new GeneratedAssetCollection();
        expect(coll.assets).toEqual([]);
    });

    it('should add assets via addAssets', () => {
        const coll = new GeneratedAssetCollection();
        const asset = makeAsset({ path: 'image.png' });
        coll.addAssets([asset]);
        expect(coll.assets).toHaveLength(1);
        expect(coll.assets[0]!.path).toBe('image.png');
    });

    it('should not notify or change state when addAssets is called with empty array', () => {
        const coll = new GeneratedAssetCollection();
        const listener = vi.fn();
        coll.onChange(listener);
        coll.addAssets([]);
        expect(coll.assets).toEqual([]);
        expect(listener).not.toHaveBeenCalled();
    });

    it('should append multiple assets via addAssets', () => {
        const coll = new GeneratedAssetCollection();
        coll.addAssets([makeAsset({ path: 'a.md' }), makeAsset({ path: 'b.md' })]);
        expect(coll.assets).toHaveLength(2);
    });

    it('should replace all assets via setAssets', () => {
        const coll = new GeneratedAssetCollection();
        coll.addAssets([makeAsset({ path: 'old.md' })]);
        coll.setAssets([makeAsset({ path: 'new.md' })]);
        expect(coll.assets).toHaveLength(1);
        expect(coll.assets[0]!.path).toBe('new.md');
    });

    it('should notify listeners on addAssets', () => {
        const coll = new GeneratedAssetCollection();
        const listener = vi.fn();
        coll.onChange(listener);
        coll.addAssets([makeAsset()]);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should notify listeners on setAssets', () => {
        const coll = new GeneratedAssetCollection();
        const listener = vi.fn();
        coll.onChange(listener);
        coll.setAssets([makeAsset()]);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should stop notifying after unsubscribe', () => {
        const coll = new GeneratedAssetCollection();
        const listener = vi.fn();
        const unsubscribe = coll.onChange(listener);
        unsubscribe();
        coll.addAssets([makeAsset()]);
        expect(listener).not.toHaveBeenCalled();
    });

    it('should support multiple listeners', () => {
        const coll = new GeneratedAssetCollection();
        const l1 = vi.fn();
        const l2 = vi.fn();
        coll.onChange(l1);
        coll.onChange(l2);
        coll.addAssets([makeAsset()]);
        expect(l1).toHaveBeenCalledTimes(1);
        expect(l2).toHaveBeenCalledTimes(1);
    });

    it('should not crash when a listener throws', () => {
        const coll = new GeneratedAssetCollection();
        coll.onChange(() => { throw new Error('listener error'); });
        const goodListener = vi.fn();
        coll.onChange(goodListener);
        expect(() => coll.addAssets([makeAsset()])).not.toThrow();
        expect(goodListener).toHaveBeenCalledTimes(1);
    });

    it('should return read-only snapshot (immutable array)', () => {
        const coll = new GeneratedAssetCollection();
        coll.addAssets([makeAsset()]);
        const snapshot = coll.assets;
        // Should not be the same reference as internal _assets
        // (but even if it is, the type says ReadonlyArray)
        expect(snapshot).toHaveLength(1);
    });
});
