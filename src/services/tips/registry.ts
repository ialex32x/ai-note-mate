import type NoteAssistantPlugin from 'main';
import type { TipContext, TipDefinition } from './types';
import { BUILTIN_TIPS } from './builtin';

/**
 * Filter the built-in catalogue down to tips the user can usefully act
 * on right now: not already known, currently `available`, and not
 * `disqualified`. The result is order-preserving so the registry's
 * authoring order also defines the navigation order in the popover.
 */
export function getEligibleTips(ctx: TipContext): TipDefinition[] {
    const known = new Set(ctx.plugin.settings.knownTipIds);
    const eligible: TipDefinition[] = [];
    for (const tip of BUILTIN_TIPS) {
        if (known.has(tip.id)) continue;
        try {
            if (!tip.available(ctx)) continue;
            if (tip.disqualified(ctx)) continue;
        } catch (err) {
            // A buggy predicate must not take the whole popover down.
            console.warn(`[tips] predicate threw for "${tip.id}":`, err);
            continue;
        }
        eligible.push(tip);
    }
    return eligible;
}

/**
 * Persist `id` into `settings.knownTipIds`. Idempotent: a second call
 * with the same id is a no-op (and skips the settings write).
 */
export async function markTipKnown(
    plugin: NoteAssistantPlugin,
    id: string,
): Promise<void> {
    const known = plugin.settings.knownTipIds;
    if (known.includes(id)) return;
    known.push(id);
    await plugin.saveSettings();
}
