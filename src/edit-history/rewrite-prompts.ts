/**
 * Prompt templates used by the AI Edit History rewrite pipeline.
 *
 * Each prompt is built from a shared `COMMON_RULES` preamble plus a task
 * sentence. The preamble enforces strict "output only the rewritten text"
 * behaviour so the runner can replace the editor selection verbatim
 * without parsing the response.
 */

import type { EditAction } from "./edit-history-types";

const COMMON_RULES = [
    "You are an in-place text rewriter. Rules:",
    "- Output ONLY the rewritten text, no preface, no commentary, no markdown fences.",
    "- Preserve the original language (do NOT translate).",
    "- Preserve the original tone and style unless instructed otherwise.",
    "- Preserve all inline formatting markers (markdown, links, code spans, math) verbatim.",
].join("\n");

/** System prompt for each rewrite action. */
export const REWRITE_PROMPTS: Record<EditAction, string> = {
    expand: `${COMMON_RULES}\nTask: Expand the following text with more detail, examples, or context. Keep the original meaning intact.`,
    shorten: `${COMMON_RULES}\nTask: Shorten the following text while preserving every key fact and the original meaning.`,
    polish: `${COMMON_RULES}\nTask: Polish the following text — improve fluency, word choice, and grammar without changing the meaning.`,
};
