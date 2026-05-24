import { describe, it, expect } from 'vitest';
import { replayUnitsInFrames } from '../src/views/session-view/history-replay-controller';
import type { DisplayUnit } from '../src/views/session-view/display-units';

describe('replayUnitsInFrames', () => {
    it('invokes append for every unit and reports progress', async () => {
        const units: DisplayUnit[] = [
            { msg: { id: '1', role: 'user', content: 'a', streaming: false, timestamp: 1 } },
            { msg: { id: '2', role: 'user', content: 'b', streaming: false, timestamp: 2 } },
            { msg: { id: '3', role: 'user', content: 'c', streaming: false, timestamp: 3 } },
        ];
        const appended: string[] = [];
        const progress: number[] = [];

        await replayUnitsInFrames(units, {
            appendUnit: (u) => { appended.push(u.msg.id); },
            onProgress: (done) => { progress.push(done); },
            batchSize: 2,
        });

        expect(appended).toEqual(['1', '2', '3']);
        expect(progress[progress.length - 1]).toBe(3);
    });

    it('aborts when signal is set', async () => {
        const ac = new AbortController();
        const units: DisplayUnit[] = Array.from({ length: 10 }, (_, i) => ({
            msg: { id: String(i), role: 'user' as const, content: 'x', streaming: false, timestamp: i },
        }));
        let count = 0;

        const promise = replayUnitsInFrames(units, {
            appendUnit: () => {
                count++;
                if (count === 2) ac.abort();
            },
            onProgress: () => {},
            signal: ac.signal,
            batchSize: 1,
        });

        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(count).toBe(2);
    });
});
