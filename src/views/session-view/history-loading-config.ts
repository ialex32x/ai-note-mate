import { Platform } from 'obsidian';

/** Tunables for P1 (framed replay) and P2 (message windowing). */
export const HISTORY_LOADING = {
    /** Show the loading overlay when this many units will be rendered. */
    showOverlayMinUnits: 20,
    /** Display units rendered per animation frame (desktop). */
    batchSizeDesktop: 6,
    /** Display units rendered per animation frame (mobile). */
    batchSizeMobile: 4,
    /** Initial tail slice when windowing kicks in. */
    initialTailUnits: 40,
    /** Units prepended when the user loads older history. */
    olderBatchUnits: 30,
    /** Auto-load older history when scrollTop is below this (px). */
    autoLoadThresholdPx: 200,
    /** Enable tail-first windowing when total units reach this count. */
    minUnitsForWindowing: 40,
} as const;

export function historyReplayBatchSize(): number {
    return Platform?.isMobile
        ? HISTORY_LOADING.batchSizeMobile
        : HISTORY_LOADING.batchSizeDesktop;
}
