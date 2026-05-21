/**
 * Prompt refinement: take the user's in-progress draft (plus optional
 * tail-turn context) and ask the summarizer-tier LLM to rewrite it into
 * a clearer, more "AI-friendly" version of the same request.
 *
 * Deliberately reuses {@link createChatCompletion} (the same single-turn,
 * non-streaming channel as the summarizer and the insight extractor) so
 * no new provider plumbing is introduced and the cheaper summarizer
 * model handles the cost.
 *
 * Contract:
 *   - Returns the rewritten draft as plain text (no markdown code fence,
 *     no leading prefix).
 *   - Throws {@link PromptOptimizationError} on empty / non-meaningful
 *     model output.
 *   - Aborts and other LLM errors propagate unchanged so the caller
 *     can distinguish user-cancelled refinement from API failures.
 */

import type { MinimalModelConfig } from './llm-provider';
import { createChatCompletion } from './context-reducer';

/** Hard cap on draft length we forward to the LLM, mirroring the insight extractor budget. */
const MAX_DRAFT_CHARS = 4000;
/** Hard cap on the user-side context we attach (the question that anchored the previous reply). */
const MAX_USER_CHARS = 1500;
/** Hard cap on the assistant-reply context we attach. */
const MAX_REPLY_CHARS = 3000;

export class PromptOptimizationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PromptOptimizationError';
    }
}

export interface OptimizePromptInput {
    /** The user's current draft (raw editor content). MUST be non-empty after trim. */
    draft: string;
    /**
     * Optional context: the USER message that anchored the most recent
     * COMPLETED turn. Pairing it with {@link assistantReply} disambiguates
     * contrastive references ("this time / again / like before") that
     * the AI-side reply alone cannot resolve. Omit when there is no
     * completed turn yet, OR when no user message preceded the reply
     * (rare, but possible mid-session after history restoration).
     */
    userMessage?: string;
    /**
     * Optional context: the most recent COMPLETED assistant reply in the
     * session. Used to disambiguate forward references like "that file" /
     * "the topic above" / "section 3" without changing the user's intent.
     * Omit when the session has no completed turns yet.
     */
    assistantReply?: string;
}

/**
 * System prompt. Kept in English regardless of UI locale (matches the
 * project-wide convention for auxiliary one-shot prompts — see
 * `buildInsightDeepenPrompt` for the rationale). The rules block is
 * intentionally exhaustive: the summarizer-tier model is usually small
 * and benefits from explicit constraints over implicit ones.
 *
 * Layout: STEP 1 = classify intent, STEP 2 = rewrite with intent-aware
 * expansion. Without intent detection the rewrite tends to over-pad
 * single-question Q&A and under-detail image-generation prompts — the
 * latter being the canonical case where "more visual descriptors" is
 * exactly what a downstream image model needs to do its best work.
 */
