import {
    ACTION_LIST_ITEM_LABEL_RE,
    COLON_LIST_INTRO_HINTS,
    DEFINITION_LIST_ITEM_MIN_BODY,
    DEFINITION_LIST_ITEM_RE,
    DESCRIPTIVE_INTRO_LINE_RES,
    FOLLOWUP_HEADERS,
    OFFER_PREFIXES_AT_START,
    OPTION_LIST_ITEM_LABEL_RE,
    OR_CHOICE_SEPARATORS,
    SINGLE_QUESTION_HINTS,
} from './triggers';
import type { ExtractOptions, SuggestedAction, SuggestedClientAction } from './types';
import { stripMarkdownToPlainText } from '../../utils/markdown-sanitizer';
import { truncate } from '../../utils/string-truncate';

const DEFAULT_LIMIT = 4;
const DEFAULT_LABEL_MAX = 40;

/**
 * Matches the structured block:
 *   <!--suggestions
 *   - label: ...
 *     prompt: ...
 *   -->
 *
 * Multiline, capturing the body between the opening and closing tokens.
 */
const STRUCTURED_BLOCK_RE = /<!--\s*suggestions\s*([\s\S]*?)-->/i;

/**
 * Strip the structured suggestions block from a markdown string so that it
 * is never shown to the user, even if the caller decides to render the
 * markdown verbatim (e.g. in history).
 */
