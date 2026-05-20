import type { TipDefinition } from '../types';
import { configureProfileTip } from './configure-profile';
import { fileRefTriggerTip } from './file-ref-trigger';
import { createFirstSkillTip } from './create-first-skill';
import { createExampleBaseTip } from './create-example-base';
import { createExampleCanvasTip } from './create-example-canvas';
import { enableEmbeddingFilterTip } from './enable-embedding-filter';
import { analyzeVaultStructureTip } from './analyze-vault-structure';
import { configureMcpServersTip } from './configure-mcp-servers';
import { noteIllustrationTip } from './note-illustration';

/**
 * Authored order also dictates the navigation order in the popover.
 * Profile setup is listed first so new users see it before feature tips.
 */
export const BUILTIN_TIPS: readonly TipDefinition[] = [
    configureProfileTip,
    noteIllustrationTip,
    fileRefTriggerTip,
    createFirstSkillTip,
    createExampleBaseTip,
    createExampleCanvasTip,
    enableEmbeddingFilterTip,
    analyzeVaultStructureTip,
    configureMcpServersTip,
];
