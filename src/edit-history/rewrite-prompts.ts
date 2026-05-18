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

/**
 * Continuation rules diverge from the rewrite trio: the input is context,
 * NOT something to transform. The output must be *only* the new text that
 * will be appended after the input verbatim.
 *
 * The "structural continuity" rule is a deliberate soft preference: it
 * prevents the model from gratuitously inventing new block-level structure
 * (e.g. dropping an `## H2` into the middle of plain prose) while still
 * allowing it to use such structure when the continuation genuinely calls
 * for it.
 */
const CONTINUE_RULES = [
    "You are a text continuation engine. Rules:",
    "- Output ONLY the continuation, no preface, no commentary, no markdown fences.",
    "- DO NOT repeat, quote, or restate any part of the input — the input is provided as context only.",
    "- The continuation will be appended IMMEDIATELY after the input verbatim, so start with the exact whitespace/punctuation needed for it to flow naturally (e.g. a leading space after a word, or a leading newline after a paragraph).",
    "- Match the input's language, tone, style, and formatting conventions (markdown, lists, code, math).",
    "- Structural continuity: PREFER NOT to introduce block-level structures (headings `#`/`##`/..., bullet or numbered lists, tables, blockquotes `>`, fenced code blocks, horizontal rules `---`) that do not already appear in the input. This is a soft preference — if such a structure is genuinely needed for clarity you may use it, but do so sparingly and never as a default. If the input is plain prose, continue with plain prose.",
    "- Stop at a natural stopping point; do not pad with filler.",
].join("\n");

/** System prompt for each rewrite action. */
export const REWRITE_PROMPTS: Record<EditAction, string> = {
    expand: `${COMMON_RULES}\nTask: Expand the following text with more detail, examples, or context. Keep the original meaning intact.`,
    shorten: `${COMMON_RULES}\nTask: Shorten the following text while preserving every key fact and the original meaning.`,
    polish: `${COMMON_RULES}\nTask: Polish the following text — improve fluency, word choice, and grammar without changing the meaning.`,
    continue: `${CONTINUE_RULES}\nTask: Continue writing from where the following text ends.`,
};