export function stripStructuredBlock(markdown: string): string {
    return markdown.replace(STRUCTURED_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Remove fenced code blocks (``` … ``` and ~~~ … ~~~) from markdown.
 *
 * Used before heuristic follow-up extraction so YAML / shell / JSON snippets
 * in the reply are not mistaken for suggestion lists (e.g. frontmatter
 * `tags:\n  - app/p4` matching the "colon + bullet list" fallback).
 */
function stripFencedCodeBlocks(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?```/g, '')
        .replace(/~~~[\s\S]*?~~~/g, '');
}

/**
 * Main entry point. Returns an ordered list of suggested actions parsed
 * from the assistant's final message content. Returns an empty array
 * when nothing meaningful is found.
 */
export function extractSuggestions(
    markdown: string,
    opts: ExtractOptions,
): SuggestedAction[] {
    if (!markdown || !markdown.trim()) return [];

    const limit = opts.limit ?? DEFAULT_LIMIT;
    const labelMax = opts.labelMaxLength ?? DEFAULT_LABEL_MAX;

    // 1) Structured block takes precedence when enabled.
    if (opts.allowStructured) {
        const structured = parseStructuredBlock(markdown);
        if (structured.length > 0) {
            return normalize(structured, limit, labelMax);
        }
    }

    // 2) Heuristic fallback.
    const heuristic = parseHeuristic(markdown);
    return normalize(heuristic, limit, labelMax);
}

// ─── Structured parsing ────────────────────────────────────────────────

function parseStructuredBlock(markdown: string): SuggestedAction[] {
    const m = STRUCTURED_BLOCK_RE.exec(markdown);
    if (!m) return [];
    const body = m[1] ?? '';
    const out: SuggestedAction[] = [];

    // Internal accumulator. We collect raw `action` / `path` strings and
    // only attempt to construct a `SuggestedClientAction` at flush time,
    // so that ordering of the lines inside one entry doesn't matter.
    interface Entry {
        label?: string;
        prompt?: string;
        action?: string;
        path?: string;
    }

    // Split into entries by lines that start with "- label:".
    const lines = body.split(/\r?\n/);
    let current: Entry | null = null;
    /** Tracks which field of `current` was last set, so continuation lines
     * (indented follow-up lines) can be appended to the right field. */
    let lastField: 'prompt' | 'path' | null = null;

    const flush = () => {
        if (current && current.label && current.prompt) {
            const label = current.label.trim();
            const prompt = current.prompt.trim();
            // Format-violation guard: in the structured block the prompt is
            // contractually required to be a full, sendable instruction that
            // differs from the short action label. When the model collapses
            // both into the same string it almost always means it produced a
            // descriptive sentence rather than an actionable suggestion, so we
            // drop the entry entirely. This filter is intentionally limited to
            // the structured path — the heuristic fallback legitimately reuses
            // the same text for label and prompt and must not be affected.
            if (label && prompt && !equalsIgnoreCaseAndSpace(label, prompt)) {
                const clientAction = buildClientAction(current.action, current.path);
                const entry: SuggestedAction = clientAction
                    ? { label, prompt, action: clientAction }
                    : { label, prompt };
                out.push(entry);
            }
        }
        current = null;
        lastField = null;
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        const labelM = /^\s*-\s*label\s*:\s*(.+)$/i.exec(line);
        if (labelM) {
            flush();
            current = { label: (labelM[1] ?? '').trim() };
            lastField = null;
            continue;
        }
        const promptM = /^\s*prompt\s*:\s*(.+)$/i.exec(line);
        if (promptM && current) {
            current.prompt = (promptM[1] ?? '').trim();
            lastField = 'prompt';
            continue;
        }
        const actionM = /^\s*action\s*:\s*(.+)$/i.exec(line);
        if (actionM && current) {
            current.action = (actionM[1] ?? '').trim();
            // `action` is a single token (e.g. "open-note") — never spans
            // multiple lines, so we don't track it for continuation.
            lastField = null;
            continue;
        }
        const pathM = /^\s*path\s*:\s*(.+)$/i.exec(line);
        if (pathM && current) {
            current.path = (pathM[1] ?? '').trim();
            lastField = 'path';
            continue;
        }
        // Allow continuation for prompt / path over multiple indented lines.
        if (current && lastField && /^\s{2,}\S/.test(line)) {
            const cont = line.trim();
            if (lastField === 'prompt' && current.prompt !== undefined) {
                current.prompt = `${current.prompt} ${cont}`;
            } else if (lastField === 'path' && current.path !== undefined) {
                // Paths shouldn't normally span multiple lines, but if the
                // model wraps a long subfolder path we concatenate without
                // inserting a space.
                current.path = `${current.path}${cont}`;
            }
        }
    }
    flush();
    return out;
}

/**
 * Translate the raw `action` / `path` strings parsed from the structured
 * block into a typed `SuggestedClientAction`. Unknown action kinds, or
 * entries missing the data the kind requires, return `undefined` — the
 * caller then falls back to a plain prompt-only suggestion.
 */
function buildClientAction(
    action: string | undefined,
    path: string | undefined,
): SuggestedClientAction | undefined {
    if (!action) return undefined;
    const kind = action.toLowerCase();
    if (kind === 'open-note' || kind === 'open_note' || kind === 'opennote') {
        const p = (path ?? '').trim();
        if (!p) return undefined;
        // Strip wrapping wiki-link / markdown-link decorations the model may
        // accidentally add: [[Foo]], [[Foo|Bar]], "Foo", 'Foo', `Foo`.
        const cleaned = stripPathDecorations(p);
        if (!cleaned) return undefined;
        return { kind: 'open-note', path: cleaned };
    }
    return undefined;
}

function stripPathDecorations(p: string): string {
    let s = p.trim();
    // Wiki-link form: [[Path|Display]], [[Path#heading]], [[Path^block]], or combinations
    const wiki = /^\[\[([^\]]+)\]\]$/.exec(s);
    if (wiki) {
        const inner = wiki[1] ?? '';
        // Drop alias after '|', then strip heading ref (#...) and block ref (^...).
        s = inner.split('|')[0]?.trim() ?? '';
        // Strip heading reference: everything from # onward (but only after the path)
        const hashIdx = s.indexOf('#');
        const caretIdx = s.indexOf('^');
        const cutoff = Math.min(
            hashIdx === -1 ? Infinity : hashIdx,
            caretIdx === -1 ? Infinity : caretIdx
        );
        if (cutoff !== Infinity) {
            s = s.slice(0, cutoff).trim();
        }
    }
    // Strip surrounding quotes / backticks.
    s = s.replace(/^['"`]+|['"`]+$/g, '').trim();
    return s;
}

// ─── Heuristic parsing ─────────────────────────────────────────────────

/** Tail paragraphs of a markdown string (last 1–2 non-empty blocks). */
function tailParagraphs(markdown: string): string[] {
    const paragraphs = markdown
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    if (paragraphs.length === 0) return [];
    // Use at most the last 2 blocks — follow-up offers nearly always live there.
    return paragraphs.slice(-2);
}

function parseHeuristic(markdown: string): SuggestedAction[] {
    // Strip machine-oriented blocks before heuristics — suggestions are
    // never meant to live inside HTML comments or fenced code.
    const cleaned = stripFencedCodeBlocks(stripStructuredBlock(markdown));
    const tail = tailParagraphs(cleaned).join('\n\n');
    if (!tail) return [];

    const lower = tail.toLowerCase();
    const hasHeader = FOLLOWUP_HEADERS.some((h) => lower.includes(h));

    // Extract list items from the tail.
    const items = extractListItems(tail);

    if (items.length > 0 && hasHeader && !isDocumentationList(tail, items)) {
        return items.map((t) => ({ label: t, prompt: t }));
    }

    // Fallback: single-question closer ("要不要我帮你 xxx?") — possibly
    // split into multiple parallel options when the question offers an
    // explicit "A 或者 B" / "A or B" choice. The extractor already returns
    // ready-to-render `{ label, prompt }` pairs (label may keep "帮你" while
    // prompt swaps it to "帮我" — see `buildOfferPair`).
    const closingQs = extractSingleQuestion(tail, lower);
    if (closingQs && closingQs.length > 0) {
        return closingQs;
    }

    // Header-less fallback: colon-intro + list. Require the intro to read as an
    // invitation (see `isInvitingColonListIntro`) so glossaries like
    // "标签说明：" + tag bullets are not mistaken for next-step chips.
    if (items.length >= 2) {
        const intro = tailBeforeList(tail);
        if (
            /[:：]\s*$/.test(intro)
            && isInvitingColonListIntro(intro)
            && !looksLikeDefinitionListItems(items)
        ) {
            return items.map((t) => ({ label: t, prompt: t }));
        }
    }

    return [];
}

/**
 * True when the colon-intro line before a list reads as documentation or
 * encyclopedic summary, not an invitation to pick a next action.
 */
function isDescriptiveListIntro(intro: string): boolean {
    const colonLine = lastNonEmptyLine(intro);
    if (!colonLine || !/[:：]\s*$/.test(colonLine)) return false;
    return DESCRIPTIVE_INTRO_LINE_RES.some((re) => re.test(colonLine));
}

/**
 * True when the text immediately before a list looks like the assistant
 * inviting a next action, not documenting fields/tags/examples.
 */
function isInvitingColonListIntro(intro: string): boolean {
    if (!lastNonEmptyLine(intro) || !/[:：]\s*$/.test(lastNonEmptyLine(intro))) return false;
    if (isDescriptiveListIntro(intro)) return false;
    const lower = intro.toLowerCase();
    return COLON_LIST_INTRO_HINTS.some((h) => lower.includes(h));
}

/**
 * True when the list reads like a glossary / key-points section rather than
 * actionable follow-ups. Used to guard the header-based path where a
 * lead-in such as "接下来…" appears in the same block as encyclopedic bullets.
 */
function isDocumentationList(tail: string, items: string[]): boolean {
    const intro = tailBeforeList(tail);
    if (intro && isDescriptiveListIntro(intro)) return true;
    return looksLikeDefinitionListItems(items);
}

/**
 * Detect bullet items shaped as "topic label：long explanatory body".
 * Requires every item to match so short imperative actions are not dropped.
 */
function looksLikeDefinitionListItems(items: string[]): boolean {
    if (items.length < 2) return false;
    let definitionCount = 0;
    for (const item of items) {
        const plain = item.replace(/\*\*/g, '').trim();
        const match = DEFINITION_LIST_ITEM_RE.exec(plain);
        if (!match) continue;
        const label = (match[1] ?? '').trim();
        const body = (match[2] ?? '').trim();
        if (body.length < DEFINITION_LIST_ITEM_MIN_BODY) continue;
        if (OPTION_LIST_ITEM_LABEL_RE.test(label)) continue;
        if (ACTION_LIST_ITEM_LABEL_RE.test(label)) continue;
        definitionCount++;
    }
    return definitionCount >= 2
        && definitionCount >= Math.ceil(items.length * 0.66);
}

/** Last trimmed non-empty line of a multi-line intro block. */
function lastNonEmptyLine(block: string): string {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    return lines[lines.length - 1] ?? block.trim();
}

/**
 * Extract items from markdown list syntax at the tail:
 *   - xxx / * xxx / 1. xxx / A) xxx / 选项 1: xxx
 * Returns the text part only.
 */
function extractListItems(tail: string): string[] {
    const results: string[] = [];
    const lines = tail.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // bullet list
        let m = /^[-*+•]\s+(.+)$/.exec(line);
        if (m) {
            results.push((m[1] ?? '').trim());
            continue;
        }
        // numbered list: 1. / 1) / 1、 / 一. (skip CJK ordinals for simplicity)
        m = /^(?:\d{1,2})[.)、]\s+(.+)$/.exec(line);
        if (m) {
            results.push((m[1] ?? '').trim());
            continue;
        }
        // A) / A. / Option 1: / 选项 1: / 選項 1:
        m = /^(?:[A-Za-z][.)]|选项\s*\d+[：:]|選項\s*\d+[：:]|option\s*\d+[：:])\s+(.+)$/i.exec(line);
        if (m) {
            results.push((m[1] ?? '').trim());
            continue;
        }
    }
    return results;
}

