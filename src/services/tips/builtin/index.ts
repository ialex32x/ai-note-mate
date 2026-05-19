import type { TipDefinition } from '../types';
import { createFirstSkillTip } from './create-first-skill';
import { enableEmbeddingFilterTip } from './enable-embedding-filter';
import { analyzeVaultStructureTip } from './analyze-vault-structure';

/**
 * Authored order also dictates the navigation order in the popover.
 * Place broadly-applicable tips later so the more contextual ones surface
 * first when multiple are eligible.
 */
export const BUILTIN_TIPS: readonly TipDefinition[] = [
    createFirstSkillTip,
    enableEmbeddingFilterTip,
    analyzeVaultStructureTip,
];
