import { describe, it, expect } from 'vitest';

/**
 * Mirrors {@link BubbleListController.prepend} with a fixed anchor:
 * each unit is insertBefore(anchor), so chronological iteration preserves order.
 */
function simulatePrependBeforeAnchor(
    unitsToPrepend: number[],
    anchor: number,
    tail: number[],
): number[] {
    const dom = [...tail];
    for (const u of unitsToPrepend) {
        const idx = dom.indexOf(anchor);
        dom.splice(idx >= 0 ? idx : dom.length, 0, u);
    }
    return dom;
}

describe('history prepend order (fixed anchor)', () => {
    it('keeps chronological order when prepending a batch before the window start', () => {
        const batch = Array.from({ length: 19 }, (_, i) => i);
        const anchor = 19;
        const tail = Array.from({ length: 40 }, (_, i) => i + 19);
        const dom = simulatePrependBeforeAnchor(batch, anchor, tail);
        expect(dom).toEqual([...batch, ...tail]);
        expect(dom[0]).toBe(0);
    });

    it('reversing the batch inverts order (regression guard)', () => {
        const batch = Array.from({ length: 5 }, (_, i) => i);
        const anchor = 5;
        const tail = [5, 6, 7];
        const dom = simulatePrependBeforeAnchor([...batch].reverse(), anchor, tail);
        expect(dom).toEqual([4, 3, 2, 1, 0, 5, 6, 7]);
    });
});