/** Returns the text immediately before the first list item in `tail`. */
function tailBeforeList(tail: string): string {
    const lines = tail.split(/\r?\n/);
    const buf: string[] = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (/^[-*+•]\s+/.test(line) || /^\d{1,2}[.)、]\s+/.test(line)) break;
        buf.push(raw);
    }
    return buf.join('\n');
}

/**
 * Detect a single-sentence follow-up question at the very end of the reply.
 * Returns the candidate suggestion(s) or null.
 *
 * Each returned entry is a `{ label, prompt }` pair where:
 * - `label` is what the user sees on the chip — kept in the AI's second-
 *   person phrasing ("帮你整理…") so it still reads as the AI's proposal.
 * - `prompt` is what gets sent back to the model on click — rewritten to
 *   first person ("帮我整理…") so the outgoing message reads as the user
 *   accepting / instructing instead of literally echoing the AI's question.
 *
 * Three sub-paths produce that pair:
 *   1. Or-choice split (`需要我 A，或者 B 吗?`) — see `splitOrChoiceQuestion`.
 *      Each parallel option becomes its own suggestion.
 *   2. Single-suggestion with a recognised offer prefix at the start
 *      (`要不要我 / Would you like me to / …`) — the prefix and yes/no tail
 *      are stripped, leaving a chip-friendly action phrase.
 *   3. Whole-sentence fallback — used when no `OFFER_PREFIXES_AT_START`
 *      matches (e.g. Japanese `しましょうか`, Korean `해드릴까요`, or
 *      filler-led variants like `对了，需要我…吗？`). The original sentence
 *      is preserved verbatim for both label and prompt because we cannot
 *      safely identify the action portion to flip the pronouns on.
 *
 * We only treat the last *sentence* (split by `。.!！?？\n`) as the candidate,
 * not the entire trailing paragraph — otherwise a closing remark like
 * "以上就是今天的主要新闻，你想深入了解哪一条？或者需要我帮你整理成新闻笔记吗？"
 * would be lifted wholesale into a button label.
 *
 * We also bail out when the candidate sentence itself contains multiple
 * question marks, which usually signals an open-ended choice question
 * ("A？或者 B？") rather than a clean one-click action.
 */
