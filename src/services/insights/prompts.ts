/**
 * Prompts used by the insight extractor.
 *
 * We ask the (cheap) summarizer model to emit a strict JSON array so
 * parsing stays deterministic. A fenced code block is tolerated but
 * not required.
 */

/**
 * Base system prompt. The `{limit}` placeholder is replaced by the caller;
 * the `{tagSection}` placeholder receives either an empty string (free-form
 * tagging) or a "vocabulary-constrained" instruction block produced by
 * {@link buildRestrictedTagSection}.
 *
 * Output language is left implicit — the model is told to match the user's
 * message language and otherwise decide for itself, so the extractor does
 * not have to thread a language policy through its call sites.
 */
export const INSIGHT_EXTRACTION_SYSTEM_PROMPT = `\
You extract small, reusable knowledge nuggets ("insights") from a single Q&A turn between a user and an AI assistant inside a personal notes app.

Return ONLY a JSON array (optionally wrapped in a \`\`\`json code fence). No prose, no explanations, no trailing text.

Each array entry MUST be an object with these fields:
- "title":       string — concise concept name, <= 30 chars, no trailing punctuation.
- "summary":     string — 1-2 short sentences capturing the nugget in the SAME language as the user's message.
- "tags":        string[] — 0-5 tag keywords, no "#" prefix.{tagSection}
- "linkedNotes": string[] — 0-5 note titles (bare, no brackets) that the assistant reply explicitly cited via [[wiki-links]] or equivalent. NEVER invent titles.

Selection rules:
- Only extract insights that are self-contained and would still make sense as a standalone note a week later.
- Do NOT extract greetings, meta-commentary, apologies, or clarification questions.
- Do NOT extract items that merely restate the user's question.
- Prefer definitions, design decisions, comparisons, trade-offs, step-by-step procedures, named concepts, or concrete gotchas.
- Return an empty array "[]" when no worthy insight exists. Being silent is better than being noisy.
- Emit AT MOST {limit} entries, ordered by descending usefulness.

Language: match the user's message language for "title" and "summary".
`;

/**
 * Build the tag-restriction clause injected into the system prompt when a
 * vault-tag vocabulary is available. Kept as a plain function (not a
 * template constant) so the caller can truncate / slice the vocabulary
 * before it lands in the prompt.
 */
export function buildRestrictedTagSection(tags: ReadonlyArray<string>): string {
    if (tags.length === 0) return '';
    // Deduplicate defensively and cap the rendered list length; we quote
    // each tag to keep word boundaries clear for the model and to make
    // parsing failures obvious during development.
    const seen = new Set<string>();
    const quoted: string[] = [];
    for (const raw of tags) {
        const t = raw.trim();
        if (!t) continue;
        const key = t.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        quoted.push(`"${t}"`);
    }
    if (quoted.length === 0) return '';
    return [
        '',
        '',
        'TAG VOCABULARY — pick "tags" values EXCLUSIVELY from the following list of tags that already exist in the user\'s vault. Reproduce them verbatim (same casing, same nesting with "/", no "#"). If no tag from the list fits the insight, leave "tags" as an empty array []. Do NOT invent new tags.',
        'Allowed tags: ' + quoted.join(', ') + '.',
    ].join('\n');
}

/** Free-form fallback when no vault vocabulary is provided. */
export const FREEFORM_TAG_SECTION =
    ' Use 0-5 short lowercase keywords, no spaces (use "-" instead). Keep them ASCII/CJK as appropriate.';

/** Build the user-role message fed to the extractor. */
export function buildInsightUserPrompt(userMessage: string, assistantMessage: string): string {
    return [
        'USER MESSAGE:',
        '"""',
        userMessage.trim(),
        '"""',
        '',
        'ASSISTANT REPLY:',
        '"""',
        assistantMessage.trim(),
        '"""',
        '',
        'Extract the insights now. Reply with JSON array only.',
    ].join('\n');
}

/**
 * Compose the user-facing message that is sent on the user's behalf when
 * they click the "Deepen" button on an insight item. The message is sent
 * as a normal user turn (so the model can call tools, stream, etc.) — it
 * therefore needs to read naturally as if the user typed it.
 *
 * Per project decision the prompt body is always English regardless of
 * UI locale; the closing instruction tells the model to reply in the
 * conversation's language so the resulting note matches what the user
 * sees on screen.
 */
export function buildInsightDeepenPrompt(input: {
    title: string;
    summary: string;
    tags: string[];
    linkedNotes: string[];
}): string {
    const lines: string[] = [
        'Please go deeper on the following insight from our conversation and turn it into a more complete, self-contained piece that I could save as a standalone note.',
        '',
        `- Title: ${input.title}`,
        `- Summary: ${input.summary}`,
    ];
    if (input.tags.length > 0) {
        lines.push(`- Tags: ${input.tags.join(', ')}`);
    }
    if (input.linkedNotes.length > 0) {
        lines.push(`- Related notes: ${input.linkedNotes.map((n) => `[[${n}]]`).join(', ')}`);
    }
    lines.push(
        '',
        'When useful, call tools to gather additional context (e.g. search the vault, read related notes, fetch external references). Then synthesize the findings.',
        '',
        'In your final reply, cover:',
        '- Background and why this matters',
        '- Key details, definitions, and any important nuances or trade-offs',
        '- Concrete examples or step-by-step guidance where applicable',
        '- Common pitfalls or caveats to watch out for',
        '- References / sources you consulted (if any)',
        '',
        'Reply in the same language as the rest of this conversation. Aim for a polished, note-ready piece — not a brief follow-up answer.',
    );
    return lines.join('\n');
}
