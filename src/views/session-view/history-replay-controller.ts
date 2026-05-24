import type { DisplayUnit } from './display-units';
import { historyReplayBatchSize } from './history-loading-config';

export interface ReplayUnitsOptions {
    appendUnit: (unit: DisplayUnit) => void;
    onProgress: (done: number, total: number) => void;
    signal?: AbortSignal;
    batchSize?: number;
}

/**
 * Render display units in batches, yielding to the browser between
 * frames so the main thread stays responsive during large replays.
 */
export async function replayUnitsInFrames(
    units: ReadonlyArray<DisplayUnit>,
    options: ReplayUnitsOptions,
): Promise<void> {
    const batchSize = options.batchSize ?? historyReplayBatchSize();
    const total = units.length;
    let done = 0;

    for (let i = 0; i < total; ) {
        if (options.signal?.aborted) {
            throw new DOMException('History replay aborted', 'AbortError');
        }

        const end = Math.min(i + batchSize, total);
        while (i < end) {
            const unit = units[i++];
            if (!unit) continue;
            options.appendUnit(unit);
            done++;
        }
        options.onProgress(done, total);

        if (i < total) {
            await yieldToNextFrame();
        }
    }
}

/** @internal test hook */
export function yieldToNextFrame(): Promise<void> {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        return new Promise(resolve => {
            window.requestAnimationFrame(() => resolve());
        });
    }
    return Promise.resolve();
}