function extractSingleQuestion(tail: string, _lowerTail: string): SuggestedAction[] | null {
    // Only the last paragraph.
    const paragraphs = tail.split(/\n\s*\n/);
    const last = paragraphs[paragraphs.length - 1]?.trim();
    if (!last) return null;
    // Must end with '?' or '？'.
    if (!/[?？]\s*$/.test(last)) return null;

    // Pick the last sentence only. Split on common sentence terminators
    // (Chinese/Japanese full stop, period, exclamation) but keep '?'/'？'
    // because we need it on the candidate.
    //
    // Implementation note: previously written as `split(/(?<=[。．.!！\n])\s*/)`
    // using a lookbehind so the terminator stayed attached to the left chunk.
    // Lookbehind is unsupported on iOS Safari < 16.4, so we instead match each
    // sentence (run of non-terminator chars + an optional trailing terminator)
    // — plus a fallback branch that matches an isolated terminator (e.g. a
    // bare '\n' between sentences). Whitespace-only / empty pieces are then
    // filtered out, yielding the same result as the original split.
    const sentences = (last.match(/[^。．.!！\n]+[。．.!！\n]?|[。．.!！\n]/g) ?? [])
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    const candidate = sentences[sentences.length - 1] ?? last;

    // Reject ambiguous multi-question closers like "A？或者 B？".
    const qmarkCount = (candidate.match(/[?？]/g) ?? []).length;
    if (qmarkCount !== 1) return null;

    const lowerCandidate = candidate.toLowerCase();
    if (!SINGLE_QUESTION_HINTS.some((h) => lowerCandidate.includes(h))) return null;

    // Collapse to a single line.
    const oneLine = candidate.replace(/\s+/g, ' ').trim();
    // Don't treat very long sentences as one-click actions.
    if (oneLine.length > 80) return null;

    // Try splitting a parallel "A 或者 B 吗?" / "A or B?" offer into two
    // independent actions. Falls back to the single-suggestion path when
    // the pattern doesn't apply.
    const split = splitOrChoiceQuestion(oneLine);
    if (split) return split;

    // Single-suggestion path: when we can recognise the offer prefix at the
    // start, strip it (and the trailing yes/no marker) so the chip is an
    // action label, not a question echo. When no prefix is recognised
    // (Japanese sentence-final hints, or filler-led variants) we fall back
    // to the original whole-sentence behaviour so the user still sees the
    // proposal verbatim.
    const lowerOne = oneLine.toLowerCase();
    const prefix = OFFER_PREFIXES_AT_START.find((p) => lowerOne.startsWith(p));
    if (prefix) {
        const rest = oneLine.slice(prefix.length).trimStart();
        const pair = buildOfferPair(rest);
        if (pair.label.length >= 2) return [pair];
    }

    return [{ label: oneLine, prompt: oneLine }];
}

