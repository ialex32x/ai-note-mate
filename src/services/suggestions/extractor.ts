import { FOLLOWUP_HEADERS, SINGLE_QUESTION_HINTS } from './triggers';
import type { ExtractOptions, SuggestedAction } from './types';
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

    // Split into entries by lines that start with "- label:".
    const lines = body.split(/\r?\n/);
    let current: Partial<SuggestedAction> | null = null;

    const flush = () => {
        if (current && current.label && current.prompt) {
            out.push({ label: current.label.trim(), prompt: current.prompt.trim() });
        }
        current = null;
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        const labelM = /^\s*-\s*label\s*:\s*(.+)$/i.exec(line);
        if (labelM) {
            flush();
            current = { label: (labelM[1] ?? '').trim() };
            continue;
        }
        const promptM = /^\s*prompt\s*:\s*(.+)$/i.exec(line);
        if (promptM && current) {
            current.prompt = (promptM[1] ?? '').trim();
            continue;
        }
        // Allow continuation for prompt over multiple indented lines.
        if (current && current.prompt !== undefined && /^\s{2,}\S/.test(line)) {
            current.prompt = `${current.prompt} ${line.trim()}`;
        }
    }
    flush();
    return out;
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
    // Always strip the structured block to avoid double-matching it in heuristic mode.
    const cleaned = stripStructuredBlock(markdown);
    const tail = tailParagraphs(cleaned).join('\n\n');
    if (!tail) return [];

    const lower = tail.toLowerCase();
    const hasHeader = FOLLOWUP_HEADERS.some((h) => lower.includes(h));

    // Extract list items from the tail.
    const items = extractListItems(tail);

    if (items.length > 0 && hasHeader) {
        return items.map((t) => ({ label: t, prompt: t }));
    }

    // Fallback: single-question closer ("要不要我帮你 xxx?"). Return 1 entry.
    const singleQ = extractSingleQuestion(tail, lower);
    if (singleQ) return [{ label: singleQ, prompt: singleQ }];

    // Even without an explicit header, if the last paragraph is a short
    // numbered list right after a colon, treat them as suggestions.
    if (items.length >= 2 && /[:：]\s*$/.test(tailBeforeList(tail))) {
        return items.map((t) => ({ label: t, prompt: t }));
    }

    return [];
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
        m = /^(?:\d{1,2})[.\)、]\s+(.+)$/.exec(line);
        if (m) {
            results.push((m[1] ?? '').trim());
            continue;
        }
        // A) / A. / Option 1: / 选项 1: / 選項 1:
        m = /^(?:[A-Za-z][.\)]|选项\s*\d+[：:]|選項\s*\d+[：:]|option\s*\d+[：:])\s+(.+)$/i.exec(line);
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
        if (/^[-*+•]\s+/.test(line) || /^\d{1,2}[.\)、]\s+/.test(line)) break;
        buf.push(raw);
    }
    return buf.join('\n');
}

/**
 * Detect a single-sentence follow-up question at the very end of the reply.
 * Returns the question (stripped of trailing punctuation) or null.
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
function extractSingleQuestion(tail: string, _lowerTail: string): string | null {
    // Only the last paragraph.
    const paragraphs = tail.split(/\n\s*\n/);
    const last = paragraphs[paragraphs.length - 1]?.trim();
    if (!last) return null;
    // Must end with '?' or '？'.
    if (!/[?？]\s*$/.test(last)) return null;

    // Pick the last sentence only. Split on common sentence terminators
    // (Chinese/Japanese full stop, period, exclamation) but keep '?'/'？'
    // because we need it on the candidate.
    const sentences = last
        .split(/(?<=[。．\.!！\n])\s*/)
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
    return oneLine;
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
        out.push({ label, prompt });
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
