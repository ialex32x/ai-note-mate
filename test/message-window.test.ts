import { describe, it, expect } from 'vitest';
import { buildDisplayUnits } from '../src/views/session-view/display-units';
import { HISTORY_LOADING } from '../src/views/session-view/history-loading-config';
import type { ChatMessage } from '../src/services/chat-stream';

function makeMessages(count: number): ChatMessage[] {
    return Array.from({ length: count }, (_, i) => ({
        id: `m${i}`,
        role: 'user' as const,
        content: `msg ${i}`,
        streaming: false,
        timestamp: i,
    }));
}

/** Pure slice math mirroring MessageWindowController.init. */
function initialWindowStart(totalUnits: number): number {
    if (totalUnits < HISTORY_LOADING.minUnitsForWindowing) return 0;
    return Math.max(0, totalUnits - HISTORY_LOADING.initialTailUnits);
}

describe('message window slicing', () => {
    it('renders full history for small sessions', () => {
        const units = buildDisplayUnits(makeMessages(10));
        expect(initialWindowStart(units.length)).toBe(0);
        expect(units.slice(initialWindowStart(units.length)).length).toBe(10);
    });

    it('renders only the tail for large sessions', () => {
        const units = buildDisplayUnits(makeMessages(100));
        const start = initialWindowStart(units.length);
        expect(start).toBe(60);
        expect(units.slice(start).length).toBe(40);
    });
});