/**
 * Try to break a closing offer like "需要我 A，或者 B 吗?" into parallel
 * option chips. Returns `null` when the pattern doesn't apply so the
 * caller can fall back to the single-suggestion path.
 *
 * Strategy:
 *   1. The candidate must start with an offer prefix that sits at the
 *      *front* of the sentence (e.g. `需要我`, `Should I`). Sentence-final
 *      markers (`しましょうか`, `해드릴까요`) deliberately don't qualify.
 *   2. Strip that prefix, then split the remainder on an "or"-style
 *      connector (`或者 / 或是 / 还是 / 還是 / " or "`).
 *   3. Feed each piece to `buildOfferPair` so the chip label keeps the
 *      AI-facing "帮你 …" phrasing while the outgoing prompt is rewritten
 *      to first person ("帮我 …"). The yes/no tail is stripped as part of
 *      that helper.
 *
 * Returning ≥ 2 cleaned pieces is required; otherwise the split is
 * considered spurious and we bail out.
 */
function splitOrChoiceQuestion(candidate: string): SuggestedAction[] | null {
    const lower = candidate.toLowerCase();
    const prefix = OFFER_PREFIXES_AT_START.find((p) => lower.startsWith(p));
    if (!prefix) return null;

    // Slice the same length from the *original* candidate so case is
    // preserved for the remainder (matters for English options).
    const rest = candidate.slice(prefix.length).trimStart();
    const parts = rest
        .split(OR_CHOICE_SEPARATORS)
        .map((s) => buildOfferPair(s))
        .filter((p) => p.label.length >= 2);
    if (parts.length < 2) return null;

    return parts;
}

/**
 * Build a chip-ready `{ label, prompt }` pair from the *action portion* of a
 * follow-up offer.
 *
 * The caller must have already identified that the surrounding sentence
 * matches the "<offer prefix> <action> [yes/no marker]" template (via
 * `OFFER_PREFIXES_AT_START`) and stripped the prefix. That template is what
 * guarantees any 2nd-person reference inside `phrase` refers to the user, so
 * the pronoun swap performed here is safe.
 *
 * - `label` keeps the original 2nd-person phrasing — the chip should still
 *   read as the AI proposing something to the user ("帮你整理…").
 * - `prompt` swaps 2nd person to 1st person ("帮我整理…") so the message
 *   sent back to the model reads as the user accepting / instructing,
 *   instead of a literal echo of the AI's question.
 * - Trailing yes/no markers (`吗?/呢?/?` and friends) are stripped from
 *   both because they don't belong on a button label or on an outgoing
 *   instruction.
 *
 * Not used by the list-based heuristic path: list items may themselves be
 * *questions the user might ask the AI* ("- 你的看法是什么？") in which case
 * "你" refers to the AI and swapping would be wrong. The list path keeps
 * `label === prompt` unchanged.
 */