const REFINE_SYSTEM_PROMPT = `\
You are a prompt-engineering assistant embedded in an AI chat tool. The user is composing their next message in an ongoing conversation with an AI. Your job is to rewrite their DRAFT into a clearer, more precise, more "AI-friendly" version of the SAME request — without changing what they actually want.

STEP 1 — Detect intent.
Read the DRAFT (and the PREVIOUS_TURN block when present) and silently classify it as ONE of:
- IMAGE_GENERATION — the user wants a picture / illustration / artwork to be generated.
- CODE — the user wants code to be written, modified, debugged, reviewed, or explained.
- WRITING — the user wants prose drafted, rewritten, summarized, translated, or polished (notes, emails, essays, replies…).
- VAULT_OPERATION — the user wants the AI to read, modify, organize, or tag notes inside their vault (file paths, [[wiki-links]], #tags).
- RESEARCH — the user wants the AI to gather, compare, or synthesize information.
- QA — the user is asking a direct question that expects a focused answer.
- OTHER — anything else.
Do NOT mention the classification in the output. It only steers your rewrite.

STEP 2 — Rewrite.

GENERAL RULES (apply to every intent):
- Preserve the user's intent, scope, and concrete details. Do NOT answer the request.
- PRESERVE THE REQUEST FRAMING. The DRAFT is a user message addressed TO the assistant. If it contains any signal that the user is asking for something to be produced — imperative verbs ("generate / write / draw / translate / list / explain / fix…"), Chinese request particles ("请 / 帮我 / 你 X / 我要 / 给我 / 做一个 / 来一个 / 输出 / 弄一份…"), or equivalent phrasings in any language — the rewrite MUST keep that "please do X" framing. NEVER collapse a request into a bare description / declarative noun phrase of the desired result. A description of what the output should look like is the SPEC; the rewrite must contain BOTH the REQUEST and the SPEC.
- Match the language of the DRAFT (do not translate).
- Keep verbatim: [[note titles]], #tags, file paths, code spans, URLs, quoted text, numeric values.
- Resolve ambiguous references using the PREVIOUS_TURN block when present:
    - forward references like "this", "that file", "section 3", "the topic above" → look up the AI side;
    - contrastive references like "again", "this time", "like before", "the same but for X" → look up the USER side to see what they asked last time, and what the AI did not yet do.
    Leave references untouched when PREVIOUS_TURN doesn't make them unambiguous.
- The PREVIOUS_TURN block is CONTEXT, not a continuation point. NEVER concatenate it into the rewrite, NEVER answer it, NEVER restart the previous task — your only output is a rewritten DRAFT.
- Do NOT invent new requirements, new subjects, new constraints, or wholly new directions. Only make explicit what is genuinely implied. (Surfacing a request verb that was mumbled in colloquial filler — e.g., "要个图" → "请生成一张图" — counts as making explicit, NOT as inventing.)
- Be concise where conciseness is appropriate (see per-intent rules below). No greetings, no apologies, no preamble, no meta-commentary, no markdown code fence around the output.
- If the DRAFT is already clear, well-specified, and intent-appropriate in length, return it essentially unchanged (only fix obvious typos / grammar).

INTENT-SPECIFIC EXPANSION (apply only when it matches the spirit of the original):
- IMAGE_GENERATION → ENRICH WITH VISUAL DETAIL, BUT KEEP THE REQUEST. The rewrite is still a user message asking the assistant to PRODUCE an image; it must read as "please generate / 请生成 / 帮我画 / 画一张 / generate an image of…" with the enriched visual specification attached. A pure visual description with no generation verb is NOT a valid rewrite of an image request — if the original asked for an image (including via colloquial mumbles like "要个图 / 弄一张 / 来张图 / 你输出"), the rewrite MUST keep a clear "make this image" framing at the front. Then, AND ONLY THEN, "longer + more specific" is almost always better: flesh out attributes that fit the subject the user described — composition / framing / camera angle, subject pose & expression, clothing or texture, setting and background, lighting (time of day, source, hardness), color palette and mood, art style or medium (photorealistic, watercolor, anime, oil painting, 3D render…), and level of detail / quality cues. Crucially: only elaborate the subject the USER named. Do NOT swap out their subject, change the genre, or bolt on unrelated elements. If the DRAFT already reads like a comma-separated tag list, keep that form; if it's a flowing scene description, keep prose and weave attributes in naturally.
  Worked example of the shape (NOT the wording — do not copy phrasing): a messy DRAFT like "嗯 要个图 海边傍晚 红色黄色 云彩 波光 油画 笔触感 不要照片 不要船人 安静" should be rewritten as something like "请生成一张油画风格的图：[enriched scene description here…]" — the "请生成" / "draw me" verb survives, the artistic intent ("油画 / 笔触感 / 不要照片") survives, and the negative constraints ("不要船 / 不要人") survive.
- CODE → Surface (when implied) the language, framework / version, target file or function, expected input / output shape, edge cases the user hinted at, and the preferred response format (full file vs patch vs explanation).
- WRITING → Surface (when implied) the target audience, tone, length, format (email / outline / essay / list / table…), and POV.
- VAULT_OPERATION → Surface the target file(s) / tag(s) / scope, and explicitly preserve any "don't blow away X" constraint the DRAFT implies. Never broaden a per-note action to a vault-wide one.
- RESEARCH → Surface comparison axes, the desired output shape (bullet list / comparison table / synthesis paragraph), and any citation expectation that is implied.
- QA → Keep it tight. State the desired depth ("one sentence", "with examples", "no code") only when implied. Do NOT pad a short question into a long one.
- OTHER → Apply the general rules and stop.

FORMAT:
- Use structure (short bullets, brief headings) only when it genuinely helps a multi-attribute request. IMAGE_GENERATION and multi-part CODE / WRITING / RESEARCH requests often benefit; single-question QA almost never does.
- Output a single block of plain text. No markdown code fences around the result.

OUTPUT: the rewritten DRAFT only. Nothing else.`;