function buildOfferPair(phrase: string): { label: string; prompt: string } {
    const cleaned = stripYesNoTail(phrase);
    return {
        label: cleaned,
        prompt: swapToFirstPerson(cleaned),
    };
}

/**
 * Swap 2nd-person references to 1st person inside an offer action phrase.
 *
 * Scope: applied only to phrases already confirmed to be the *action portion*
 * of an AI-to-user offer template (see `buildOfferPair`). Doing it elsewhere
 * is unsafe because outside that template "你/you" may legitimately refer to
 * the AI.
 *
 * Languages handled:
 * - zh: 你/您 → 我. The negative lookahead on `好` is a cheap safety net for
 *   the (vanishingly unlikely) case where 你好/您好 ends up inside an action
 *   phrase — we'd rather keep the greeting verbatim than turn it into 我好.
 * - en: word-boundary swaps for the object-form pronouns that remain after
 *   stripping an offer prefix ("help you …" → "help me …", "your code" →
 *   "my code"). Case-insensitive with lower-case replacement; the cleaned
 *   phrase is short and rarely sentence-initial after prefix stripping.
 *
 * Japanese / Korean offers don't typically embed a 2nd-person subject in the
 * action portion (the verb-final politeness form `しましょうか / 해드릴까요`
 * sits at the end of the sentence and would not match `OFFER_PREFIXES_AT_START`
 * anyway), so no rule is needed for those languages here.
 */
function swapToFirstPerson(s: string): string {
    return s
        .replace(/[你您](?!好)/g, '我')
        .replace(/\byou\b/gi, 'me')
        .replace(/\byour\b/gi, 'my');
}

/**
 * Strip trailing yes-no markers and stray punctuation that an offer
 * sentence accumulates near its tail. Applied iteratively because the
 * suffix often layers (e.g. "整理内容吗?" → "整理内容吗" → "整理内容").
 *
 * The bounded loop (3 passes max) is purely defensive — in practice two
 * passes are enough — and avoids any pathological repetition.
 */
function stripYesNoTail(s: string): string {
    let out = s.trim();
    for (let i = 0; i < 3 && out.length > 0; i++) {
        const next = out
            .replace(/[?？]+\s*$/, '')
            .replace(/(吗|嗎|呢|呀|啊)\s*$/u, '')
            .replace(/[,，、.。]\s*$/, '')
            .trim();
        if (next === out) break;
        out = next;
    }
    return out;
}

// ─── Normalization ─────────────────────────────────────────────────────

function normalize(
    actions: SuggestedAction[],
    limit: number,
    labelMax: number,
): SuggestedAction[] {
    const seen = new Set<string>();
    const out: SuggestedAction[] = [];
    for (const raw of actions) {
        const prompt = cleanupText(raw.prompt);
        // The button label is rendered as plain text in the UI, so strip any
        // markdown/HTML formatting the model may have emitted (e.g. `**bold**`,
        // `` `code` ``, `[text](url)`, wiki-links, heading markers). The
        // underlying `prompt` is left untouched because it is fed back to the
        // model where markdown may still be meaningful.
        const labelSource = raw.label || raw.prompt;
        const label = truncate(cleanupText(stripMarkdownToPlainText(labelSource)), labelMax);
        if (label.length < 2) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Preserve the optional client action verbatim — its payload is
        // structured data (e.g. a path) that must not be touched by the
        // text-cleanup pipeline above.
        const entry: SuggestedAction = raw.action
            ? { label, prompt, action: raw.action }
            : { label, prompt };
        out.push(entry);
        if (out.length >= limit) break;
    }
    return out;
}

function cleanupText(s: string): string {
    return s
        .replace(/^[*_`]+|[*_`]+$/g, '') // strip surrounding markdown emphasis
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Compare two strings ignoring case and whitespace differences. Used by the
 * structured-block parser to detect entries where the model emitted the same
 * text for both `label` and `prompt`.
 */
function equalsIgnoreCaseAndSpace(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    return norm(a) === norm(b);
}