/**
 * Build the user-role message.
 *
 * The PREVIOUS_TURN wrapper is rendered only when at least one side
 * (user or AI) of the previous completed exchange is available, so
 * the model never sees an empty / asymmetric context block telling it
 * to look at something that isn't there. Each side is independently
 * elided so a transcript that somehow has just the AI half (rare,
 * post-restore edge case) still ships useful context.
 */
function buildRefineUserPrompt(
    draft: string,
    userMessage: string,
    assistantReply: string,
): string {
    const lines: string[] = [];
    if (userMessage || assistantReply) {
        lines.push('PREVIOUS_TURN (most recent completed exchange — CONTEXT ONLY, do NOT respond to it):');
        if (userMessage) {
            lines.push(
                'USER (previous question):',
                '"""',
                userMessage,
                '"""',
            );
        }
        if (assistantReply) {
            lines.push(
                'AI (previous reply):',
                '"""',
                assistantReply,
                '"""',
            );
        }
        lines.push('');
    }
    lines.push(
        'DRAFT to rewrite:',
        '"""',
        draft,
        '"""',
        '',
        'Rewrite the DRAFT now. Reply with the rewritten text only.',
    );
    return lines.join('\n');
}

/**
 * Strip surface markup the model occasionally adds despite the
 * "no fence, no prefix" instruction. Conservative on purpose —
 * we only peel outer wrappers, not anything that might be part of
 * the actual draft (e.g. an inline code span inside the text).
 */
function unwrapResponse(raw: string): string {
    let s = raw.trim();
    if (!s) return s;

    // Strip a single outer ```fence``` block (with or without language tag).
    const fence = /^```[\w-]*\s*\n([\s\S]*?)\n```$/.exec(s);
    if (fence?.[1] !== undefined) {
        s = fence[1].trim();
    }

    // Strip a single pair of matching surrounding quotes — only when
    // BOTH ends agree AND the interior contains no quote of the same
    // type. Without the interior check, a legitimate draft like
    // `"Hello" is a common greeting — explain` would have its outer
    // quotes peeled, leaving a syntactically broken body. The
    // "wraps the whole output in quotes" failure mode we're trying to
    // recover from never produces interior quotes of the same type,
    // so this is a safe approximation.
    if (s.length >= 2) {
        const first = s[0];
        const last = s[s.length - 1];
        const inner = s.slice(1, -1);
        const isAsciiWrap = first === '"' && last === '"' && !inner.includes('"');
        const isSmartWrap = first === '\u201c' && last === '\u201d'
            && !/[\u201c\u201d]/.test(inner);
        if (isAsciiWrap || isSmartWrap) {
            const trimmed = inner.trim();
            if (trimmed.length > 0) s = trimmed;
        }
    }

    return s;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max) + '\n…[truncated]';
}

/**
 * One-shot LLM call that returns a refined version of the user's draft.
 *
 * @throws PromptOptimizationError when the model returns empty / unusable output.
 * @throws DOMException (`AbortError`) when the caller aborts via `signal`.
 * @throws any underlying provider error from {@link createChatCompletion}.
 */
export async function optimizePrompt(
    modelConfig: MinimalModelConfig,
    input: OptimizePromptInput,
    signal?: AbortSignal,
): Promise<string> {
    const draft = (input.draft ?? '').trim();
    if (!draft) {
        throw new PromptOptimizationError('Draft is empty');
    }

    const userMessage = truncate((input.userMessage ?? '').trim(), MAX_USER_CHARS);
    const assistantReply = truncate((input.assistantReply ?? '').trim(), MAX_REPLY_CHARS);
    const truncatedDraft = truncate(draft, MAX_DRAFT_CHARS);

    const userPrompt = buildRefineUserPrompt(truncatedDraft, userMessage, assistantReply);

    const raw = await createChatCompletion(
        modelConfig,
        [
            { role: 'system', content: REFINE_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
        ],
        signal,
    );

    const refined = unwrapResponse(raw ?? '');
    if (!refined) {
        throw new PromptOptimizationError('Model returned empty refinement');
    }
    return refined;
}
